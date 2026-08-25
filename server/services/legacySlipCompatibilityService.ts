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
import { and, asc, eq, gt } from "drizzle-orm";
import { hashSlipReference } from "./slipIdentifierService";
import { extractSlipData } from "../ocr-slip-verification-v2";
import { computeSlipFileHash } from "./slipFileHashService";

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
  | "legacy_uppercase_only"
  /**
   * This approved row could NOT be evaluated: the incoming submission carries
   * a fileHash to compare, this row has no persisted fileHash, and no exact
   * fileHash could be recovered from its own stored slipImageUrl (missing,
   * unreadable, or the fetch/hash primitive failed). We genuinely do not know
   * whether this historical row IS the current submission, so it must never
   * be silently treated as "no conflict" - see findLegacyApprovedDuplicate.
   */
  | "unresolved";

export interface LegacyDuplicateMatch {
  sourceType: LegacySourceType;
  sourceId: number;
  kind: "reference" | "file" | "unresolved";
  /**
   * How the match was obtained. Callers MUST branch on this: collapsing an
   * uppercase-only match into a duplicate hard-blocks a legitimate
   * case-sensitive reference with no admin escape, and collapsing an
   * `unresolved` row into "no conflict" reopens replay for exactly the rows
   * this scan exists to protect.
   */
  matchedBy: LegacyMatchedBy;
  /** How the legacy row's reference was recovered, for operator insight. */
  evidence?:
    | "stored_hash"
    | "reference_raw"
    | "reparsed_raw_text"
    | "legacy_uppercase"
    | "recovered_from_bytes";
}

/**
 * Relative severity of a non-strong scan hit, highest first. Used so that
 * when a single table scan encounters BOTH an unresolved row and a lossy
 * legacy-case fold (on different rows), the more cautious signal - we don't
 * know vs. we know it's ambiguous - is the one callers see, and so the two
 * tables can be combined the same way. A strong match always wins over both
 * regardless of this ranking; see isStrongMatch.
 */
function fallbackRank(match: LegacyDuplicateMatch): number {
  return match.matchedBy === "unresolved" ? 2 : 1;
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

/**
 * Strong matches stop the scan; a lossy fold or an unresolved row are only
 * held as a fallback while the scan keeps looking for something conclusive.
 */
function isStrongMatch(
  match: LegacyDuplicateMatch
): match is LegacyDuplicateMatch & { kind: "file" | "reference" } {
  return match.matchedBy !== "legacy_uppercase_only" && match.matchedBy !== "unresolved";
}

/** Exported so evaluateSlipConflict can branch without duplicating the rule. */
export { isStrongMatch as isLegacyStrongMatch };

/**
 * Pages through every approved row of one table, ordered by primary key.
 *
 * Deterministic and complete: keyset pagination on an ascending id avoids
 * both the offset-drift problem and any arbitrary cap. `onRow` returning a
 * value stops the scan early with that value.
 */
async function scanApproved<T extends LegacyDuplicateMatch>(
  tx: any,
  table: typeof payments | typeof walletTopups,
  statusColumn: any,
  idColumn: any,
  extractedDataColumn: any,
  slipImageUrlColumn: any,
  onRow: (row: {
    id: number;
    extractedData: string | null;
    slipImageUrl: string | null;
  }) => Promise<T | undefined>,
  /** Return false to keep scanning (a fallback), true to stop now. */
  shouldStop: (hit: T) => boolean = () => true
): Promise<T | undefined> {
  let fallback: T | undefined;
  let cursor = 0;

  // Unbounded in coverage, bounded in memory: each iteration reads at most
  // SCAN_PAGE_SIZE rows and advances the cursor past them.
  //
  // NOT filtered on extractedData being non-NULL. An approved row from an
  // older OCR-disabled/manual-approval flow can legitimately have NULL
  // extraction; excluding it here made it invisible to live anti-replay
  // protection even though the row genuinely created value. onRow below is
  // what decides whether such a row is comparable (via a recovered file
  // hash) or must be reported unresolved - the scan predicate's only job is
  // completeness.
  for (;;) {
    const page = await tx
      .select({ id: idColumn, extractedData: extractedDataColumn, slipImageUrl: slipImageUrlColumn })
      .from(table)
      .where(and(eq(statusColumn, "approved"), gt(idColumn, cursor)))
      .orderBy(asc(idColumn))
      .limit(SCAN_PAGE_SIZE);

    // TERMINAL EMPTY PAGE. Reached when the eligible row count is an exact
    // multiple of SCAN_PAGE_SIZE, so the previous page was full and this one
    // is empty. Returning `undefined` here threw away a fallback already
    // held (a lossy legacy-case fold, or an unresolved row): a mixed-case
    // replay, or a replay of a row we could not evaluate, was then reported
    // as conflict-free and could create value. EOF means "nothing stronger
    // exists", not "nothing was found" - so the accumulated result is
    // returned, exactly as the short-page exit below does.
    if (!page || page.length === 0) return fallback;

    for (const row of page) {
      const hit = await onRow(row);
      if (hit !== undefined) {
        if (shouldStop(hit)) return hit;
        // Remember the more cautious fallback but keep looking for a
        // stronger, conclusive match, so an exact duplicate later in the
        // table still wins over an earlier lossy fold or unresolved row.
        if (!fallback || fallbackRank(hit) > fallbackRank(fallback)) fallback = hit;
      }
    }

    cursor = page[page.length - 1].id;
    // Short page: this source is exhausted. Both exits return `fallback`, so
    // the terminal-empty-page and short-page boundaries behave identically.
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
    async (row: {
      id: number;
      extractedData: string | null;
      slipImageUrl: string | null;
    }): Promise<LegacyDuplicateMatch | undefined> => {
      if (excludeSource?.sourceType === sourceType && excludeSource.sourceId === row.id) {
        return undefined;
      }

      // An exact FILE match outranks a lossy reference fold, so it is checked
      // before falling back to an uppercase-only reference hit.
      const storedFileHash = fileHashFromExtractedData(row.extractedData);
      if (identifiers.fileHash && storedFileHash === identifiers.fileHash) {
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

      // Neither the reference nor a PERSISTED file hash matched. If the
      // incoming submission has nothing to compare on the file axis at all,
      // this row is fully resolved by the checks above - genuinely no
      // conflict, nothing more to know.
      if (!identifiers.fileHash) return undefined;

      // The incoming submission DOES carry a fileHash, and this row has no
      // persisted one to compare it against. We cannot conclude "no match"
      // without knowing this row's actual file identity - a re-upload of the
      // exact same bytes would otherwise slip through simply because an
      // older OCR-disabled/manual-approval flow never wrote extractedData.
      // Recover it, server-side, from the row's OWN stored bytes - never a
      // client value, URL text, filename, or weak fingerprint.
      if (storedFileHash) {
        // A persisted hash existed but did not equal the incoming one
        // (checked above) - this row IS resolved, just not a match.
        return undefined;
      }

      if (!row.slipImageUrl) {
        // No persisted hash AND nothing to recover from. This row's file
        // identity is completely unknown - fail closed rather than silently
        // treating an unverifiable historical row as "no conflict".
        return { sourceType, sourceId: row.id, kind: "unresolved", matchedBy: "unresolved" };
      }

      const recovered = await computeSlipFileHash(row.slipImageUrl);
      if (!recovered) {
        // Recovery was attempted and failed (missing bytes, fetch/timeout,
        // oversized, not a private ref). Still unknown - fail closed.
        return { sourceType, sourceId: row.id, kind: "unresolved", matchedBy: "unresolved" };
      }

      if (recovered === identifiers.fileHash) {
        return {
          sourceType,
          sourceId: row.id,
          kind: "file",
          matchedBy: "file_exact",
          evidence: "recovered_from_bytes",
        };
      }

      // Recovery succeeded and definitively proved this row is a DIFFERENT
      // file. Fully resolved, no conflict.
      return undefined;
    };

  const paymentHit = await scanApproved(
    tx,
    payments,
    payments.status,
    payments.id,
    payments.extractedData,
    payments.slipImageUrl,
    inspect("order_payment"),
    isStrongMatch
  );
  // Only a STRONG payment hit short-circuits. A lossy/unresolved one is held
  // back so an exact duplicate in the wallet table can still outrank it.
  if (paymentHit && isStrongMatch(paymentHit)) return paymentHit;

  const topupHit = await scanApproved(
    tx,
    walletTopups,
    walletTopups.status,
    walletTopups.id,
    walletTopups.extractedData,
    walletTopups.slipImageUrl,
    inspect("wallet_topup"),
    isStrongMatch
  );

  if (topupHit && isStrongMatch(topupHit)) return topupHit;

  // Neither source produced an exact match. Surface whichever fallback is
  // more cautious - unresolved outranks a lossy fold, since "we don't know"
  // is a stronger reason to stop than a recognised, lossy ambiguity.
  if (paymentHit && topupHit) {
    return fallbackRank(topupHit) > fallbackRank(paymentHit) ? topupHit : paymentHit;
  }
  return paymentHit ?? topupHit;
}

export interface LegacyAliasGroupMember {
  sourceType: LegacySourceType;
  sourceId: number;
}

/**
 * Finds every APPROVED historical row (across both tables, excluding the
 * caller's own) whose reference folds to the given upper-cased alias hash -
 * PRE-backfill equivalent of `findClaimsByLegacyAlias`
 * (server/services/slipClaimService.ts), which does the same job against the
 * indexed registry once claims exist.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The live scan's uppercase-only match (`findLegacyApprovedDuplicate`)
 * reports only ONE historical row - the first found, or the highest-ranked
 * fallback. If a SECOND historical row also folds to the same alias, that
 * second source is invisible to the caller entirely. An admin adjudicating
 * "confirmed distinct" against the one row they were shown would then waive
 * an ambiguity that could equally describe a replay of the row they never
 * saw. This function exists solely to answer "is more than one historical
 * source represented by this alias", which evaluateSlipConflict uses to
 * decide between `legacy_case_ambiguity` (one member - the existing,
 * resolvable path) and `legacy_case_ambiguity_group` (more than one - fails
 * closed, no waiver).
 *
 * Stops as soon as TWO distinct members are found: the only decision this
 * feeds is a boolean (group or not), never the exact total, and that
 * decision cannot change once a second member is confirmed. This keeps the
 * common case (no group) cheap while remaining deterministic - the group/
 * no-group verdict never depends on row id or which table happens to be
 * scanned first, only on whether a second matching row EXISTS at all.
 */
export async function findLegacyAliasGroupMembers(
  aliasHash: string,
  excludeSource: { sourceType: LegacySourceType; sourceId: number } | undefined,
  tx: any
): Promise<LegacyAliasGroupMember[]> {
  const members: LegacyAliasGroupMember[] = [];

  async function scanTable(
    sourceType: LegacySourceType,
    table: typeof payments | typeof walletTopups,
    statusColumn: any,
    idColumn: any,
    extractedDataColumn: any
  ): Promise<void> {
    let cursor = 0;
    for (;;) {
      const page = await tx
        .select({ id: idColumn, extractedData: extractedDataColumn })
        .from(table)
        .where(and(eq(statusColumn, "approved"), gt(idColumn, cursor)))
        .orderBy(asc(idColumn))
        .limit(SCAN_PAGE_SIZE);

      if (!page || page.length === 0) return;

      for (const row of page) {
        if (excludeSource?.sourceType === sourceType && excludeSource.sourceId === row.id) {
          continue;
        }
        const candidates = referenceHashCandidatesFromExtractedData(row.extractedData);
        if (candidates.some((c) => c.hash === aliasHash)) {
          members.push({ sourceType, sourceId: row.id });
          if (members.length >= 2) return;
        }
      }

      cursor = page[page.length - 1].id;
      if (page.length < SCAN_PAGE_SIZE) return;
    }
  }

  await scanTable("order_payment", payments, payments.status, payments.id, payments.extractedData);
  if (members.length < 2) {
    await scanTable(
      "wallet_topup",
      walletTopups,
      walletTopups.status,
      walletTopups.id,
      walletTopups.extractedData
    );
  }

  return members;
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
