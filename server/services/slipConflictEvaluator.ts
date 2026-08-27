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
import {
  findKnownLegacyCollision,
  findAnyLegacyFileIdentityUnknown,
} from "./slipLegacyCollisionService";

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
       * "We cannot prove this submission is safe on the file axis."
       *
       * Two ways to reach it, both fail closed for manual review, neither a
       * proven duplicate:
       *
       *  - PRE-completion: the live legacy scan hit an approved historical
       *    row it could not evaluate at all (no persisted fileHash, none
       *    recoverable from its own stored bytes).
       *
       *  - POST-completion: the O(N) scan is retired, but
       *    `paymentSlipLegacyUnknown` is non-empty - some historical rows
       *    (`no_slip_image_url`) permanently lost their slip bytes, so their
       *    exact fileHash is in no registry. A current submission whose ONLY
       *    strong evidence is a fileHash therefore cannot be ruled out as a
       *    byte-identical replay of one of them. (A submission that also
       *    carries a reference or QR is sufficient and never reaches here -
       *    those axes are fully covered by the indexed registries.)
       *
       * `matchedSource` is one representative historical row for admin-safe
       * display/navigation - it does NOT assert that row is the match.
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
 *   1. durable known-collision registry (no winner - fail closed)
 *   2. exact singleton claim registry (reference / file / qr)
 *   3. exact historical match via the temporary scan
 *   4. lossy legacy case fold - registry alias, then scan
 *   5. post-completion file-axis sufficiency (fileHash-only + permanent
 *      unknown legacy file identity exists -> fail closed)
 *
 * A failure in any lookup PROPAGATES. Treating a failed read as "no conflict"
 * would silently reopen replay, so callers fail closed.
 */
export async function evaluateSlipConflict(
  input: EvaluateSlipConflictInput,
  tx: any
): Promise<SlipConflict> {
  const self = { sourceType: input.sourceType, sourceId: input.sourceId };

  // ── 1. Durable known-collision registry (indexed, no scan) ─────────────
  // Checked BEFORE the singleton claim registry, and regardless of whether
  // the backfill is complete. When the backfill hits two historical rows
  // sharing one exact identifier, the FIRST gets an ordinary
  // paymentSlipClaims row and the rest are recorded as collision members -
  // so a plain findExistingClaim() on that hash WOULD succeed and present
  // that first backfilled row as a proven duplicate owner. That is a
  // fabricated winner: no historical row was ever adjudicated the real
  // owner of a collision. The known-collision lookup therefore takes
  // precedence - the identifier surfaces as `known_collision` (no winner,
  // fail closed, manual review of the whole group), never
  // `strong_duplicate`. Before the backfill runs the table is empty and
  // this is a fast no-op.
  const knownCollision = await findKnownLegacyCollision(input.identifiers, tx, self);
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

  // ── 2. Exact singleton claim registry (reference / file / qr) ──────────
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

  // ── 3. Exact historical match (temporary scan) ─────────────────────────
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

  // ── 4. Lossy legacy case fold ──────────────────────────────────────────
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

  // ── 5. Post-completion file-axis sufficiency ──────────────────────────
  // Nothing above matched. The reference and QR axes are fully covered by
  // the indexed registries, so a submission carrying either is SUFFICIENT
  // and finalizes now. But once the O(N) historical scan is retired
  // (backfill complete), the FILE axis has a residual gap: some historical
  // approved rows (`no_slip_image_url`) permanently lost their slip bytes,
  // so their exact fileHash could never be computed and is in no registry.
  // They are recorded in `paymentSlipLegacyUnknown` for exactly this check.
  // A submission whose ONLY strong evidence is a fileHash cannot be ruled
  // out as a byte-identical replay of one of them - it fails closed for
  // manual review, deterministically, via ONE bounded indexed read (never a
  // history scan). While the scan is still required this is a no-op: the
  // scan itself already covers the file axis and returns its own
  // `unresolved` for any row it cannot evaluate.
  if (!scanRequired) {
    const onlyFileEvidence =
      Boolean(input.identifiers.fileHash) &&
      !input.identifiers.referenceHash &&
      !input.identifiers.qrPayloadHash;
    if (onlyFileEvidence) {
      const unknownRow = await findAnyLegacyFileIdentityUnknown(tx);
      if (unknownRow) {
        return {
          kind: "unresolved",
          matchedSourceType: unknownRow.sourceType,
          matchedSourceId: unknownRow.sourceId,
        };
      }
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
      `At least one approved historical record (for example ${where}) cannot have its slip ` +
      `image verified server-side - its bytes are gone - so its exact file identity is in no ` +
      `registry and cannot be compared against this submission's slip image. This submission ` +
      `therefore cannot be confirmed clean OR a duplicate on the file axis. This is NOT a ` +
      `proven duplicate. An admin must review it manually; a verified bank reference or QR ` +
      `payload on the slip would let it clear automatically.`
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
