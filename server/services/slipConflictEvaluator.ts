/**
 * ONE read-only classifier for "does this slip conflict with anything?".
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The claim path, Admin Recheck and the admin detail query each grew their
 * own slightly different conflict lookup. They drifted: Recheck consulted the
 * exact registry and the legacy scan but not the advisory alias, so it could
 * report READY for a payment that Approve was guaranteed to refuse. Three
 * near-copies of a financial decision is the actual defect; this module is
 * the single definition they now share.
 *
 * ── The two kinds of evidence ─────────────────────────────────────────────
 * STRONG / AUTHORITATIVE - exact case-preserving referenceHash, fileHash,
 * qrPayloadHash. These are proof, may block finalization, and surface as a
 * duplicate.
 *
 * LOSSY LEGACY CASE - the incoming raw reference folded to uppercase, matched
 * against a historical row whose true casing is unrecoverable. Two genuinely
 * different case-sensitive references fold together here, so it is NEVER a
 * duplicate verdict. It blocks auto-approval and normal approval, creates no
 * claim and no value, and requires an explicit audited admin resolution.
 *
 * EXACT ALWAYS WINS. If a record matches both exactly and by fold, the result
 * is a strong duplicate - the lossy signal is a fallback only.
 *
 * ── What this is not ──────────────────────────────────────────────────────
 * Strictly READ-ONLY. It inserts nothing and decides nothing financial.
 * claimSlip still owns the atomic INSERT that actually enforces uniqueness;
 * any read performed here can be invalidated by a concurrent commit, which is
 * exactly why the UNIQUE constraint remains the authority.
 */

import { findExistingClaim, findClaimsByLegacyAlias } from "./slipClaimService";
import {
  findLegacyApprovedDuplicate,
  findLegacyAliasGroupMembers,
  isLegacyStrongMatch,
} from "./legacySlipCompatibilityService";
import { isLegacyScanRequired } from "./slipBackfillStateService";
import { hashSlipReference, type SlipStrongIdentifiers } from "./slipIdentifierService";
import { findKnownLegacyCollision } from "./slipLegacyCollisionService";

export type SlipConflictSourceType = "order_payment" | "wallet_topup";

export type SlipConflict =
  | { kind: "none" }
  | {
      kind: "strong_duplicate";
      /** Which exact identifier proved it. */
      matchedKind: "reference" | "file" | "qr";
      matchedSourceType: SlipConflictSourceType;
      matchedSourceId: number;
      /** True when found in pre-migration records rather than the registry. */
      viaLegacyCompatibility: boolean;
    }
  | {
      kind: "legacy_case_ambiguity";
      matchedSourceType: SlipConflictSourceType;
      matchedSourceId: number;
      /** Always true - this evidence is advisory, never proof. */
      advisory: true;
      requiresAdminResolution: true;
      legacyAliasHash?: string;
    }
  | {
      /**
       * This submission's own strong identifier (reference, file, or QR
       * hash) exactly matches an identifier the backfill DURABLY recorded as
       * a KNOWN COLLISION: two or more already-approved historical rows
       * share it. No winner was ever picked among those historical rows
       * (that would fabricate uniqueness over financial history), so
       * nothing in the registry "owns" it - a plain claim-registry lookup
       * would see no conflict and let this insert succeed. This is the
       * indexed, durable replacement for that gap: found via ONE lookup
       * against paymentSlipLegacyCollisions, never a historical scan. Never
       * a duplicate verdict on its own (we don't know if THIS submission is
       * one of the colliding historical rows), but never safe to
       * auto-approve either - it fails closed and requires manual
       * investigation of the whole historical group, exactly like
       * `legacy_case_ambiguity_group`.
       */
      kind: "known_collision";
      matchedKind: "reference" | "file" | "qr";
      matchedSourceType: SlipConflictSourceType;
      matchedSourceId: number;
      /** Always true - never a duplicate verdict. */
      advisory: true;
      /** Always false - there is no single-member waiver to grant here. */
      requiresAdminResolution: false;
    }
  | {
      /**
       * MORE THAN ONE historical source shares this lossy alias. A human
       * resolution must never waive it by adjudicating just one arbitrary
       * member - the incoming submission could equally be a replay of a
       * DIFFERENT member the admin never saw. This is a distinct state from
       * `legacy_case_ambiguity` (exactly one member) precisely because it has
       * no audited "confirm distinct" escape: it fails closed and requires
       * manual/operator investigation of the complete group, never an
       * automated or single-click waiver.
       */
      kind: "legacy_case_ambiguity_group";
      /** One representative member, for admin-safe display/navigation only - never implies it is the ONLY one. */
      matchedSourceType: SlipConflictSourceType;
      matchedSourceId: number;
      /** Always true - never a duplicate verdict. */
      advisory: true;
      /** Always false - there is no single-member waiver to grant here. */
      requiresAdminResolution: false;
      legacyAliasHash?: string;
    }
  | {
      /**
       * The live legacy scan encountered an approved historical row it could
       * not evaluate: no persisted fileHash, and no exact fileHash could be
       * recovered from its own stored slip bytes. We do not know whether
       * that row IS this submission, so this is neither "no conflict" nor a
       * proven duplicate - it fails closed and requires a human decision.
       * Possible only while the legacy scan is required; a completed
       * backfill has already resolved (or refused to complete over) every
       * approved row, so this cannot occur post-backfill.
       */
      kind: "unresolved";
      matchedSourceType: SlipConflictSourceType;
      matchedSourceId: number;
    };

export interface EvaluateSlipConflictInput {
  identifiers: SlipStrongIdentifiers;
  /** RAW, case-preserving reference. Used ONLY to derive the lossy fold. */
  rawReference?: string;
  sourceType: SlipConflictSourceType;
  sourceId: number;
  /**
   * Whether to consult the temporary O(N) historical scan. Defaults to the
   * durable backfill-complete switch, so pre- and post-backfill behaviour is
   * identical from the caller's point of view.
   */
  includeLegacyScanIfRequired?: boolean;
}

/**
 * Classifies any conflict for this slip.
 *
 * Ordering is deliberate and mirrors the priority rule:
 *   1. exact claim registry (reference / file / qr)
 *   2. exact historical match via the temporary scan
 *   3. lossy legacy case fold - registry alias, then scan
 *
 * A failure in any lookup PROPAGATES. Treating a failed read as "no conflict"
 * would silently reopen replay, so callers fail closed.
 */
export async function evaluateSlipConflict(
  input: EvaluateSlipConflictInput,
  tx: any
): Promise<SlipConflict> {
  const self = { sourceType: input.sourceType, sourceId: input.sourceId };

  // ── 1. Exact registry match ────────────────────────────────────────────
  const existingClaim = await findExistingClaim(input.identifiers, tx);
  if (
    existingClaim &&
    !(existingClaim.sourceType === self.sourceType && existingClaim.sourceId === self.sourceId)
  ) {
    return {
      kind: "strong_duplicate",
      matchedKind: existingClaim.kind,
      matchedSourceType: existingClaim.sourceType,
      matchedSourceId: existingClaim.sourceId,
      viaLegacyCompatibility: false,
    };
  }

  // ── 1.5. Durable known-collision registry (indexed, no scan) ───────────
  // Checked BEFORE the temporary historical scan and regardless of whether
  // the backfill is complete: a collision here is a fact about historical
  // data, discovered and recorded once by the backfill, and is authoritative
  // the moment it exists - there is no "pre-backfill" version of this check
  // to fall back to, because before the backfill runs the table is simply
  // empty and this step is a fast no-op.
  const knownCollision = await findKnownLegacyCollision(input.identifiers, tx);
  if (knownCollision) {
    return {
      kind: "known_collision",
      matchedKind: knownCollision.kind,
      matchedSourceType: knownCollision.matchedSourceType,
      matchedSourceId: knownCollision.matchedSourceId,
      advisory: true,
      requiresAdminResolution: false,
    };
  }

  const legacyAliasHash = input.rawReference
    ? hashSlipReference(input.rawReference.toUpperCase())
    : undefined;

  // ── 2. Exact historical match (temporary scan) ─────────────────────────
  const scanRequired =
    input.includeLegacyScanIfRequired === false ? false : await isLegacyScanRequired();

  let scanHit: Awaited<ReturnType<typeof findLegacyApprovedDuplicate>>;
  if (scanRequired) {
    scanHit = await findLegacyApprovedDuplicate(
      {
        referenceHash: input.identifiers.referenceHash,
        fileHash: input.identifiers.fileHash,
        referenceHashUpperCandidate: legacyAliasHash,
      },
      self,
      tx
    );

    // Only an EXACT historical hit is a duplicate. An uppercase-only hit and
    // an unresolved row are handled below - collapsing either one here would
    // be the same bug class: hard-blocking a legitimate reference (lossy
    // fold) or silently approving an unverifiable historical row (unresolved)
    // as though it were proven clean.
    if (scanHit && isLegacyStrongMatch(scanHit)) {
      return {
        kind: "strong_duplicate",
        matchedKind: scanHit.kind,
        matchedSourceType: scanHit.sourceType,
        matchedSourceId: scanHit.sourceId,
        viaLegacyCompatibility: true,
      };
    }

    // An approved historical row could not be evaluated at all - no
    // persisted fileHash and no recoverable one. We do not know if it IS
    // this submission, so this fails closed ahead of the lossy legacy-case
    // fold below: "we don't know" is a stronger reason to stop than a
    // recognised, lossy ambiguity.
    if (scanHit && scanHit.matchedBy === "unresolved") {
      return {
        kind: "unresolved",
        matchedSourceType: scanHit.sourceType,
        matchedSourceId: scanHit.sourceId,
      };
    }
  }

  // ── 3. Lossy legacy case fold ──────────────────────────────────────────
  // Checked AFTER every exact avenue, and evaluated whether or not the scan
  // is enabled, so pre- and post-backfill produce the same verdict.
  //
  // COMPLETE ALIAS GROUP, ACROSS BOTH MECHANISMS. A human resolution must
  // never waive this alias by adjudicating just one arbitrary historical
  // source: if a SECOND source also folds to it, the incoming submission
  // could equally be a replay of the one the admin never saw. While the
  // legacy scan is still required (backfill incomplete), an indexed match
  // and a not-yet-backfilled approved row can each hide the other - an
  // indexed `aliasMatches.length === 1` does NOT mean only one historical
  // source shares this fold, only that one has been backfilled so far. So
  // the semantic member set is the UNION of the indexed registry lookup and
  // the live-scan group lookup, de-duplicated by (sourceType, sourceId) -
  // the same historical source visible through both mechanisms counts once.
  // Once the scan is no longer required, every historical row has been
  // accounted for by the backfill, so the indexed registry alone is
  // authoritative again and the scan is skipped entirely.
  if (legacyAliasHash) {
    const aliasMatches = await findClaimsByLegacyAlias(legacyAliasHash, self, tx);
    const members: Array<{ sourceType: SlipConflictSourceType; sourceId: number }> =
      aliasMatches.map((m) => ({ sourceType: m.sourceType, sourceId: m.sourceId }));

    if (scanRequired && members.length <= 1) {
      const scanMembers = await findLegacyAliasGroupMembers(legacyAliasHash, self, tx);
      for (const m of scanMembers) {
        const alreadyCounted = members.some(
          (x) => x.sourceType === m.sourceType && x.sourceId === m.sourceId
        );
        if (!alreadyCounted) {
          members.push({ sourceType: m.sourceType, sourceId: m.sourceId });
          // Cardinality only - a third member would not change the verdict.
          if (members.length > 1) break;
        }
      }
    }

    if (members.length > 1) {
      return {
        kind: "legacy_case_ambiguity_group",
        matchedSourceType: members[0].sourceType,
        matchedSourceId: members[0].sourceId,
        advisory: true,
        requiresAdminResolution: false,
        legacyAliasHash,
      };
    }
    if (members.length === 1) {
      return {
        kind: "legacy_case_ambiguity",
        matchedSourceType: members[0].sourceType,
        matchedSourceId: members[0].sourceId,
        advisory: true,
        requiresAdminResolution: true,
        legacyAliasHash,
      };
    }
  }

  return { kind: "none" };
}

/** Admin-safe summary. Never leaks a hash. */
export function describeSlipConflict(conflict: SlipConflict): string {
  if (conflict.kind === "none") return "";

  const where =
    conflict.matchedSourceType === "order_payment"
      ? `order payment #${conflict.matchedSourceId}`
      : `wallet top-up #${conflict.matchedSourceId}`;

  if (conflict.kind === "legacy_case_ambiguity") {
    return (
      `This reference matches an approved ${where} only after letter casing is ignored. ` +
      `That older record lost its original casing, so this is NOT proof of a duplicate - ` +
      `the two references may be genuinely different. An admin must decide whether to ` +
      `reject it as a duplicate or approve it as a distinct transaction.`
    );
  }

  if (conflict.kind === "unresolved") {
    return (
      `An approved ${where} predates the claim registry and its slip image could not be ` +
      `verified server-side, so historical replay protection for it is incomplete. This is ` +
      `NOT a proven duplicate - it cannot be confirmed either way. An admin must review the ` +
      `historical record manually before this can be approved.`
    );
  }

  if (conflict.kind === "known_collision") {
    const what =
      conflict.matchedKind === "file"
        ? "This exact slip image"
        : conflict.matchedKind === "qr"
          ? "This slip's QR payload"
          : "This bank transaction reference";
    return (
      `${what} is already known to be shared by MORE THAN ONE approved historical record - ` +
      `including ${where} - discovered during the legacy backfill. No single historical record ` +
      `was picked as the "real" owner. This is NOT proof of a duplicate. An admin must manually ` +
      `investigate the complete group of matching historical records before this can be approved.`
    );
  }

  if (conflict.kind === "legacy_case_ambiguity_group") {
    return (
      `This reference matches MORE THAN ONE approved historical record - including ${where} - ` +
      `only after letter casing is ignored. Because more than one older record shares this ` +
      `fold, no single one of them can be safely adjudicated as "distinct": this submission ` +
      `could be a replay of any member of that group. This is NOT proof of a duplicate. An ` +
      `admin must manually investigate the complete group of matching historical records ` +
      `before this can be approved.`
    );
  }

  const what =
    conflict.matchedKind === "file"
      ? "This exact slip image"
      : conflict.matchedKind === "qr"
        ? "This slip's QR payload"
        : "This bank transaction reference";

  return `${what} has already been used to create value (${where}). It cannot be used again.`;
}
