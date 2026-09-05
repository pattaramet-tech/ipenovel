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
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import type { SlipStrongIdentifiers, StrongDuplicateKind } from "./slipIdentifierService";
import { traceOrderApprovalStage, type OrderApprovalVerificationBudget } from "../helpers/orderApprovalExecution";

export type SlipClaimSourceType = "order_payment" | "wallet_topup";

export interface SlipClaimRequest {
  /** Server-only cooperative bound; expiration aborts, never skips replay checks. */
  verificationBudget?: OrderApprovalVerificationBudget;
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
   * The EXACT legacy case ambiguity an admin adjudicated as "confirmed
   * distinct" - not a bare boolean.
   *
   * A boolean was too broad: it waived whatever ambiguity happened to be
   * current at claim time. If a Recheck rewrote `extractedData` between the
   * admin's decision and this transaction, the new extraction could fold to
   * a DIFFERENT unrecoverable historical reference and be waived by a
   * decision that was never about it - approving a replay.
   *
   * The waiver therefore applies only when the ambiguity found HERE, from
   * transaction-visible state, is identical to the one adjudicated: same
   * alias hash, same matched source. Anything else returns
   * `legacy_case_ambiguity_changed` and nothing is claimed.
   *
   * Every value is derived SERVER-SIDE by the resolution service; none of it
   * is accepted from a browser.
   */
  legacyCaseAmbiguityResolution?: {
    /** Undefined pre-backfill, where the scan finds the row without an alias. */
    expectedLegacyAliasHash?: string;
    expectedMatchedSourceType: SlipClaimSourceType;
    expectedMatchedSourceId: number;
    /**
     * The EXACT case-preserving reference hash the admin adjudicated.
     *
     * Binding to the alias and the matched source alone was still too loose:
     * those describe the historical FOLD, and folding is lossy. A Recheck
     * changing `abc123` to `AbC123` keeps the same alias and the same matched
     * row, so the waiver still applied - to a case-preserving reference no
     * human had ever seen, which the claim then inserted.
     *
     * Never upper-cased, and never supplied by a browser.
     */
    expectedIncomingReferenceHash?: string;
  };
  /**
   * Server-generated waiver for the post-completion GLOBAL historical
   * file-axis coverage gap only. Bound to the exact current fileHash that the
   * approving transaction recomputed immediately before this claim. Exact
   * duplicates/collisions and the pre-completion live scan are never waived.
   */
  legacyFileAxisRiskResolution?: {
    expectedFileHash: string;
  };
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
    }
  | {
      claimed: false;
      /**
       * An admin resolution was presented, but the ambiguity visible from
       * inside this transaction is NOT the one they adjudicated - the
       * evidence moved underneath the decision.
       *
       * Distinct from `legacy_case_ambiguity` so the caller can tell the
       * admin to refresh and re-adjudicate CURRENT evidence rather than
       * repeating a decision that no longer applies. Nothing is claimed and
       * no value is created.
       */
      reason: "legacy_case_ambiguity_changed";
      /** The ambiguity that is actually current, for the refreshed panel. */
      matchedSourceType?: SlipClaimSourceType;
      matchedSourceId?: number;
      requiresAdminResolution: true;
    }
  | {
      claimed: false;
      /**
       * The live legacy scan hit an approved historical row it could not
       * evaluate: no persisted fileHash, and none could be recovered from
       * its own stored slip bytes. We do not know whether that row IS this
       * submission, so this is neither a proven duplicate nor "no conflict"
       * - it fails closed. Possible only while the legacy scan is required;
       * a completed backfill has already resolved (or refused to complete
       * over) every approved row.
       */
      reason: "legacy_scan_unresolved";
      matchedSourceType?: SlipClaimSourceType;
      matchedSourceId?: number;
      unresolvedScope?: "legacy_scan_record" | "historical_file_axis_coverage";
      requiresAdminResolution: true;
    }
  | {
      claimed: false;
      /**
       * MORE THAN ONE historical source shares the alias this submission
       * folds to. NEVER waived, regardless of any `legacyCaseAmbiguityResolution`
       * presented - a resolution can only ever have adjudicated ONE member
       * of the group, and this submission could equally be a replay of a
       * DIFFERENT member. There is deliberately no audited path that grants
       * this: it requires manual/operator investigation of the complete
       * group, not a single-click waiver.
       */
      reason: "legacy_alias_group_ambiguity";
      matchedSourceType?: SlipClaimSourceType;
      matchedSourceId?: number;
      requiresAdminResolution: false;
      legacyAliasHash?: string;
    }
  | {
      claimed: false;
      /**
       * This submission's own strong identifier exactly matches an
       * identifier the backfill DURABLY recorded as a KNOWN COLLISION
       * between two or more already-approved historical rows. No winner was
       * ever picked among them, so nothing in the registry owns it - this is
       * the indexed check that stops it being claimed anyway. NEVER
       * waivable: there is no single-member resolution that could apply to
       * an unpicked group.
       */
      reason: "known_collision";
      conflictKind?: StrongDuplicateKind;
      matchedSourceType?: SlipClaimSourceType;
      matchedSourceId?: number;
      requiresAdminResolution: false;
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
 * The FOREIGN owner of any supplied strong identifier, chosen deterministically
 * PER AXIS (IPE-004-C07).
 *
 * ── Why findExistingClaim above is not enough here ────────────────────────
 * That function issues ONE `or(...)` query with `.limit(1)`, so which row
 * comes back among several matches is up to the database. When the caller has
 * already excluded collision-ambiguous axes and is asking "does any remaining
 * axis prove a duplicate?", that indeterminacy is a correctness bug: if this
 * submission's own source owns a claim on one clean axis while a DIFFERENT
 * clean axis is exactly owned by a foreign source, the engine may return the
 * self row first. The caller discards self (self is never a duplicate),
 * concludes nothing was proven, and falls back to a weaker verdict from some
 * other axis - hiding a proven replay and naming the wrong source.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * Ask each present axis its own question, in the fixed (reference, file, qr)
 * order, and return the FIRST axis with a foreign owner. A self-owned axis is
 * skipped, never allowed to terminate the search. Every column queried here is
 * UNIQUE, so each axis has at most one owner and each lookup is a single
 * indexed point read - at most three, bounded by the identifiers the incoming
 * slip actually carries.
 *
 * Still READ-ONLY and still advisory: claimSlip's UNIQUE constraint remains the
 * write authority, because any read can be invalidated by a concurrent commit.
 */
export async function findForeignClaimPerAxis(
  identifiers: SlipStrongIdentifiers,
  tx: any,
  self: { sourceType: SlipClaimSourceType; sourceId: number }
): Promise<
  | {
      kind: StrongDuplicateKind;
      sourceType: SlipClaimSourceType;
      sourceId: number;
      userId: number;
    }
  | undefined
> {
  const axes: Array<[StrongDuplicateKind, "referenceHash" | "fileHash" | "qrPayloadHash"]> = [
    ["reference", "referenceHash"],
    ["file", "fileHash"],
    ["qr", "qrPayloadHash"],
  ];

  for (const [kind, field] of axes) {
    const hash = identifiers[field];
    if (!hash) continue;

    const rows = await tx
      .select()
      .from(paymentSlipClaims)
      .where(eq(paymentSlipClaims[field], hash))
      .limit(1);

    const row = rows?.[0];
    if (!row) continue;
    // Self-owned: not a duplicate, and NOT a reason to stop looking - a later
    // axis may still carry a genuine foreign owner.
    if (row.sourceType === self.sourceType && row.sourceId === self.sourceId) continue;

    return {
      kind,
      sourceType: row.sourceType as SlipClaimSourceType,
      sourceId: row.sourceId as number,
      userId: row.userId as number,
    };
  }

  return undefined;
}


/**
 * Looks up EVERY historical claim sharing one advisory legacy case alias.
 *
 * Read-only and indexed. Only backfilled rows whose original casing is
 * unrecoverable carry this value, so a hit means "a historical record exists
 * that MIGHT be this same transaction" - never proof.
 *
 * Returns ALL matching claims (excluding the caller's own row), not just the
 * first: the alias is lossy, so more than one historical source can
 * legitimately share it. Callers MUST check the returned count before
 * treating a single member as adjudicable - waiving the alias against one
 * arbitrary member while a SECOND historical source shares the same fold
 * would let a replay of that second source through an admin decision that
 * was never about it. See evaluateSlipConflict's `legacy_case_ambiguity`
 * (exactly one member) vs `legacy_case_ambiguity_group` (more than one)
 * split.
 */
export async function findClaimsByLegacyAlias(
  legacyAliasHash: string,
  excludeSource: { sourceType: SlipClaimSourceType; sourceId: number },
  tx: any
): Promise<Array<{ sourceType: SlipClaimSourceType; sourceId: number }>> {
  const rows = await tx
    .select()
    .from(paymentSlipClaims)
    .where(eq(paymentSlipClaims.legacyReferenceUpperHash, legacyAliasHash))
    .limit(20);

  const members: Array<{ sourceType: SlipClaimSourceType; sourceId: number }> = [];
  for (const row of rows ?? []) {
    if (row.sourceType === excludeSource.sourceType && row.sourceId === excludeSource.sourceId) {
      continue;
    }
    members.push({
      sourceType: row.sourceType as SlipClaimSourceType,
      sourceId: row.sourceId as number,
    });
  }
  return members;
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
  request.verificationBudget?.throwIfExpired();
  const kinds = presentKinds(request.identifiers);

  if (kinds.length === 0) {
    // Nothing uniquely identifies this bank transaction, so nothing can stop
    // it being submitted again. Auto-approval is therefore not permissible.
    return { claimed: false, reason: "no_strong_identifier" };
  }

  // ── CONFLICT PREFLIGHT ──────────────────────────────────────────────────
  // Delegated to the single shared evaluator so the claim path, Admin Recheck
  // and the admin detail query cannot drift apart on a financial decision.
  //
  // It distinguishes the two kinds of evidence, which is the whole point:
  //   STRONG (exact reference/file/qr)  -> already_claimed, may hard-block
  //   LOSSY  (uppercase fold of a legacy row) -> legacy_case_ambiguity
  //
  // An earlier revision collapsed both into already_claimed, which
  // hard-blocked a legitimate case-sensitive reference as a duplicate and
  // left no admin escape. Exact always wins over lossy.
  //
  // Read-only and advisory: the UNIQUE INSERT below remains the authority,
  // because any read here can be invalidated by a concurrent commit.
  if (!request.skipLegacyCheck) {
    const conflict = await evaluateSlipConflict(
      {
        identifiers: request.identifiers,
        rawReference: request.referenceRawForLegacyLookup,
        sourceType: request.sourceType,
        sourceId: request.sourceId,
        legacyFileAxisRiskResolution: request.legacyFileAxisRiskResolution,
        verificationBudget: request.verificationBudget,
      },
      tx
    );
    request.verificationBudget?.throwIfExpired();

    if (conflict.kind === "strong_duplicate") {
      return {
        claimed: false,
        reason: "already_claimed",
        conflictKind: conflict.matchedKind,
        existingSourceType: conflict.matchedSourceType,
        existingSourceId: conflict.matchedSourceId,
        viaLegacyCompatibility: conflict.viaLegacyCompatibility,
      };
    }

    if (conflict.kind === "unresolved") {
      // An approved historical row exists that could not be verified - not a
      // proven duplicate, not provably clean. Never claimed, never treated
      // as ordinary review; the caller must tell the admin replay protection
      // is incomplete for this record.
      return {
        claimed: false,
        reason: "legacy_scan_unresolved",
        matchedSourceType: conflict.matchedSourceType,
        matchedSourceId: conflict.matchedSourceId,
        unresolvedScope: conflict.unresolvedScope,
        requiresAdminResolution: true,
      };
    }

    if (conflict.kind === "known_collision") {
      // A durably recorded historical collision. NEVER consult any waiver -
      // there is none for this state, by design; see the outcome's doc.
      return {
        claimed: false,
        reason: "known_collision",
        conflictKind: conflict.matchedKind,
        matchedSourceType: conflict.matchedSourceType,
        matchedSourceId: conflict.matchedSourceId,
        requiresAdminResolution: false,
      };
    }

    if (conflict.kind === "legacy_case_ambiguity_group") {
      // MORE THAN ONE historical source shares this alias. NEVER consult
      // request.legacyCaseAmbiguityResolution here, even if one was
      // presented: any such resolution can only ever have adjudicated ONE
      // member of the group, and this submission could equally be a replay
      // of a different member the admin never reviewed. There is
      // deliberately no waiver path for this state.
      return {
        claimed: false,
        reason: "legacy_alias_group_ambiguity",
        matchedSourceType: conflict.matchedSourceType,
        matchedSourceId: conflict.matchedSourceId,
        requiresAdminResolution: false,
        legacyAliasHash: conflict.legacyAliasHash,
      };
    }

    if (conflict.kind === "legacy_case_ambiguity") {
      const adjudicated = request.legacyCaseAmbiguityResolution;

      if (!adjudicated) {
        return {
          claimed: false,
          reason: "legacy_case_ambiguity",
          matchedSourceType: conflict.matchedSourceType,
          matchedSourceId: conflict.matchedSourceId,
          legacyAliasHashMatched: true,
          conflictStrength: "advisory",
          requiresAdminResolution: true,
          legacyAliasHash: conflict.legacyAliasHash,
        };
      }

      // THE WAIVER IS BOUND TO THE EVIDENCE, NOT TO THE SUBJECT.
      //
      // `conflict` was just computed from transaction-visible state, so this
      // comparison IS the in-transaction revalidation: if a Recheck rewrote
      // the extraction after the admin decided, the current fold differs and
      // the decision does not apply to it.
      const matchesAdjudicated =
        adjudicated.expectedMatchedSourceType === conflict.matchedSourceType &&
        adjudicated.expectedMatchedSourceId === conflict.matchedSourceId &&
        (adjudicated.expectedLegacyAliasHash ?? null) === (conflict.legacyAliasHash ?? null) &&
        // AND the exact thing being approved. The three above identify the
        // historical fold; only this identifies the CURRENT case-preserving
        // reference, which is what the claim is about to take ownership of.
        (adjudicated.expectedIncomingReferenceHash ?? null) ===
          (request.identifiers.referenceHash ?? null);

      if (!matchesAdjudicated) {
        return {
          claimed: false,
          reason: "legacy_case_ambiguity_changed",
          matchedSourceType: conflict.matchedSourceType,
          matchedSourceId: conflict.matchedSourceId,
          requiresAdminResolution: true,
        };
      }

      // Waived: THIS ambiguity, and only this one. The exact UNIQUE claim
      // below is untouched, so a strong duplicate still cannot pass - and a
      // strong duplicate never reaches here anyway, since the evaluator
      // reports it as `strong_duplicate` and returns above.
    }
  }

  request.verificationBudget?.throwIfExpired();
  try {
    const inserted = await traceOrderApprovalStage("claim_insert", async () => tx.insert(paymentSlipClaims).values({
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
    }));
    request.verificationBudget?.throwIfExpired();

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

  if (outcome.reason === "legacy_scan_unresolved") {
    const where =
      outcome.matchedSourceType && outcome.matchedSourceId
        ? outcome.matchedSourceType === "order_payment"
          ? ` order payment #${outcome.matchedSourceId}`
          : ` wallet top-up #${outcome.matchedSourceId}`
        : " an earlier approved record";

    if (outcome.unresolvedScope === "historical_file_axis_coverage") {
      return (
        `Historical replay coverage is incomplete on the file axis because at least one approved ` +
        `record permanently lost its slip bytes.${where} is only a representative example of that ` +
        `global coverage gap - there is NO evidence that this submission matches that record. This ` +
        `submission is not a proven duplicate, but normal approval remains fail-closed while its ` +
        `only strong evidence is fileHash.`
      );
    }

    return (
      `An approved${where} encountered by the active legacy scan predates the claim registry and ` +
      `its slip image could not be verified server-side, so replay protection for that specific ` +
      `record is incomplete. This is NOT a proven duplicate - it cannot be confirmed either way ` +
      `from stored data. Manual investigation of that scan record is required.`
    );
  }

  if (outcome.reason === "known_collision") {
    const where =
      outcome.matchedSourceType && outcome.matchedSourceId
        ? outcome.matchedSourceType === "order_payment"
          ? ` order payment #${outcome.matchedSourceId}`
          : ` wallet top-up #${outcome.matchedSourceId}`
        : " an earlier approved record";
    const what =
      outcome.conflictKind === "file"
        ? "This exact slip image"
        : outcome.conflictKind === "qr"
          ? "This slip's QR payload"
          : "This bank transaction reference";

    return (
      `${what} is already known to be shared by MORE THAN ONE approved historical record - ` +
      `including${where} - discovered during the legacy backfill. No single historical record ` +
      `was picked as the "real" owner. This is NOT proof of a duplicate. Manual investigation ` +
      `of the complete group of matching historical records is required.`
    );
  }

  if (outcome.reason === "legacy_alias_group_ambiguity") {
    const where =
      outcome.matchedSourceType && outcome.matchedSourceId
        ? outcome.matchedSourceType === "order_payment"
          ? ` order payment #${outcome.matchedSourceId}`
          : ` wallet top-up #${outcome.matchedSourceId}`
        : " an earlier approved record";

    return (
      `This reference matches MORE THAN ONE approved historical record - including${where} - ` +
      `only after letter casing is ignored. No single one of them can be safely confirmed as ` +
      `distinct: this submission could be a replay of any member of that group. Manual ` +
      `investigation of the complete group of matching historical records is required.`
    );
  }

  if (outcome.reason === "legacy_case_ambiguity_changed") {
    const where =
      outcome.matchedSourceType && outcome.matchedSourceId
        ? outcome.matchedSourceType === "order_payment"
          ? ` an approved order payment #${outcome.matchedSourceId}`
          : ` an approved wallet top-up #${outcome.matchedSourceId}`
        : " an earlier approved record";

    return (
      `The evidence for this record changed after it was reviewed: it now matches${where} ` +
      `only after letter casing is ignored, which is not what was adjudicated. The earlier ` +
      `decision does not apply to the current evidence, so nothing was approved and nothing ` +
      `was claimed. Refresh and review the current evidence before deciding again.`
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
