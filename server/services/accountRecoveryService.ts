import { sql } from "drizzle-orm";
import * as db from "../db";
import type { AccountRecoveryEconomicDataFinding } from "../db";
import type { AccountRecoveryRequest } from "../../drizzle/schema";

/**
 * Central safety/execution logic for the Admin Account Recovery workflow
 * (post-VPS-migration Google-email mismatch: a user's real account and the
 * Google-linked account they're currently signed into are two different
 * `users` rows, and an admin needs to move the Google identity from the
 * new/duplicate account onto the real one). Every rule this feature's task
 * spec enumerates is enforced HERE, once, and reused by both the read-only
 * admin-detail-page preview (assessAccountRecoverySafety) and the actual
 * transactional approval (executeAccountRecovery) - never duplicated
 * per-caller.
 *
 * Two hard requirements this file exists specifically to satisfy:
 * - Never use a claimed/typed email, openId, or user id as approval
 *   evidence - the only thing that ever proves "the source account owns a
 *   Google identity" is a real row in `authIdentities`, looked up fresh
 *   from the database, never taken from the recovery request's own
 *   user-submitted fields.
 * - Never let an admin (or a compromised admin session) move an arbitrary
 *   user's identity - `sourceUserId` is always derived from the recovery
 *   request's `requesterUserId` (itself only ever set from the actual
 *   caller's session at creation time, see submitAccountRecoveryRequest),
 *   never accepted as a parameter here.
 */

export class AccountRecoveryError extends Error {
  code:
    | "NOT_GOOGLE_LINKED"
    | "ALREADY_PENDING"
    | "NOT_FOUND"
    | "ALREADY_PROCESSED"
    | "UNSAFE"
    | "CONFLICT"
    | "FORBIDDEN";

  constructor(code: AccountRecoveryError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "AccountRecoveryError";
  }
}

export type AccountRecoverySafetyAssessment = {
  requestId: number;
  sourceUserId: number;
  targetUserId: number;
  sourceExists: boolean;
  targetExists: boolean;
  sourceIsAdmin: boolean;
  targetIsAdmin: boolean;
  /** The source's real, database-verified Google identity - null means the
   *  claim cannot be substantiated at all (rule: source must genuinely own
   *  the claimed Google identity). Never sourced from request input. */
  sourceGoogleIdentity: { id: number; providerSubject: string; emailAtLink: string } | null;
  targetHasGoogleIdentity: boolean;
  /** Category A ("Economic/Entitlement data") - wallet/points/purchases/
   *  orders/payments/transactions/coupons. ANY finding here is an
   *  unconditional block; see blockReasons. */
  economicDataFindings: AccountRecoveryEconomicDataFinding[];
  /** Category B ("User-owned data") - cart/wishlist/reading progress/
   *  check-ins/other recovery requests. Never blocks by itself, but is
   *  never silently ignored either - see warnings. */
  userOwnedDataFindings: AccountRecoveryEconomicDataFinding[];
  /** Non-empty means approval MUST be refused, with no admin override -
   *  the request can only become "blocked" (Advanced Account Merge
   *  required outside this tool), never "approved". */
  blockReasons: string[];
  /** Non-empty means data could be lost/orphaned by the move - approval is
   *  still POSSIBLE (an admin can proceed after reviewing), but this
   *  assessment deliberately never reports the request as fully safe. */
  warnings: string[];
  canApprove: boolean;
  isFullyAutomatable: boolean;
};

/**
 * Runs every recovery safety rule against the CURRENT database state (or,
 * when called with a `tx`, the CURRENT locked-transaction snapshot - see
 * executeAccountRecovery). Read-only - never writes anything, never throws
 * for an unsafe combination (the caller decides what to do with an
 * assessment that can't approve).
 */
export async function assessAccountRecoverySafety(
  params: { requestId: number; sourceUserId: number; targetUserId: number },
  dbOrTx?: any
): Promise<AccountRecoverySafetyAssessment> {
  const { requestId, sourceUserId, targetUserId } = params;
  const blockReasons: string[] = [];
  const warnings: string[] = [];

  const [source, target] = await Promise.all([
    db.getUserById(sourceUserId, dbOrTx),
    db.getUserById(targetUserId, dbOrTx),
  ]);

  const sourceExists = Boolean(source);
  const targetExists = Boolean(target);
  if (!sourceExists) blockReasons.push("Source account no longer exists");
  if (!targetExists) blockReasons.push("Target account no longer exists");
  if (sourceExists && targetExists && sourceUserId === targetUserId) {
    blockReasons.push("Source and target are the same account");
  }

  const sourceIsAdmin = source?.role === "admin";
  const targetIsAdmin = target?.role === "admin";
  if (sourceIsAdmin) blockReasons.push("Source account is an admin account - never a recovery source");
  if (targetIsAdmin) blockReasons.push("Target account is an admin account - never a recovery target");

  // The ONLY evidence this function ever trusts for "source owns a Google
  // identity" - a real row, looked up fresh, never the request's own
  // claimedLegacyEmail/claimedLegacyOpenId/requestedLegacyUserId fields
  // (those are unverified user assertions, shown to the admin for context
  // only - see drizzle/schema.ts's accountRecoveryRequests doc comment).
  const sourceIdentity = sourceExists
    ? await db.getAuthIdentityByUserAndProvider(sourceUserId, "google", dbOrTx)
    : undefined;
  if (!sourceIdentity) {
    blockReasons.push("Source account has no linked Google identity - cannot verify ownership");
  }

  const targetIdentity = targetExists
    ? await db.getAuthIdentityByUserAndProvider(targetUserId, "google", dbOrTx)
    : undefined;
  const targetHasGoogleIdentity = Boolean(targetIdentity);
  if (targetHasGoogleIdentity) {
    blockReasons.push("Target account already has a linked Google identity");
  }

  const economicDataFindings = sourceExists
    ? await db.findAccountRecoveryEconomicData(sourceUserId, dbOrTx)
    : [];
  if (economicDataFindings.length > 0) {
    blockReasons.push(
      `Source account has economic/entitlement data (${economicDataFindings.map((f) => f.table).join(", ")}) - requires Advanced Account Merge, never an automated move`
    );
  }

  const userOwnedDataFindings = sourceExists
    ? await db.findAccountRecoveryUserOwnedData(sourceUserId, requestId, dbOrTx)
    : [];
  if (userOwnedDataFindings.length > 0) {
    warnings.push(
      `Source account has data that would be left behind (${userOwnedDataFindings.map((f) => f.table).join(", ")}) - review before approving`
    );
  }

  const canApprove = blockReasons.length === 0;

  return {
    requestId,
    sourceUserId,
    targetUserId,
    sourceExists,
    targetExists,
    sourceIsAdmin,
    targetIsAdmin,
    sourceGoogleIdentity: sourceIdentity
      ? { id: sourceIdentity.id, providerSubject: sourceIdentity.providerSubject, emailAtLink: sourceIdentity.emailAtLink }
      : null,
    targetHasGoogleIdentity,
    economicDataFindings,
    userOwnedDataFindings,
    blockReasons,
    warnings,
    canApprove,
    isFullyAutomatable: canApprove && warnings.length === 0,
  };
}

/**
 * Creates a NEW recovery request for the currently-authenticated user.
 * `requesterUserId` must be the caller's own session id - server/routers.ts
 * never accepts it as client input. Enforces both the "must have really
 * logged in via Google" rule (a real authIdentities row - never a
 * manually-typed claim) and "max 1 pending request" (checked here, and
 * additionally backstopped at the database layer by
 * accountRecoveryRequests' generated-column unique index - see
 * drizzle/schema.ts).
 */
export async function submitAccountRecoveryRequest(input: {
  requesterUserId: number;
  requestedLegacyUserId?: number | null;
  claimedLegacyEmail?: string | null;
  claimedLegacyOpenId?: string | null;
  claimedDisplayName?: string | null;
  evidenceNote?: string | null;
  referenceOrderNumber?: string | null;
}): Promise<AccountRecoveryRequest> {
  await db.assertDatabaseAvailable();

  const requesterIdentity = await db.getAuthIdentityByUserAndProvider(input.requesterUserId, "google");
  if (!requesterIdentity) {
    throw new AccountRecoveryError(
      "NOT_GOOGLE_LINKED",
      "You must be signed in with a real, connected Google account to request account recovery"
    );
  }

  const existingPending = await db.getPendingAccountRecoveryRequestForUser(input.requesterUserId);
  if (existingPending) {
    throw new AccountRecoveryError("ALREADY_PENDING", "You already have a pending account recovery request");
  }

  try {
    return await db.createAccountRecoveryRequest(input);
  } catch (error) {
    // The generated-column unique index (accountRecoveryRequests_one_
    // pending_per_requester_unique) is the final backstop against a
    // concurrent double-submit slipping past the plain read above - a
    // duplicate-key error here means exactly that race happened, and must
    // report the same safe "already pending" outcome, never an opaque 500.
    if (isLikelyDuplicateKeyError(error)) {
      throw new AccountRecoveryError("ALREADY_PENDING", "You already have a pending account recovery request");
    }
    throw error;
  }
}

function isLikelyDuplicateKeyError(error: unknown): boolean {
  const err = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } } | undefined;
  const code = err?.code ?? err?.cause?.code;
  const errno = err?.errno ?? err?.cause?.errno;
  return code === "ER_DUP_ENTRY" || errno === 1062;
}

/** mysql2's raw `.execute()` resolves to a [rows, fields] tuple, not the
 *  bare rows array - same unwrap as server/db.ts's lockCartForCheckout/
 *  getCartItemsForUpdate. */
function unwrapRows(rawResult: any): any[] {
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return rows || [];
}

export type AccountRecoveryReviewAction = "reject" | "block" | "cancel";

/**
 * The three non-approval terminal transitions (reject/block/cancel) -
 * simple, conditional, single-row updates plus an audit log entry. Kept
 * separate from executeAccountRecovery (which mutates FOUR tables inside
 * one locked transaction) since none of these ever touch authIdentities or
 * users at all.
 */
export async function reviewAccountRecoveryRequest(params: {
  requestId: number;
  action: AccountRecoveryReviewAction;
  actorAdminId: number | null;
  reason: string;
}): Promise<AccountRecoveryRequest> {
  if (!params.reason || !params.reason.trim()) {
    throw new AccountRecoveryError("FORBIDDEN", "A reason is required");
  }

  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  const toStatus = params.action === "reject" ? "rejected" : params.action === "block" ? "blocked" : "cancelled";

  return database.transaction(async (tx: any) => {
    const transitioned = await db.transitionAccountRecoveryRequestStatus(
      {
        id: params.requestId,
        fromStatuses: ["pending"],
        toStatus,
        reviewedByAdminId: params.actorAdminId,
        reviewReason: params.reason.trim(),
      },
      tx
    );
    if (!transitioned) {
      throw new AccountRecoveryError("ALREADY_PROCESSED", "This recovery request has already been processed");
    }

    await db.insertAccountRecoveryAuditLog(
      {
        recoveryRequestId: params.requestId,
        actorAdminId: params.actorAdminId,
        action: toStatus,
        safeMetadata: { reason: params.reason.trim() },
      },
      tx
    );

    const updated = await db.getAccountRecoveryRequestById(params.requestId, tx);
    if (!updated) throw new Error("[AccountRecovery] Request disappeared mid-transaction");
    return updated;
  });
}

/**
 * The single-transaction Approve flow - every numbered step from the task
 * spec, in order:
 *  1. lock request, 2. lock source user, 3. lock target user, 4. lock the
 *  source's google authIdentity row, 5-6. re-run every safety rule (and
 *  re-verify the target still has no Google identity) against that LOCKED
 *  snapshot - never trusting whatever assessAccountRecoverySafety returned
 *  to the admin UI moments earlier, 7. move the identity, 8-9. never touch
 *  users.id/openId, 10. set target loginMethod="google", 11. backfill
 *  target email ONLY if currently empty, 12. mark the request approved,
 *  13. write the audit log, 14. commit (implicit - the whole function body
 *  is one `database.transaction()` callback; any thrown error rolls back
 *  every write above).
 *
 * `targetUserId` is the one thing an admin actually supplies (via exact-
 * match search, confirmed by typing it in the approve confirmation modal -
 * see client/src/pages/admin/AccountRecoveryAdminPage.tsx) - `sourceUserId`
 * is NEVER a parameter here at all, only ever derived from the locked
 * request row's own `requesterUserId`, so nothing the admin (or a
 * compromised admin session) sends can redirect this to move a different
 * user's identity.
 */
export async function executeAccountRecovery(params: {
  requestId: number;
  targetUserId: number;
  adminId: number;
  reason: string;
}): Promise<{ request: AccountRecoveryRequest; assessment: AccountRecoverySafetyAssessment }> {
  if (!params.reason || !params.reason.trim()) {
    throw new AccountRecoveryError("FORBIDDEN", "A reason is required to approve an account recovery request");
  }
  if (!Number.isInteger(params.targetUserId) || params.targetUserId <= 0) {
    throw new AccountRecoveryError("FORBIDDEN", "A valid target user id is required");
  }

  await db.assertDatabaseAvailable();
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  return database.transaction(async (tx: any) => {
    // Step 1: lock the request row.
    const requestRows = unwrapRows(
      await tx.execute(sql`SELECT * FROM accountRecoveryRequests WHERE id = ${params.requestId} FOR UPDATE`)
    );
    const requestRow = requestRows[0];
    if (!requestRow) throw new AccountRecoveryError("NOT_FOUND", "Recovery request not found");
    if (requestRow.status !== "pending") {
      throw new AccountRecoveryError("ALREADY_PROCESSED", "This recovery request has already been processed");
    }

    const sourceUserId = requestRow.requesterUserId as number;
    const targetUserId = params.targetUserId;

    // Steps 2-3: lock BOTH user rows, smaller id first - a fixed,
    // consistent lock order across every concurrent approval reduces (does
    // not eliminate - InnoDB/TiDB deadlock detection is the real backstop,
    // and simply aborts the losing transaction to be retried) the chance of
    // a deadlock between two unrelated approvals that happen to share a
    // user in reversed source/target roles.
    const orderedUserIds = sourceUserId <= targetUserId ? [sourceUserId, targetUserId] : [targetUserId, sourceUserId];
    for (const id of orderedUserIds) {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${id} FOR UPDATE`);
    }

    // Step 4: lock the source's google authIdentity row (may not exist -
    // handled by the safety re-check immediately below).
    const identityRows = unwrapRows(
      await tx.execute(
        sql`SELECT * FROM authIdentities WHERE userId = ${sourceUserId} AND provider = 'google' FOR UPDATE`
      )
    );
    const identityRow = identityRows[0];

    // Steps 5-6: re-run EVERY safety rule against the now-locked snapshot -
    // deliberately the same function the admin-facing preview uses, never
    // a second, drifted copy of the same logic.
    const assessment = await assessAccountRecoverySafety(
      { requestId: params.requestId, sourceUserId, targetUserId },
      tx
    );
    if (!assessment.canApprove) {
      throw new AccountRecoveryError("UNSAFE", assessment.blockReasons.join("; "));
    }
    if (!identityRow || identityRow.id !== assessment.sourceGoogleIdentity?.id) {
      // Reconciles the locked read above with the assessment's own fresh
      // read - if these ever disagree, something changed between locking
      // and assessing (should be structurally impossible sequentially
      // within one transaction, but this is the cheapest possible guard
      // against ever moving an unexpected row).
      throw new AccountRecoveryError("UNSAFE", "Source Google identity changed - please re-review this request");
    }

    // Step 7: move the identity - conditional on it STILL belonging to the
    // source (re-checked at the SQL level, not just via the read above).
    const moved = await db.moveAuthIdentityOwner(
      { authIdentityId: identityRow.id, expectedCurrentUserId: sourceUserId, targetUserId },
      tx
    );
    if (!moved) {
      throw new AccountRecoveryError("CONFLICT", "Google identity could not be moved - it may have already changed owner");
    }

    // Steps 8-11: finalize the target - never id/openId, loginMethod
    // becomes "google", email backfilled only if currently empty.
    await db.finalizeAccountRecoveryTargetUser(
      { targetUserId, fallbackEmail: identityRow.emailAtLink ?? null },
      tx
    );

    // Step 12: mark the request approved - conditional UPDATE, same
    // concurrency guard as reviewAccountRecoveryRequest/approveWalletTopup.
    // Two admins approving simultaneously: the LOSER's transaction blocks
    // on the Step 1 FOR UPDATE lock until the winner commits, then re-reads
    // status="approved" and fails closed here - it never reaches step 7,
    // and never moves the identity twice.
    const transitioned = await db.transitionAccountRecoveryRequestStatus(
      {
        id: params.requestId,
        fromStatuses: ["pending"],
        toStatus: "approved",
        reviewedByAdminId: params.adminId,
        reviewReason: params.reason.trim(),
        sourceUserId,
        targetUserId,
      },
      tx
    );
    if (!transitioned) {
      throw new AccountRecoveryError("ALREADY_PROCESSED", "This recovery request has already been processed");
    }

    // Step 13: audit log - never the Google sub itself (providerSubject),
    // never a token/cookie, just the reason and the row ids involved.
    await db.insertAccountRecoveryAuditLog(
      {
        recoveryRequestId: params.requestId,
        actorAdminId: params.adminId,
        action: "approved",
        sourceUserId,
        targetUserId,
        authIdentityId: identityRow.id,
        safeMetadata: { reason: params.reason.trim() },
      },
      tx
    );

    const updatedRequest = await db.getAccountRecoveryRequestById(params.requestId, tx);
    if (!updatedRequest) throw new Error("[AccountRecovery] Request disappeared mid-transaction");

    // Step 14 (commit) is implicit - returning normally here lets
    // database.transaction() commit; any throw above already rolled
    // everything back.
    return { request: updatedRequest, assessment };
  });
}
