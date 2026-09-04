import { eq } from "drizzle-orm";
import { slipEvidenceBindings } from "../../drizzle/schema";
import * as db from "../db";
import { isLegacyScanRequired } from "./slipBackfillStateService";

export const SLIP_EVIDENCE_CLASSES = [
  "modern_immutable",
  "legacy_migrated_immutable",
  "legacy_compatibility_required",
] as const;

export type SlipEvidenceClass = (typeof SLIP_EVIDENCE_CLASSES)[number];
export type ApprovalEvidenceSourceType = "order_payment" | "wallet_topup";

export interface ApprovalEvidenceSnapshot {
  sourceType: ApprovalEvidenceSourceType;
  sourceId: number;
  ownerUserId: number;
  status: string;
  slipImageUrl: string | null;
  slipSubmittedAt: Date | null;
  evidenceVersion: number;
  slipEvidenceClass: string;
  slipEvidenceId: number | null;
  extractedEvidenceVersion: number | null;
  extractedData?: string | null;
}

export interface ImmutableEvidenceProof {
  id: number;
  sourceType: string;
  sourceId: number;
  ownerUserId: number;
  evidenceVersion: number;
  evidenceClass: string;
  objectIdentity: string;
  fileHash: string;
}

export type EvidenceEligibilityReason =
  | "READY"
  | "LEGACY_EVIDENCE_REQUIRES_COMPATIBILITY"
  | "EVIDENCE_STATE_INCONSISTENT";

export interface EvidenceEligibility {
  classification: SlipEvidenceClass;
  eligible: boolean;
  reason: EvidenceEligibilityReason;
  evidenceVersion: number;
}

function persistedFileHash(extractedData: string | null | undefined): string | null {
  if (!extractedData) return null;
  try {
    const parsed = JSON.parse(extractedData);
    return typeof parsed?.fileHash === "string" && /^[a-f0-9]{64}$/.test(parsed.fileHash)
      ? parsed.fileHash
      : null;
  } catch {
    return null;
  }
}

/**
 * Pure fail-closed classifier used by future V2 PREPARE code. The persisted
 * class is never trusted alone: every immutable field must agree with the
 * append-only binding and with the extraction version/hash.
 */
export function classifySlipEvidence(
  subject: ApprovalEvidenceSnapshot,
  binding: ImmutableEvidenceProof | null
): EvidenceEligibility {
  const rawClass = subject.slipEvidenceClass;
  const classification = SLIP_EVIDENCE_CLASSES.includes(rawClass as SlipEvidenceClass)
    ? (rawClass as SlipEvidenceClass)
    : "legacy_compatibility_required";
  const versionValid = Number.isSafeInteger(subject.evidenceVersion) && subject.evidenceVersion >= 0;

  if (rawClass !== classification || !versionValid) {
    return { classification, eligible: false, reason: "EVIDENCE_STATE_INCONSISTENT", evidenceVersion: subject.evidenceVersion };
  }

  if (classification === "legacy_compatibility_required") {
    const structurallyLegacy = subject.slipEvidenceId == null && binding == null;
    return {
      classification,
      eligible: false,
      reason: structurallyLegacy
        ? "LEGACY_EVIDENCE_REQUIRES_COMPATIBILITY"
        : "EVIDENCE_STATE_INCONSISTENT",
      evidenceVersion: subject.evidenceVersion,
    };
  }

  const fileHash = persistedFileHash(subject.extractedData);
  const consistent =
    subject.evidenceVersion >= 1 &&
    subject.slipEvidenceId != null &&
    binding != null &&
    binding.id === subject.slipEvidenceId &&
    binding.sourceType === subject.sourceType &&
    binding.sourceId === subject.sourceId &&
    binding.ownerUserId === subject.ownerUserId &&
    binding.evidenceVersion === subject.evidenceVersion &&
    binding.evidenceClass === classification &&
    binding.objectIdentity === subject.slipImageUrl &&
    subject.extractedEvidenceVersion === subject.evidenceVersion &&
    fileHash !== null &&
    binding.fileHash === fileHash;

  return {
    classification,
    eligible: consistent,
    reason: consistent ? "READY" : "EVIDENCE_STATE_INCONSISTENT",
    evidenceVersion: subject.evidenceVersion,
  };
}

export type V2ReadinessReason =
  | "READY"
  | "SUBJECT_NOT_REVIEWABLE"
  | "TRUSTED_ANTI_REPLAY_NOT_READY"
  | Exclude<EvidenceEligibilityReason, "READY">;

export interface V2ApprovalReadiness extends Omit<EvidenceEligibility, "reason"> {
  ready: boolean;
  reason: V2ReadinessReason;
  trustedAntiReplayReady: boolean;
}

export async function evaluateV2ApprovalReadiness(
  subject: ApprovalEvidenceSnapshot,
  binding: ImmutableEvidenceProof | null,
  legacyScanRequired: boolean
): Promise<V2ApprovalReadiness> {
  const evidence = classifySlipEvidence(subject, binding);
  const reviewable = subject.status === "pending" || subject.status === "pending_review";
  const trustedAntiReplayReady = !legacyScanRequired;
  const reason: V2ReadinessReason = !reviewable
    ? "SUBJECT_NOT_REVIEWABLE"
    : !trustedAntiReplayReady
      ? "TRUSTED_ANTI_REPLAY_NOT_READY"
      : evidence.eligible
        ? "READY"
        : evidence.reason;
  return { ...evidence, ready: reason === "READY", reason, trustedAntiReplayReady };
}

/** Exact stale-snapshot contract for a later V2 COMMIT implementation. */
export function isPreparedEvidenceSnapshotCurrent(
  prepared: ApprovalEvidenceSnapshot,
  current: ApprovalEvidenceSnapshot
): boolean {
  return (
    prepared.sourceType === current.sourceType &&
    prepared.sourceId === current.sourceId &&
    prepared.ownerUserId === current.ownerUserId &&
    prepared.slipImageUrl === current.slipImageUrl &&
    (prepared.slipSubmittedAt?.getTime() ?? null) === (current.slipSubmittedAt?.getTime() ?? null) &&
    prepared.evidenceVersion === current.evidenceVersion &&
    prepared.slipEvidenceClass === current.slipEvidenceClass &&
    prepared.slipEvidenceId === current.slipEvidenceId &&
    prepared.extractedEvidenceVersion === current.extractedEvidenceVersion
  );
}

export async function getV2ApprovalReadiness(
  sourceType: ApprovalEvidenceSourceType,
  sourceId: number
): Promise<V2ApprovalReadiness> {
  const subject = sourceType === "order_payment"
    ? await db.getPaymentById(sourceId)
    : await db.getWalletTopupById(sourceId);
  if (!subject) throw new Error(`${sourceType} ${sourceId} not found`);

  const ownerUserId = sourceType === "order_payment"
    ? (await db.getOrderById((subject as any).orderId))?.userId
    : (subject as any).userId;
  if (!ownerUserId) throw new Error(`${sourceType} ${sourceId} owner not found`);

  const database = await db.getDb();
  if (!database) throw new Error("Database not available");
  const evidenceId = (subject as any).slipEvidenceId as number | null;
  const binding = evidenceId == null
    ? null
    : ((await database
        .select()
        .from(slipEvidenceBindings)
        .where(eq(slipEvidenceBindings.id, evidenceId))
        .limit(1))[0] ?? null);

  const snapshot: ApprovalEvidenceSnapshot = {
    sourceType,
    sourceId,
    ownerUserId,
    status: String((subject as any).status),
    slipImageUrl: (subject as any).slipImageUrl ?? null,
    slipSubmittedAt: (subject as any).slipSubmittedAt ?? null,
    evidenceVersion: Number((subject as any).evidenceVersion ?? 0),
    slipEvidenceClass: String((subject as any).slipEvidenceClass ?? ""),
    slipEvidenceId: evidenceId,
    extractedEvidenceVersion: (subject as any).extractedEvidenceVersion == null
      ? null
      : Number((subject as any).extractedEvidenceVersion),
    extractedData: (subject as any).extractedData ?? null,
  };

  return evaluateV2ApprovalReadiness(snapshot, binding as ImmutableEvidenceProof | null, await isLegacyScanRequired());
}
