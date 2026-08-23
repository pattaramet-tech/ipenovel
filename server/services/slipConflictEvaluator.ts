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

import { findExistingClaim, findClaimByLegacyAlias } from "./slipClaimService";
import { findLegacyApprovedDuplicate } from "./legacySlipCompatibilityService";
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

    // Only an EXACT historical hit is a duplicate. An uppercase-only hit is
    // handled below as ambiguity - collapsing it here is precisely the bug
    // that hard-blocked legitimate case-sensitive references.
    if (scanHit && scanHit.matchedBy !== "legacy_uppercase_only") {
      return {
        kind: "strong_duplicate",
        matchedKind: scanHit.kind,
        matchedSourceType: scanHit.sourceType,
        matchedSourceId: scanHit.sourceId,
        viaLegacyCompatibility: true,
      };
    }
  }

  // ── 3. Lossy legacy case fold ──────────────────────────────────────────
  // Checked AFTER every exact avenue, and evaluated whether or not the scan
  // is enabled, so pre- and post-backfill produce the same verdict.
  if (legacyAliasHash) {
    const aliasMatch = await findClaimByLegacyAlias(legacyAliasHash, self, tx);
    if (aliasMatch) {
      return {
        kind: "legacy_case_ambiguity",
        matchedSourceType: aliasMatch.sourceType,
        matchedSourceId: aliasMatch.sourceId,
        advisory: true,
        requiresAdminResolution: true,
        legacyAliasHash,
      };
    }
  }

  // The scan's uppercase-only hit, held back above, is the pre-backfill
  // equivalent of the indexed alias lookup - same verdict, different mechanism.
  if (scanHit && scanHit.matchedBy === "legacy_uppercase_only") {
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

  const what =
    conflict.matchedKind === "file"
      ? "This exact slip image"
      : conflict.matchedKind === "qr"
        ? "This slip's QR payload"
        : "This bank transaction reference";

  return `${what} has already been used to create value (${where}). It cannot be used again.`;
}
