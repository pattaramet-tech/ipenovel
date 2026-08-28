import * as db from "../db";
import { formatMoney, moneyAdd } from "../helpers/moneyNormalizer";
import { ACCOUNT_MERGE_SINGLETON_TABLES } from "./accountMergeInventory";
import type {
  AccountMergeBalanceProjection,
  AccountMergePreview,
  AccountMergeProjectedAction,
  AccountMergeTableFinding,
  AccountMergeTargetValidation,
} from "./accountMergeTypes";

/**
 * Advanced Account Merge - Phase 1 (IPE-003) read-only preview.
 *
 * Every exported function in this file, and every server/db.ts function it
 * calls (see that file's own "ADVANCED ACCOUNT MERGE" section), performs
 * ONLY SELECT/count/join reads - there is no `.insert(`, `.update(`, or
 * `.delete(` anywhere in the call graph rooted at buildAccountMergePreview.
 * That is what makes this preview safe to call repeatedly (acceptance C):
 * calling it twice, or a hundred times, in any order, against the same
 * database state always returns the same answer and changes nothing.
 * accountMergePreviewService.test.ts's "zero mutation" suite asserts this
 * by spying on every db.ts export this file imports and proving none of
 * the write-shaped ones (insert/update/delete/transaction) are ever
 * called.
 *
 * Two hard requirements this file exists specifically to satisfy (mirroring
 * accountRecoveryService.ts's own two, for the sibling workflow this one
 * always originates from):
 * - `sourceUserId` is NEVER a parameter here - only ever derived from the
 *   BLOCKED accountRecoveryRequests row's own `requesterUserId`, by the
 *   caller (see server/routers.ts's accountMerge.admin.preview). Nothing a
 *   client sends can substitute a different source account.
 * - Never expose raw Google identity material (providerSubject/
 *   emailAtLink) - AccountMergeTargetValidation carries booleans only,
 *   the same redaction rule accountRecoveryService.ts's
 *   AccountRecoverySafetyAssessmentDto already enforces.
 */

/**
 * Validates a candidate (sourceUserId, targetUserId) pairing exactly the
 * way accountRecoveryService.assessAccountRecoverySafety validates a
 * recovery approval - distinct accounts, neither an admin, source must
 * genuinely own a real (never claimed/typed) Google identity, target must
 * have none yet. Read-only; never throws for an invalid pairing - the
 * caller decides what to do with a result whose `isValid` is false (see
 * buildAccountMergePreview, which stops there and never computes a table
 * inventory against data that would not mean anything).
 */
export async function validateAccountMergeTarget(
  sourceUserId: number,
  targetUserId: number
): Promise<AccountMergeTargetValidation> {
  const blockers: string[] = [];

  const [source, target] = await Promise.all([db.getUserById(sourceUserId), db.getUserById(targetUserId)]);

  const sourceExists = Boolean(source);
  const targetExists = Boolean(target);
  if (!sourceExists) blockers.push("Source account no longer exists");
  if (!targetExists) blockers.push("Target account no longer exists");

  const distinctAccounts = sourceUserId !== targetUserId;
  if (sourceExists && targetExists && !distinctAccounts) {
    blockers.push("Source and target are the same account");
  }

  const sourceIsAdmin = source?.role === "admin";
  const targetIsAdmin = target?.role === "admin";
  if (sourceIsAdmin) blockers.push("Source account is an admin account - never a merge source");
  if (targetIsAdmin) blockers.push("Target account is an admin account - never a merge target");

  // The ONLY evidence ever trusted for "source owns a Google identity" - a
  // real row, looked up fresh, matching accountRecoveryService.ts's
  // identical rule for the sibling Account Recovery workflow.
  const sourceIdentity = sourceExists
    ? await db.getAuthIdentityByUserAndProvider(sourceUserId, "google")
    : undefined;
  const sourceHasGoogleIdentity = Boolean(sourceIdentity);
  if (!sourceHasGoogleIdentity) {
    blockers.push("Source account has no linked Google identity - cannot verify ownership");
  }

  const targetIdentity = targetExists
    ? await db.getAuthIdentityByUserAndProvider(targetUserId, "google")
    : undefined;
  const targetHasGoogleIdentity = Boolean(targetIdentity);
  if (targetHasGoogleIdentity) {
    blockers.push("Target account already has a linked Google identity");
  }

  return {
    sourceUserId,
    targetUserId,
    sourceExists,
    targetExists,
    sourceIsAdmin,
    targetIsAdmin,
    sourceHasGoogleIdentity,
    targetHasGoogleIdentity,
    distinctAccounts,
    blockers,
    isValid: blockers.length === 0,
  };
}

const EMPTY_BALANCE_PROJECTION: AccountMergeBalanceProjection = {
  sourceBalance: "0.00",
  targetBalance: "0.00",
  projectedMergedBalance: "0.00",
};

async function buildBalanceProjection(
  getBalance: (userId: number) => Promise<string>,
  sourceUserId: number,
  targetUserId: number
): Promise<AccountMergeBalanceProjection> {
  const [sourceBalance, targetBalance] = await Promise.all([getBalance(sourceUserId), getBalance(targetUserId)]);
  return {
    sourceBalance,
    targetBalance,
    projectedMergedBalance: formatMoney(moneyAdd(sourceBalance, targetBalance), "projectedMergedBalance"),
  };
}

/** Derives what a LATER phase would need to do with one table's rows from
 *  its raw counts - pure, no I/O. See AccountMergeProjectedAction's own
 *  doc comment for what each value means. */
function deriveProjectedAction(
  table: string,
  sourceCount: number,
  conflictCount: number
): AccountMergeProjectedAction {
  if (sourceCount === 0) return "no_action";
  const isSingleton = ACCOUNT_MERGE_SINGLETON_TABLES.includes(table);
  if (conflictCount > 0) return isSingleton ? "consolidate_singleton" : "transfer_with_dedupe";
  return "transfer_only";
}

function deriveTableWarnings(
  table: string,
  projectedAction: AccountMergeProjectedAction,
  conflictCount: number
): string[] {
  if (projectedAction === "consolidate_singleton") {
    return [
      `${table}: both accounts already have their own row - requires explicit consolidation, not a plain transfer`,
    ];
  }
  if (projectedAction === "transfer_with_dedupe") {
    return [
      `${table}: ${conflictCount} row(s) collide with data the target already owns and cannot be transferred as-is`,
    ];
  }
  return [];
}

const PAYMENT_SLIP_CLAIMS_NOTE =
  "Informational only - the anti-replay claim registry is never touched by any account workflow (recovery or merge); a later execution phase must leave these rows exactly as they are, see accountRecoveryDataClassification.ts's paymentSlipClaims.userId entry.";

/**
 * Assembles the full read-only merge preview for one (blocked recovery
 * request, candidate target) pair. Stops at target validation - an invalid
 * pairing returns immediately with every downstream field zeroed/empty,
 * never a table inventory or projection computed against data that
 * wouldn't mean anything (e.g. a non-existent target's "balance").
 */
export async function buildAccountMergePreview(params: {
  requestId: number;
  sourceUserId: number;
  targetUserId: number;
}): Promise<AccountMergePreview> {
  const { requestId, sourceUserId, targetUserId } = params;

  const targetValidation = await validateAccountMergeTarget(sourceUserId, targetUserId);

  if (!targetValidation.isValid) {
    return {
      requestId,
      sourceUserId,
      targetUserId,
      targetValidation,
      tableFindings: [],
      walletProjection: EMPTY_BALANCE_PROJECTION,
      pointsProjection: EMPTY_BALANCE_PROJECTION,
      paymentSlipClaims: { sourceCount: 0, note: PAYMENT_SLIP_CLAIMS_NOTE },
      hardBlockers: [...targetValidation.blockers],
      warnings: [],
      isPreviewValid: false,
    };
  }

  const [rawFindings, walletProjection, pointsProjection, paymentSlipClaimsCount] = await Promise.all([
    db.findAccountMergeTableInventory(sourceUserId, targetUserId),
    buildBalanceProjection(db.getAccountMergeWalletBalance, sourceUserId, targetUserId),
    buildBalanceProjection(db.getAccountMergePointsBalance, sourceUserId, targetUserId),
    db.getAccountMergePaymentSlipClaimsCount(sourceUserId),
  ]);

  const tableFindings: AccountMergeTableFinding[] = rawFindings.map((finding) => {
    const projectedAction = deriveProjectedAction(finding.table, finding.sourceCount, finding.conflictCount);
    return {
      table: finding.table,
      category: finding.category,
      sourceCount: finding.sourceCount,
      targetCount: finding.targetCount,
      conflictCount: finding.conflictCount,
      projectedAction,
      warnings: deriveTableWarnings(finding.table, projectedAction, finding.conflictCount),
    };
  });

  const hardBlockers = tableFindings.flatMap((f) => f.warnings);

  return {
    requestId,
    sourceUserId,
    targetUserId,
    targetValidation,
    tableFindings,
    walletProjection,
    pointsProjection,
    paymentSlipClaims: { sourceCount: paymentSlipClaimsCount, note: PAYMENT_SLIP_CLAIMS_NOTE },
    hardBlockers,
    warnings: [],
    isPreviewValid: true,
  };
}
