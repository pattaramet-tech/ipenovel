/**
 * Atomic anti-replay claim service.
 *
 * INVARIANT: ONE REAL BANK TRANSACTION CAN CREATE FINANCIAL VALUE ONCE -
 * across order payments, wallet top-ups, and users alike.
 *
 * ── Why a claim, not a check ──────────────────────────────────────────────
 * The previous design was "SELECT existing references -> if none, approve".
 * That is a check-then-act race:
 *
 *     A: SELECT -> none        B: SELECT -> none
 *     A: approve  (value #1)   B: approve  (value #2)
 *
 * Both observe a clean read and both create value from ONE bank transaction.
 * No amount of re-reading fixes this; the decision has to be made by
 * something that can serialize the two writers.
 *
 * So instead of asking "is this a duplicate?", callers CLAIM the slip's
 * strong identifiers by INSERTing them, inside the SAME transaction that
 * finalizes the money. The UNIQUE indexes on paymentSlipClaims make the
 * database the arbiter: exactly one of the racing inserts commits, the other
 * fails with a duplicate-key error and is routed to manual review. The claim
 * and the financial effect therefore commit or roll back together - there is
 * no window in which one exists without the other.
 *
 * ── What may be claimed ───────────────────────────────────────────────────
 * STRONG identifiers only: referenceHash, fileHash, qrPayloadHash. Each maps
 * to one real bank transaction.
 *
 * semanticFingerprint is recorded on the row but is NOT unique and is NEVER
 * claimed, because two legitimate transfers of the same amount from the same
 * account on the same day share it. Enforcing it would block real customers.
 *
 * A slip with NO strong identifier cannot be claimed at all. Such a slip must
 * never auto-approve - there is nothing to prevent it being replayed - so
 * callers receive `noStrongIdentifier` and must route to human review.
 *
 * ── What this service never does ──────────────────────────────────────────
 * It never rejects a payment. A failed claim produces a review outcome; only
 * an admin may reject.
 */

import { paymentSlipClaims } from "../../drizzle/schema";
import { eq, or } from "drizzle-orm";
import { findLegacyApprovedDuplicate } from "./legacySlipCompatibilityService";
import { hashSlipReference } from "./slipIdentifierService";
import { isLegacyScanRequired } from "./slipBackfillStateService";
import type { SlipStrongIdentifiers, StrongDuplicateKind } from "./slipIdentifierService";

export type SlipClaimSourceType = "order_payment" | "wallet_topup";

export interface SlipClaimRequest {
  sourceType: SlipClaimSourceType;
  sourceId: number;
  userId: number;
  identifiers: SlipStrongIdentifiers;
  /** WEAK signal - stored for admin context, never enforced. */
  semanticFingerprint?: string;
  /**
   * Skips the pre-migration approved-record lookup. ONLY for the backfill
   * tool, which is itself replaying historical approvals and would otherwise
   * find every row conflicting with itself. Never set on a live payment path.
   */
  skipLegacyCheck?: boolean;
  /**
   * The RAW (case-preserving) reference, used ONLY for the advisory legacy
   * ambiguity lookup. Never used for the claim, and never upper-cased into
   * one - the claim always uses the case-preserving hash.
   */
  referenceRawForLegacyLookup?: string;
  /**
   * Set by the admin "confirmed distinct" resolution to proceed past a known
   * legacy case ambiguity that a human has already adjudicated. It skips ONLY
   * the advisory alias check - every exact UNIQUE identifier is still claimed
   * atomically, so this can never bypass real anti-replay.
   */
  legacyCaseAmbiguityResolved?: boolean;
}

export type SlipClaimOutcome =
  | { claimed: true; claimId: number; claimedKinds: StrongDuplicateKind[] }
  | {
      claimed: false;
      /** No strong identifier existed, so nothing could be claimed. */
      reason: "no_strong_identifier";
    }
  | {
      claimed: false;
      reason: "already_claimed";
      /** Which strong identifier was already taken, when determinable. */
      conflictKind?: StrongDuplicateKind;
      /** The submission that already owns it, for admin cross-linking. */
      existingSourceType?: SlipClaimSourceType;
      existingSourceId?: number;
      /**
       * True when the conflict was found in the pre-migration approved
       * record set rather than in the claim registry - i.e. a legacy slip
       * that would otherwise have been replayable.
       */
      viaLegacyCompatibility?: boolean;
    }
  | {
      claimed: false;
      /**
       * The submission's upper-cased reference matched a HISTORICAL row whose
       * original casing is unrecoverable.
       *
       * This is ADVISORY, not ownership. Upper-casing is lossy, so this may
       * be one replayed transaction OR two genuinely different references
       * that merely fold together - the signal cannot tell them apart.
       *
       * It therefore STOPS auto-approval (no claim is inserted, no value is
       * created) and routes to an explicit admin resolution. It is
       * deliberately NOT `already_claimed`: that outcome makes normal Approve
       * fail forever, leaving a legitimate distinct payment with nowhere to
       * go. See admin.orders.resolveLegacyCaseAmbiguity.
       */
      reason: "legacy_case_ambiguity";
      matchedSourceType?: SlipClaimSourceType;
      matchedSourceId?: number;
      legacyAliasHashMatched: true;
      /** Never "strong" - the signal is explicitly lossy. */
      conflictStrength: "advisory";
      requiresAdminResolution: true;
      /** The alias that matched, for the audit record. */
      legacyAliasHash?: string;
    };

/**
 * MySQL/MariaDB duplicate-key signals. Checked structurally rather than by
 * message text so a locale-translated server message still classifies.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === "ER_DUP_ENTRY") return true;
  if (e.errno === 1062) return true;
  return typeof e.message === "string" && /duplicate entry/i.test(e.message);
}

/**
 * Best-effort mapping of a duplicate-key error to the specific identifier
 * that collided, using the index name the engine reports.
 */
function conflictKindFromError(error: unknown): StrongDuplicateKind | undefined {
  const message = (error as { message?: string } | null)?.message ?? "";
  if (/referenceHash/i.test(message)) return "reference";
  if (/fileHash/i.test(message)) return "file";
  if (/qrPayloadHash/i.test(message)) return "qr";
  return undefined;
}

function presentKinds(identifiers: SlipStrongIdentifiers): StrongDuplicateKind[] {
  const kinds: StrongDuplicateKind[] = [];
  if (identifiers.referenceHash) kinds.push("reference");
  if (identifiers.fileHash) kinds.push("file");
  if (identifiers.qrPayloadHash) kinds.push("qr");
  return kinds;
}

/**
 * Looks up which existing claim owns any of the supplied strong identifiers.
 *
 * READ-ONLY and advisory. Used to enrich an admin explanation ("already used
 * by wallet top-up #123") and to pre-empt an obviously-doomed approval with
 * a clear message. It is NEVER the authority for the claim decision - that is
 * always the UNIQUE constraint inside claimSlip(), because any read performed
 * before the write can be invalidated by a concurrent commit.
 */
export async function findExistingClaim(
  identifiers: SlipStrongIdentifiers,
  tx: any
): Promise<
  | {
      kind: StrongDuplicateKind;
      sourceType: SlipClaimSourceType;
      sourceId: number;
      userId: number;
    }
  | undefined
> {
  const conditions = [];
  if (identifiers.referenceHash) {
    conditions.push(eq(paymentSlipClaims.referenceHash, identifiers.referenceHash));
  }
  if (identifiers.fileHash) {
    conditions.push(eq(paymentSlipClaims.fileHash, identifiers.fileHash));
  }
  if (identifiers.qrPayloadHash) {
    conditions.push(eq(paymentSlipClaims.qrPayloadHash, identifiers.qrPayloadHash));
  }
  if (conditions.length === 0) return undefined;

  const rows = await tx
    .select()
    .from(paymentSlipClaims)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(1);

  const row = rows?.[0];
  if (!row) return undefined;

  let kind: StrongDuplicateKind = "reference";
  if (identifiers.referenceHash && row.referenceHash === identifiers.referenceHash) {
    kind = "reference";
  } else if (identifiers.fileHash && row.fileHash === identifiers.fileHash) {
    kind = "file";
  } else if (identifiers.qrPayloadHash && row.qrPayloadHash === identifiers.qrPayloadHash) {
    kind = "qr";
  }

  return {
    kind,
    sourceType: row.sourceType as SlipClaimSourceType,
    sourceId: row.sourceId as number,
    userId: row.userId as number,
  };
}

/**
 * Looks up a HISTORICAL claim by its advisory legacy case alias.
 *
 * Read-only and indexed. Only backfilled rows whose original casing is
 * unrecoverable carry this value, so a hit means "a historical record exists
 * that MIGHT be this same transaction" - never proof.
 *
 * Excludes the caller's own row so re-approving the same record is not
 * mistaken for an ambiguity.
 */
export async function findClaimByLegacyAlias(
  legacyAliasHash: string,
  excludeSource: { sourceType: SlipClaimSourceType; sourceId: number },
  tx: any
): Promise<{ sourceType: SlipClaimSourceType; sourceId: number } | undefined> {
  const rows = await tx
    .select()
    .from(paymentSlipClaims)
    .where(eq(paymentSlipClaims.legacyReferenceUpperHash, legacyAliasHash))
    .limit(5);

  for (const row of rows ?? []) {
    if (row.sourceType === excludeSource.sourceType && row.sourceId === excludeSource.sourceId) {
      continue;
    }
    return {
      sourceType: row.sourceType as SlipClaimSourceType,
      sourceId: row.sourceId as number,
    };
  }
  return undefined;
}

/**
 * Atomically claims a slip's strong identifiers.
 *
 * MUST be called with `tx` being the SAME transaction that creates the
 * financial value (approval + wallet credit / order finalization). Passing a
 * separate connection would reintroduce the very race this exists to close.
 *
 * Returns an outcome instead of throwing on conflict: a duplicate is an
 * expected business state that routes to manual review, not a system fault.
 * Genuine infrastructure errors still propagate so the surrounding
 * transaction rolls back rather than silently approving.
 *
 * Idempotency note: a re-claim by the SAME source (e.g. an admin retrying an
 * approval that already committed) is reported as already_claimed with the
 * existing source echoed back, letting the caller recognise "this is mine"
 * rather than treating it as a replay by someone else.
 */
export async function claimSlip(
  request: SlipClaimRequest,
  tx: any
): Promise<SlipClaimOutcome> {
  const kinds = presentKinds(request.identifiers);

  if (kinds.length === 0) {
    // Nothing uniquely identifies this bank transaction, so nothing can stop
    // it being submitted again. Auto-approval is therefore not permissible.
    return { claimed: false, reason: "no_strong_identifier" };
  }

  // ── LEGACY COMPATIBILITY GATE ───────────────────────────────────────────
  // The claim registry starts EMPTY at migration time, so every payment and
  // top-up approved before it existed has no claim row and its reference is
  // unprotected by the UNIQUE constraints. Without this check, a slip that
  // already created value last week would sail through: no conflicting
  // claim exists, the INSERT succeeds, and value is created a second time.
  //
  // So before claiming, the already-approved financial record set is
  // consulted GLOBALLY (all users, both sources) - never the old user-scoped
  // or pending-only lookups that made replay possible in the first place.
  //
  // This runs inside the caller's transaction and is read-only. Once the
  // backfill has populated claims for historical rows this becomes redundant
  // belt-and-braces, but until then the registry must not be sole authority.
  // The scan is skipped once a verified backfill has written a claim for every
  // historical approval - at that point the UNIQUE registry is sufficient and
  // this O(N) scan is pure cost on every approval. The switch is read from the
  // DATABASE and fails safe: any read problem, malformed value, or missing
  // record keeps the scan enabled.
  const legacyScanRequired = request.skipLegacyCheck
    ? false
    : await isLegacyScanRequired();

  // CASE-FOLDED compatibility alias for the incoming reference.
  //
  // Some pre-migration rows were persisted with only an UPPER-CASED
  // `reference` and no `rawText` to reparse, so their true casing is
  // unrecoverable and the backfill can only ever store the upper-case hash.
  // A replay whose fresh OCR preserves the original mixed case therefore has
  // a DIFFERENT case-preserving hash and would not collide with that claim.
  //
  // This alias is what those rows can be matched on. It is checked against an
  // INDEXED, non-unique registry column below, so the protection survives the
  // historical scan being retired - without it, --mark-complete would silently
  // reopen the mixed-case gap.
  const referenceHashUpper = request.referenceRawForLegacyLookup
    ? hashSlipReference(request.referenceRawForLegacyLookup.toUpperCase())
    : undefined;

  if (legacyScanRequired) {
    try {
      const legacyMatch = await findLegacyApprovedDuplicate(
        {
          referenceHash: request.identifiers.referenceHash,
          fileHash: request.identifiers.fileHash,
          // Covers the reverse casing gap: a legacy row persisted only as an
          // UPPER-CASED reference, with no rawText to reparse, cannot match a
          // fresh mixed-case read. Hashing the incoming reference in its
          // upper-cased form gives that row something to match against.
          // Matching only - the claim itself always uses the case-preserving
          // hash, and a false positive here routes to review, never a block.
          referenceHashUpperCandidate: referenceHashUpper,
        },
        { sourceType: request.sourceType, sourceId: request.sourceId },
        tx
      );

      if (legacyMatch) {
        return {
          claimed: false,
          reason: "already_claimed",
          conflictKind: legacyMatch.kind,
          existingSourceType: legacyMatch.sourceType,
          existingSourceId: legacyMatch.sourceId,
          viaLegacyCompatibility: true,
        };
      }
    } catch (error) {
      // A failed legacy lookup must NOT be treated as "no duplicate" - that
      // would silently reopen the very hole this closes. Propagate so the
      // surrounding transaction rolls back and the slip goes to review.
      throw error;
    }
  }

  // ── ADVISORY LEGACY CASE-AMBIGUITY LOOKUP (always runs) ────────────────
  // Deliberately OUTSIDE the legacyScanRequired branch: retiring the O(N)
  // historical scan must not retire cover for rows whose original reference
  // casing is unrecoverable. This is an indexed equality lookup, so keeping
  // it permanently costs O(log n).
  //
  // The result is ADVISORY, never ownership. Upper-casing is lossy, so a hit
  // may be one replayed transaction OR two genuinely different references
  // that fold together. Returning `already_claimed` here (as an earlier
  // revision did) made normal Approve fail forever for the second, legitimate
  // payment - a dead end with no admin escape.
  //
  // So a hit STOPS auto-approval without inserting any claim and without
  // creating value, and asks for a human decision. Two concurrent
  // differently-cased reads therefore BOTH stop, which is why the lossy alias
  // needs no serialization of its own: neither path can create value.
  if (referenceHashUpper && !request.legacyCaseAmbiguityResolved) {
    const aliasMatch = await findClaimByLegacyAlias(
      referenceHashUpper,
      { sourceType: request.sourceType, sourceId: request.sourceId },
      tx
    );

    if (aliasMatch) {
      return {
        claimed: false,
        reason: "legacy_case_ambiguity",
        matchedSourceType: aliasMatch.sourceType,
        matchedSourceId: aliasMatch.sourceId,
        legacyAliasHashMatched: true,
        conflictStrength: "advisory",
        requiresAdminResolution: true,
        legacyAliasHash: referenceHashUpper,
      };
    }
  }

  try {
    const inserted = await tx.insert(paymentSlipClaims).values({
      sourceType: request.sourceType,
      sourceId: request.sourceId,
      userId: request.userId,
      referenceHash: request.identifiers.referenceHash ?? null,
      // NEVER set here. The alias marks a HISTORICAL row whose casing is
      // unrecoverable; a modern claim has its exact case-preserving hash, so
      // writing an alias would manufacture ambiguity that does not exist and
      // would drag unrelated future payments into manual review.
      // Only the backfill sets it, and only for legacy_uppercase evidence.
      legacyReferenceUpperHash: null,
      fileHash: request.identifiers.fileHash ?? null,
      qrPayloadHash: request.identifiers.qrPayloadHash ?? null,
      semanticFingerprint: request.semanticFingerprint ?? null,
      claimedAt: new Date(),
    });

    const claimId = Number((inserted as any)?.[0]?.insertId ?? (inserted as any)?.insertId ?? 0);
    return { claimed: true, claimId, claimedKinds: kinds };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      // Not a replay - a real failure. Propagate so the caller's transaction
      // rolls back instead of finalizing money on an unverified claim.
      throw error;
    }

    // Someone else owns one of these identifiers. Identify who, for the admin
    // message. This read runs in the same failed-statement transaction, so it
    // is advisory only; the authoritative fact is simply "we did not get it".
    let existing:
      | Awaited<ReturnType<typeof findExistingClaim>>
      | undefined;
    try {
      existing = await findExistingClaim(request.identifiers, tx);
    } catch {
      // Never let diagnostics enrichment mask the real outcome.
      existing = undefined;
    }

    return {
      claimed: false,
      reason: "already_claimed",
      conflictKind: conflictKindFromError(error) ?? existing?.kind,
      existingSourceType: existing?.sourceType,
      existingSourceId: existing?.sourceId,
    };
  }
}

/**
 * Human-readable, admin-safe explanation of a failed claim.
 * Contains no identifiers, hashes, URLs, or user PII.
 */
export function describeClaimFailure(outcome: SlipClaimOutcome): string {
  if (outcome.claimed) return "";

  if (outcome.reason === "no_strong_identifier") {
    return (
      "No strong identifier could be derived from this slip (no readable transaction " +
      "reference, no file hash, no QR payload), so replay cannot be prevented " +
      "automatically. Manual review is required."
    );
  }

  if (outcome.reason === "legacy_case_ambiguity") {
    const where =
      outcome.matchedSourceType && outcome.matchedSourceId
        ? outcome.matchedSourceType === "order_payment"
          ? ` an approved order payment #${outcome.matchedSourceId}`
          : ` an approved wallet top-up #${outcome.matchedSourceId}`
        : " an earlier approved record";

    // Deliberately hedged language: the alias is lossy, so this is a question
    // for a human, not a verdict.
    return (
      `This reference matches${where} only after letter casing is ignored. That older ` +
      `record lost its original casing, so this is NOT proof of a duplicate - the two ` +
      `references may be genuinely different. An admin must decide whether to reject it ` +
      `as a duplicate or approve it as a distinct transaction.`
    );
  }

  const what =
    outcome.conflictKind === "file"
      ? "This exact slip image"
      : outcome.conflictKind === "qr"
        ? "This slip's QR payload"
        : "This bank transaction reference";

  const where =
    outcome.existingSourceType && outcome.existingSourceId
      ? outcome.existingSourceType === "order_payment"
        ? ` (already used by order payment #${outcome.existingSourceId})`
        : ` (already used by wallet top-up #${outcome.existingSourceId})`
      : "";

  return `${what} has already been used to create value${where}. It cannot be used again.`;
}

/**
 * Looks up submissions sharing a WEAK semantic fingerprint.
 *
 * Returned purely as a review signal for the admin panel. Callers must label
 * it as "possible duplicate only" and must never block, reject, or
 * auto-decide on it - the same customer sending the same amount twice in one
 * day produces this match legitimately.
 */
export async function findWeakFingerprintMatches(
  semanticFingerprint: string | undefined,
  excludeSource: { sourceType: SlipClaimSourceType; sourceId: number },
  tx: any
): Promise<Array<{ sourceType: SlipClaimSourceType; sourceId: number }>> {
  if (!semanticFingerprint) return [];

  const rows = await tx
    .select()
    .from(paymentSlipClaims)
    .where(eq(paymentSlipClaims.semanticFingerprint, semanticFingerprint))
    .limit(20);

  return (rows ?? [])
    .filter(
      (r: any) =>
        !(r.sourceType === excludeSource.sourceType && r.sourceId === excludeSource.sourceId)
    )
    .map((r: any) => ({
      sourceType: r.sourceType as SlipClaimSourceType,
      sourceId: r.sourceId as number,
    }));
}
