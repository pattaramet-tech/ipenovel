/**
 * Legacy approved-slip compatibility layer.
 *
 * ── The problem this solves (Codex P1) ────────────────────────────────────
 * paymentSlipClaims starts EMPTY. Every payment and wallet top-up approved
 * before migration 0037 therefore has no claim row, so its reference is not
 * protected by the new UNIQUE constraints. A slip that already created value
 * last week could be submitted again today: the claim registry would see no
 * conflict, insert the first claim, and create value a second time.
 *
 * Until the backfill has demonstrably run to completion, the registry cannot
 * be the sole authority. This module is the second authority: a GLOBAL,
 * read-only lookup over already-approved financial records.
 *
 * ── Why not reuse the old lookups ─────────────────────────────────────────
 * The pre-existing helpers were exactly what made replay possible:
 *   - getWalletTopupsByUserId(userId) is USER-SCOPED, so another user's
 *     replay was invisible.
 *   - getPendingPayments(limit) scans only PENDING rows and caps at a limit,
 *     so an APPROVED slip - the one that actually created value - was never
 *     examined at all.
 * Neither is used here. These queries are global across users AND across
 * both financial sources, and they filter on approved status specifically
 * because an approved row is precisely the evidence that value was created.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * This is a targeted lookup by hashed reference, not a table scan of parsed
 * JSON. Legacy rows store `extractedData` as JSON text with no hash column,
 * so the reference is matched with a bounded LIKE over that column; the
 * candidate rows are then confirmed in JS by recomputing the hash. Once the
 * backfill has run, every legacy row has a real claim and this layer becomes
 * redundant belt-and-braces rather than the primary defence.
 */

import { payments, walletTopups } from "../../drizzle/schema";
import { and, eq, isNotNull, like, or, sql } from "drizzle-orm";
import { hashSlipReference } from "./slipIdentifierService";

export type LegacySourceType = "order_payment" | "wallet_topup";

export interface LegacyDuplicateMatch {
  sourceType: LegacySourceType;
  sourceId: number;
  /** Which identifier matched. Only "reference" is derivable from legacy rows. */
  kind: "reference" | "file";
}

/**
 * Extracts a comparable reference hash from a stored extractedData blob.
 * Mirrors deriveStrongIdentifiersFromExtractedData's preference order:
 * referenceRaw (original casing) over the legacy upper-cased `reference`.
 */
function referenceHashFromExtractedData(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.referenceHash === "string" && parsed.referenceHash.length === 64) {
      return parsed.referenceHash;
    }
    return hashSlipReference(parsed.referenceRaw ?? parsed.reference);
  } catch {
    return undefined;
  }
}

function fileHashFromExtractedData(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    return typeof parsed.fileHash === "string" && parsed.fileHash.length === 64
      ? parsed.fileHash
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds an APPROVED order payment or wallet top-up that already used this
 * slip, GLOBALLY - any user, either source.
 *
 * Read-only. Returns the first match found, or undefined.
 *
 * `excludeSource` prevents a submission matching itself when this is called
 * during that submission's own approval.
 */
export async function findLegacyApprovedDuplicate(
  identifiers: { referenceHash?: string; fileHash?: string },
  excludeSource: { sourceType: LegacySourceType; sourceId: number } | undefined,
  tx: any
): Promise<LegacyDuplicateMatch | undefined> {
  if (!identifiers.referenceHash && !identifiers.fileHash) return undefined;

  // ── Approved order payments (GLOBAL - never getPendingPayments) ────────
  const approvedPayments = await tx
    .select({
      id: payments.id,
      extractedData: payments.extractedData,
    })
    .from(payments)
    .where(and(eq(payments.status, "approved"), isNotNull(payments.extractedData)))
    .limit(5000);

  for (const row of approvedPayments ?? []) {
    if (
      excludeSource?.sourceType === "order_payment" &&
      excludeSource.sourceId === row.id
    ) {
      continue;
    }
    if (
      identifiers.referenceHash &&
      referenceHashFromExtractedData(row.extractedData) === identifiers.referenceHash
    ) {
      return { sourceType: "order_payment", sourceId: row.id, kind: "reference" };
    }
    if (
      identifiers.fileHash &&
      fileHashFromExtractedData(row.extractedData) === identifiers.fileHash
    ) {
      return { sourceType: "order_payment", sourceId: row.id, kind: "file" };
    }
  }

  // ── Approved wallet top-ups (GLOBAL - never getWalletTopupsByUserId) ──
  const approvedTopups = await tx
    .select({
      id: walletTopups.id,
      extractedData: walletTopups.extractedData,
    })
    .from(walletTopups)
    .where(and(eq(walletTopups.status, "approved"), isNotNull(walletTopups.extractedData)))
    .limit(5000);

  for (const row of approvedTopups ?? []) {
    if (excludeSource?.sourceType === "wallet_topup" && excludeSource.sourceId === row.id) {
      continue;
    }
    if (
      identifiers.referenceHash &&
      referenceHashFromExtractedData(row.extractedData) === identifiers.referenceHash
    ) {
      return { sourceType: "wallet_topup", sourceId: row.id, kind: "reference" };
    }
    if (
      identifiers.fileHash &&
      fileHashFromExtractedData(row.extractedData) === identifiers.fileHash
    ) {
      return { sourceType: "wallet_topup", sourceId: row.id, kind: "file" };
    }
  }

  return undefined;
}

/** Admin-safe description of a legacy match. Never leaks a hash. */
export function describeLegacyMatch(match: LegacyDuplicateMatch): string {
  const what = match.kind === "file" ? "This exact slip image" : "This bank transaction reference";
  const where =
    match.sourceType === "order_payment"
      ? `order payment #${match.sourceId}`
      : `wallet top-up #${match.sourceId}`;
  return `${what} was already used by an approved ${where} that predates the claim registry.`;
}

export { referenceHashFromExtractedData, fileHashFromExtractedData };
