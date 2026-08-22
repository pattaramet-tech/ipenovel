/**
 * OCR attempt history persistence.
 *
 * Records one row per OCR run (automatic submission or admin recheck) so an
 * admin can see the sequence of what was tried and why it stopped, instead
 * of only the latest opaque state.
 *
 * ── What must NEVER be written here ───────────────────────────────────────
 * API keys, Authorization headers, LLM endpoint URLs, signed R2 URLs, base64
 * image data, raw upstream error bodies, or any credential. The column set
 * makes most of these impossible by construction; `sanitizeSnapshot` below
 * is the backstop for the one free-form field.
 *
 * Raw OCR text is deliberately NOT stored per attempt: payments.extractedData
 * already holds the extracted financial evidence, and duplicating PII-bearing
 * slip text once per attempt would multiply the sensitive footprint for no
 * diagnostic benefit.
 *
 * Failure to record history must never break a payment flow - diagnostics are
 * strictly secondary to money correctness - so writes here are best-effort
 * and swallow their own errors.
 */

import { getDb } from "../db";
import { ocrVerificationAttempts } from "../../drizzle/schema";
import { and, desc, eq } from "drizzle-orm";

export type OcrAttemptSubjectType = "order_payment" | "wallet_topup";
export type OcrAttemptTrigger = "automatic" | "admin_recheck";
export type OcrAttemptStage =
  | "image_preparation"
  | "provider_call"
  | "response_parse"
  | "field_extraction"
  | "verification"
  | "completed";
export type OcrAttemptResult =
  | "auto_approved"
  | "needs_review"
  | "technical_failure"
  | "config_blocked";

export interface RecordOcrAttemptInput {
  subjectType: OcrAttemptSubjectType;
  subjectId: number;
  trigger: OcrAttemptTrigger;
  initiatedByUserId?: number | null;
  startedAt: Date;
  stage: OcrAttemptStage;
  result: OcrAttemptResult;
  reviewCategory?: string | null;
  reviewReason?: string | null;
  /** null means "not reported" - deliberately distinct from 0. */
  confidence?: number | null;
  providerMode?: string | null;
  providerModel?: string | null;
  providerHttpStatus?: number | null;
  providerAttemptCount?: number;
  verificationSnapshot?: string | null;
}

/**
 * Keys that must never appear in the free-form snapshot, whatever a future
 * caller passes. Matched case-insensitively against the JSON's own keys.
 */
const FORBIDDEN_SNAPSHOT_KEYS =
  /(apikey|api_key|authorization|bearer|token|secret|password|credential|endpoint|signedurl|signed_url|imageurl|image_url|slipimageurl|base64|rawtext|raw_text|dataurl|data_url)/i;

/**
 * Strips forbidden keys and anything that looks like a URL or a data: blob.
 * Returns null on malformed input rather than storing something unvetted.
 */
export function sanitizeSnapshot(snapshot: string | null | undefined): string | null {
  if (!snapshot) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.test(key)) continue;
    if (typeof value === "string") {
      // Never persist a URL or an inline blob, whatever the key is called.
      if (/^(https?:|r2p:|data:)/i.test(value)) continue;
      if (value.length > 256) continue;
    }
    if (typeof value === "object" && value !== null) continue; // flat only
    clean[key] = value;
  }

  return JSON.stringify(clean);
}

/**
 * Next attempt number for a subject. Advisory only - a duplicate number
 * under concurrency is harmless for a diagnostic log, so this deliberately
 * avoids taking a lock on the payment path.
 */
async function nextAttemptNo(
  tx: any,
  subjectType: OcrAttemptSubjectType,
  subjectId: number
): Promise<number> {
  const rows = await tx
    .select({ attemptNo: ocrVerificationAttempts.attemptNo })
    .from(ocrVerificationAttempts)
    .where(
      and(
        eq(ocrVerificationAttempts.subjectType, subjectType),
        eq(ocrVerificationAttempts.subjectId, subjectId)
      )
    )
    .orderBy(desc(ocrVerificationAttempts.attemptNo))
    .limit(1);

  return (rows?.[0]?.attemptNo ?? 0) + 1;
}

/**
 * Appends an attempt row. Returns the attempt number, or 0 when the write
 * could not be performed (no database, or a logging failure) - callers treat
 * that as "history unavailable", never as a payment failure.
 */
export async function recordOcrAttempt(input: RecordOcrAttemptInput): Promise<number> {
  try {
    const database = await getDb();
    if (!database) return 0;

    const attemptNo = await nextAttemptNo(database, input.subjectType, input.subjectId);

    await database.insert(ocrVerificationAttempts).values({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      attemptNo,
      trigger: input.trigger,
      initiatedByUserId: input.initiatedByUserId ?? null,
      startedAt: input.startedAt,
      completedAt: new Date(),
      providerMode: input.providerMode ?? null,
      providerModel: input.providerModel ?? null,
      providerHttpStatus: input.providerHttpStatus ?? null,
      providerAttemptCount: input.providerAttemptCount ?? 0,
      stage: input.stage,
      result: input.result,
      reviewCategory: input.reviewCategory ?? null,
      reviewReason: input.reviewReason ?? null,
      confidence: input.confidence ?? null,
      verificationSnapshot: sanitizeSnapshot(input.verificationSnapshot),
    });

    return attemptNo;
  } catch (error) {
    // Diagnostics must never take down a payment flow.
    console.warn(
      `[OCR] failed to record attempt history for ${input.subjectType}#${input.subjectId}`,
      error instanceof Error ? error.message : String(error)
    );
    return 0;
  }
}

export interface OcrAttemptSummary {
  attemptNo: number;
  trigger: OcrAttemptTrigger;
  startedAt: Date;
  completedAt: Date | null;
  stage: string;
  result: string;
  reviewCategory: string | null;
  reviewReason: string | null;
  confidence: number | null;
  providerHttpStatus: number | null;
  providerAttemptCount: number;
}

/** Attempt history for the admin panel, newest first. */
export async function getOcrAttemptHistory(
  subjectType: OcrAttemptSubjectType,
  subjectId: number,
  limit = 20
): Promise<OcrAttemptSummary[]> {
  try {
    const database = await getDb();
    if (!database) return [];

    const rows = await database
      .select()
      .from(ocrVerificationAttempts)
      .where(
        and(
          eq(ocrVerificationAttempts.subjectType, subjectType),
          eq(ocrVerificationAttempts.subjectId, subjectId)
        )
      )
      .orderBy(desc(ocrVerificationAttempts.attemptNo))
      .limit(limit);

    return (rows ?? []).map((r: any) => ({
      attemptNo: r.attemptNo,
      trigger: r.trigger,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      stage: r.stage,
      result: r.result,
      reviewCategory: r.reviewCategory,
      reviewReason: r.reviewReason,
      confidence: r.confidence,
      providerHttpStatus: r.providerHttpStatus,
      providerAttemptCount: r.providerAttemptCount,
    }));
  } catch {
    // History is a nice-to-have; never surface a diagnostics read failure.
    return [];
  }
}
