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
  // COMPLETE ALIAS GROUP FIRST. A human resolution must never waive this
  // alias by adjudicating just one arbitrary historical source: if a SECOND
  // source also folds to it, the incoming submission could equally be a
  // replay of the one the admin never saw. Cardinality is therefore checked
  // BEFORE surfacing any single member, in both the post-backfill (indexed)
  // and pre-backfill (live scan) mechanisms - they must produce the SAME
  // semantic verdict for the same underlying data.
  if (legacyAliasHash) {
    const aliasMatches = await findClaimsByLegacyAlias(legacyAliasHash, self, tx);
    if (aliasMatches.length > 1) {
      return {
        kind: "legacy_case_ambiguity_group",
        matchedSourceType: aliasMatches[0].sourceType,
        matchedSourceId: aliasMatches[0].sourceId,
        advisory: true,
        requiresAdminResolution: false,
        legacyAliasHash,
      };
    }
    if (aliasMatches.length === 1) {
      return {
        kind: "legacy_case_ambiguity",
        matchedSourceType: aliasMatches[0].sourceType,
        matchedSourceId: aliasMatches[0].sourceId,
        advisory: true,
        requiresAdminResolution: true,
        legacyAliasHash,
      };
    }
  }

  // The scan's uppercase-only hit, held back above, is the pre-backfill
  // equivalent of the indexed alias lookup - same verdict, different
  // mechanism. Before surfacing it as a single-member ambiguity, check
  // whether a SECOND historical row (in either table) also folds to the same
  // alias - findLegacyApprovedDuplicate only ever reports the one it found.
  if (scanHit && scanHit.matchedBy === "legacy_uppercase_only" && legacyAliasHash) {
    const groupMembers = await findLegacyAliasGroupMembers(legacyAliasHash, self, tx);
    if (groupMembers.length > 1) {
      return {
        kind: "legacy_case_ambiguity_group",
        matchedSourceType: groupMembers[0].sourceType,
        matchedSourceId: groupMembers[0].sourceId,
        advisory: true,
        requiresAdminResolution: false,
        legacyAliasHash,
      };
    }
    return {
      kind: "legacy_case_ambiguity",
      matchedSourceType: scanHit.sourceType,
      matchedSourceId: scanHit.sourceId,
      advisory: true,
      requiresAdminResolution: true,
      legacyAliasHash,
    };
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
