/**
 * Legacy approved-slip compatibility layer.
 *
 * ── The problem this solves ───────────────────────────────────────────────
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
 * Neither is used here.
 *
 * ── Completeness ──────────────────────────────────────────────────────────
 * This scan has NO correctness cap. An earlier revision used `.limit(5000)`,
 * which made the "global" claim false: on a database with more approved
 * payments than that, rows outside the (unordered) result were invisible and
 * replaying one of them would have created value again. It now pages through
 * the ENTIRE approved set ordered by primary key, which is both complete and
 * deterministic. Any failure propagates so callers fail CLOSED rather than
 * concluding "no duplicate".
 *
 * This layer is a temporary belt-and-braces measure; once every historical
 * row has a real claim it becomes redundant, and its cost stops mattering.
 */

import { payments, walletTopups } from "../../drizzle/schema";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { hashSlipReference } from "./slipIdentifierService";
import { extractSlipData } from "../ocr-slip-verification-v2";

export type LegacySourceType = "order_payment" | "wallet_topup";

export type LegacyMatchedBy =
  | "reference_exact"
  | "file_exact"
  | "qr_exact"
  /**
   * Matched ONLY by folding the incoming reference to uppercase against a
   * historical row whose original casing is unrecoverable. Lossy: two
   * genuinely different case-sensitive references fold together here, so this
   * is advisory ambiguity, never a duplicate verdict.
   */
  | "legacy_uppercase_only";

export interface LegacyDuplicateMatch {
  sourceType: LegacySourceType;
  sourceId: number;
  kind: "reference" | "file";
  /**
   * How the match was obtained. Callers MUST branch on this: collapsing an
   * uppercase-only match into a duplicate hard-blocks a legitimate
   * case-sensitive reference with no admin escape.
   */
  matchedBy: LegacyMatchedBy;
  /** How the legacy row's reference was recovered, for operator insight. */
  evidence?: "stored_hash" | "reference_raw" | "reparsed_raw_text" | "legacy_uppercase";
}

/** Page size for the complete scan. Bounded memory, unbounded coverage. */
const SCAN_PAGE_SIZE = 500;

/**
 * A legacy row can yield MORE THAN ONE plausible reference hash, so matching
 * uses a candidate set rather than a single value.
 *
 * The reason is casing. `hashSlipReference` is deliberately case-preserving
 * (upper-casing would map genuinely different SCB references onto one value),
 * but pre-migration rows stored only the OLD upper-cased `reference` field.
 * A replay whose fresh OCR preserves the original mixed case - e.g.
 * `202608225ApOyxElgdOo7YVwv` - hashes differently from the stored
 * `202608225APOYXELGDOO7YVWV`, so a naive comparison would miss it entirely.
 *
 * Recovery order, best evidence first:
 *   1. a stored referenceHash (already canonical)
 *   2. referenceRaw (original casing preserved at write time)
 *   3. re-parsing the stored rawText with the LOCAL parser - no LLM call -
 *      which recovers the original casing from the OCR evidence itself
 *   4. only as a last resort, the old upper-cased `reference`
 *
 * All recovered candidates are returned, not just the best one, so a row that
 * has both rawText and an uppercased field is matchable either way.
 */
export function referenceHashCandidatesFromExtractedData(
  raw: string | null | undefined
): Array<{ hash: string; evidence: NonNullable<LegacyDuplicateMatch["evidence"]> }> {
  if (!raw) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  const candidates: Array<{
    hash: string;
    evidence: NonNullable<LegacyDuplicateMatch["evidence"]>;
  }> = [];
  const push = (
    hash: string | undefined,
    evidence: NonNullable<LegacyDuplicateMatch["evidence"]>
  ) => {
    if (hash && !candidates.some((c) => c.hash === hash)) candidates.push({ hash, evidence });
  };

  if (typeof parsed.referenceHash === "string" && parsed.referenceHash.length === 64) {
    push(parsed.referenceHash, "stored_hash");
  }

  push(hashSlipReference(parsed.referenceRaw), "reference_raw");

  // Re-parse stored OCR text LOCALLY when no case-preserving value exists.
  // This is what recovers a historical mixed-case SCB reference that was only
  // ever persisted upper-cased. Never calls a provider.
  if (!parsed.referenceRaw && typeof parsed.rawText === "string" && parsed.rawText.trim()) {
    try {
      const reparsed = extractSlipData(parsed.rawText);
      push(hashSlipReference(reparsed.referenceRaw), "reparsed_raw_text");
      push(hashSlipReference(reparsed.reference), "reparsed_raw_text");
    } catch {
      // A parser failure must not lose the fallback below - fail safe, not shut.
    }
  }

  // Last resort: the legacy upper-cased field.
  push(hashSlipReference(parsed.reference), "legacy_uppercase");

  return candidates;
}

/**
 * Backward-compatible single-value accessor (best evidence only).
 * Retained for callers that only need one canonical hash.
 */
export function referenceHashFromExtractedData(
  raw: string | null | undefined
): string | undefined {
  return referenceHashCandidatesFromExtractedData(raw)[0]?.hash;
}

export function fileHashFromExtractedData(raw: string | null | undefined): string | undefined {
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

export interface LegacyLookupIdentifiers {
  referenceHash?: string;
  fileHash?: string;
  /**
   * OPTIONAL extra candidate covering the reverse casing gap: the incoming
   * reference hashed in its UPPER-CASED form. Supplied only for matching
   * against legacy rows that were persisted upper-cased and carry no rawText
   * to reparse. It is never used to claim - claims always use the
   * case-preserving hash - so this can only widen detection, and a false
   * positive routes to human review rather than blocking anything outright.
   */
  referenceHashUpperCandidate?: string;
}

function referenceMatches(
  candidates: Array<{ hash: string; evidence: NonNullable<LegacyDuplicateMatch["evidence"]> }>,
  identifiers: LegacyLookupIdentifiers
):
  | { matchedBy: "reference_exact" | "legacy_uppercase_only"; evidence: NonNullable<LegacyDuplicateMatch["evidence"]> }
  | undefined {
  // EXACT first, across ALL candidates. A case-preserving hit is
  // authoritative and must win over any lossy fold, even if the lossy
  // candidate appears earlier in the list.
  if (identifiers.referenceHash) {
    for (const candidate of candidates) {
      if (candidate.hash === identifiers.referenceHash) {
        return { matchedBy: "reference_exact", evidence: candidate.evidence };
      }
    }
  }

  // Lossy fallback: only reachable when nothing matched exactly.
  if (identifiers.referenceHashUpperCandidate) {
    for (const candidate of candidates) {
      if (candidate.hash === identifiers.referenceHashUpperCandidate) {
        return { matchedBy: "legacy_uppercase_only", evidence: candidate.evidence };
      }
    }
  }

  return undefined;
}

/** Strong matches stop the scan; a lossy one is only a fallback. */
function isStrongMatch(match: LegacyDuplicateMatch): boolean {
  return match.matchedBy !== "legacy_uppercase_only";
}

/**
 * Pages through every approved row of one table, ordered by primary key.
 *
 * Deterministic and complete: keyset pagination on an ascending id avoids
 * both the offset-drift problem and any arbitrary cap. `onRow` returning a
 * value stops the scan early with that value.
 */
async function scanApproved<T>(
  tx: any,
  table: typeof payments | typeof walletTopups,
  statusColumn: any,
  idColumn: any,
  extractedDataColumn: any,
  onRow: (row: { id: number; extractedData: string | null }) => T | undefined,
  /** Return false to keep scanning (a lossy fallback), true to stop now. */
  shouldStop: (hit: T) => boolean = () => true
): Promise<T | undefined> {
  let fallback: T | undefined;
  let cursor = 0;

  // Unbounded in coverage, bounded in memory: each iteration reads at most
  // SCAN_PAGE_SIZE rows and advances the cursor past them.
  for (;;) {
    const page = await tx
      .select({ id: idColumn, extractedData: extractedDataColumn })
      .from(table)
      .where(
        and(eq(statusColumn, "approved"), isNotNull(extractedDataColumn), gt(idColumn, cursor))
      )
      .orderBy(asc(idColumn))
      .limit(SCAN_PAGE_SIZE);

    if (!page || page.length === 0) return undefined;

    for (const row of page) {
      const hit = onRow(row);
      if (hit !== undefined) {
        if (shouldStop(hit)) return hit;
        // Remember the weaker match but keep looking for a stronger one, so
        // an exact duplicate later in the table still wins.
        fallback = fallback ?? hit;
      }
    }

    cursor = page[page.length - 1].id;
    if (page.length < SCAN_PAGE_SIZE) return fallback;
  }
}

/**
 * Finds an APPROVED order payment or wallet top-up that already used this
 * slip, GLOBALLY - any user, either source, every row.
 *
 * Read-only. Any query failure propagates so the caller fails closed.
 *
 * PRIORITY: an EXACT match (file or case-preserving reference) always wins
 * over a lossy uppercase-only fold, even when the lossy one is found first or
 * lives in the other table. Collapsing the two would hard-block a legitimate
 * case-sensitive reference as a duplicate, with no admin escape - so callers
 * must branch on `matchedBy`, not merely on "something matched".
 */
export async function findLegacyApprovedDuplicate(
  identifiers: LegacyLookupIdentifiers,
  excludeSource: { sourceType: LegacySourceType; sourceId: number } | undefined,
  tx: any
): Promise<LegacyDuplicateMatch | undefined> {
  if (!identifiers.referenceHash && !identifiers.fileHash) return undefined;

  const inspect =
    (sourceType: LegacySourceType) =>
    (row: { id: number; extractedData: string | null }): LegacyDuplicateMatch | undefined => {
      if (excludeSource?.sourceType === sourceType && excludeSource.sourceId === row.id) {
        return undefined;
      }

      // An exact FILE match outranks a lossy reference fold, so it is checked
      // before falling back to an uppercase-only reference hit.
      if (
        identifiers.fileHash &&
        fileHashFromExtractedData(row.extractedData) === identifiers.fileHash
      ) {
        return {
          sourceType,
          sourceId: row.id,
          kind: "file",
          matchedBy: "file_exact",
          evidence: "stored_hash",
        };
      }

      const referenceHit = referenceMatches(
        referenceHashCandidatesFromExtractedData(row.extractedData),
        identifiers
      );
      if (referenceHit) {
        return {
          sourceType,
          sourceId: row.id,
          kind: "reference",
          matchedBy: referenceHit.matchedBy,
          evidence: referenceHit.evidence,
        };
      }

      return undefined;
    };

  const paymentHit = await scanApproved(
    tx,
    payments,
    payments.status,
    payments.id,
    payments.extractedData,
    inspect("order_payment"),
    isStrongMatch
  );
  // Only a STRONG payment hit short-circuits. A lossy one is held back so an
  // exact duplicate in the wallet table can still outrank it.
  if (paymentHit && isStrongMatch(paymentHit)) return paymentHit;

  const topupHit = await scanApproved(
    tx,
    walletTopups,
    walletTopups.status,
    walletTopups.id,
    walletTopups.extractedData,
    inspect("wallet_topup"),
    isStrongMatch
  );

  if (topupHit && isStrongMatch(topupHit)) return topupHit;

  // Neither source produced an exact match. Surface whichever lossy hit
  // exists, if any - it is advisory ambiguity, not a duplicate.
  return paymentHit ?? topupHit;
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
