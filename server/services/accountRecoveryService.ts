import { sql } from "drizzle-orm";
import * as db from "../db";
import type { AccountRecoveryEconomicDataFinding } from "../db";
import type { AccountRecoveryRequest } from "../../drizzle/schema";
import { accountRecoveryRoleAuditMetadata, bindAccountRecoveryRoles } from "./accountRecoveryRoles";

/**
 * Central safety/execution logic for the Admin Account Recovery workflow.
 * The currently signed-in requester is the Survivor/canonical account and
 * keeps its Google identity. The inaccessible legacy account selected by an
 * admin is the Donor; Simple Recovery is allowed only when that Donor has no
 * recoverable data, while Advanced Merge reconciles Donor data into Survivor.
 * Every rule this feature's task
 * spec enumerates is enforced HERE, once, and reused by both the read-only
 * admin-detail-page preview (assessAccountRecoverySafety) and the actual
 * transactional approval (executeAccountRecovery) - never duplicated
 * per-caller.
 *
 * Two hard requirements this file exists specifically to satisfy:
 * - Never use a claimed/typed email, openId, or user id as identity evidence.
 *   The Survivor's Google ownership is proven only by a fresh authIdentities
 *   row, never by the recovery request's user-submitted legacy fields.
 * - Never let an admin replace the current requester as canonical Survivor.
 *   `survivorAccountId` must exactly equal the locked requester's user id;
 *   only the inaccessible Donor is selected by the admin.
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
  /** Database-verified identity state for both merge participants. Under the
   * requester-as-Survivor invariant, Source/Donor must be null and
   * Target/Survivor must be non-null. Neither value is sourced from request
   * claims, and neither raw identity object may cross the tRPC boundary. */
  sourceGoogleIdentity: { id: number; providerSubject: string; emailAtLink: string } | null;
  targetGoogleIdentity: { id: number; providerSubject: string; emailAtLink: string } | null;
  targetHasGoogleIdentity: boolean;
  /** Category A ("Economic/Entitlement data") - wallet/points/purchases/
   *  orders/payments/transactions/coupons. ANY finding here is an
   *  unconditional, no-override block; see blockReasons. */
  economicDataFindings: AccountRecoveryEconomicDataFinding[];
  /**
   * Category B ("User-owned data") - cart/cartItems, wishlist/library,
   * reading progress, check-ins, and any other user-linked table not
   * itself economic (see server/services/accountRecoveryDataClassification.ts's
   * ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION for the full, exhaustively
   * audited list). As of the empty-source-account invariant, this is ALSO
   * an unconditional, no-override block, exactly like Category A - never
   * merged/migrated by this tool, never left for the admin to "accept the
   * risk" on. Automated recovery is only ever permitted when the source
   * account is genuinely, completely empty. Still surfaced separately from
   * economicDataFindings (rather than merged into one list) so the admin
   * UI and the audit trail can distinguish "financial risk" from "user
   * convenience data at risk" even though both now block identically.
   */
  userOwnedDataFindings: AccountRecoveryEconomicDataFinding[];
  /** Non-empty means approval MUST be refused, with no admin override -
   *  the request can only become "blocked" (Advanced Account Merge
   *  required outside this tool), never "approved". Populated from BOTH
   *  economicDataFindings and userOwnedDataFindings (plus every other
   *  hard-block rule) - there is no longer a class of finding that can
   *  produce a non-empty warnings-only, still-approvable result. */
  blockReasons: string[];
  /** Human-readable elaboration of blockReasons for the admin UI (what
   *  specifically was found) - NOT a separate, lower-severity channel
   *  anymore. A non-empty warnings array always corresponds to a non-empty
   *  blockReasons array; canApprove must be checked, never warnings alone. */
  warnings: string[];
  /** True only when EVERY check passes: no block reasons, no economic
   *  data, no user-owned data. */
  canApprove: boolean;
  /** As of the empty-source-account invariant, identical to canApprove -
   *  kept as a separate field for API stability and because it documents
   *  intent (this specific request qualifies for the fully-automated path)
   *  rather than being a synonym maintained by convention alone. */
  isFullyAutomatable: boolean;
};

/**
 * The ONLY shape of an assessment that may ever cross the tRPC boundary to
 * an admin's browser - see toSafeAdminAssessmentDto below. Deliberately
 * excludes AccountRecoverySafetyAssessment's raw Google identity objects
 * entirely (they carry the Google `sub`/providerSubject and full linked
 * email addresses). The admin UI only needs boolean ownership state. No token,
 * cookie, or Authorization-header data is ever
 * part of an assessment in the first place (assessAccountRecoverySafety
 * never reads any of those), so there is nothing further to strip there.
 */
export type AccountRecoverySafetyAssessmentDto = {
  requestId: number;
  sourceUserId: number;
  targetUserId: number;
  sourceExists: boolean;
  targetExists: boolean;
  sourceIsAdmin: boolean;
  targetIsAdmin: boolean;
  /** Replaces the internal assessment's sourceGoogleIdentity object -
   *  never the identity's id, providerSubject, or emailAtLink. */
  sourceHasGoogleIdentity: boolean;
  targetHasGoogleIdentity: boolean;
  economicDataFindings: AccountRecoveryEconomicDataFinding[];
  userOwnedDataFindings: AccountRecoveryEconomicDataFinding[];
  blockReasons: string[];
  warnings: string[];
  canApprove: boolean;
  isFullyAutomatable: boolean;
};

/**
 * Converts an internal, service-layer-only AccountRecoverySafetyAssessment
 * into the safe DTO above - the router MUST call this before returning an
 * assessment from any procedure (see server/routers.ts's
 * accountRecovery.admin.previewApproval). Never call this on the client
 * side or export it to anywhere outside the server process - it exists
 * purely to define the router/service boundary within the server.
 */
export function toSafeAdminAssessmentDto(
  assessment: AccountRecoverySafetyAssessment
): AccountRecoverySafetyAssessmentDto {
  const { sourceGoogleIdentity, targetGoogleIdentity, ...rest } = assessment;
  return {
    ...rest,
    sourceHasGoogleIdentity: Boolean(sourceGoogleIdentity),
    targetHasGoogleIdentity: Boolean(targetGoogleIdentity),
  };
}

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

  // Requester/Survivor ownership is verified from the real authIdentities row,
  // never from claimed legacy fields. The inaccessible Source/Donor must not
  // own another Google identity; Target/Survivor must keep the identity used
  // by the current requester session.
  const sourceIdentity = sourceExists
    ? await db.getAuthIdentityByUserAndProvider(sourceUserId, "google", dbOrTx)
    : undefined;
  if (sourceIdentity) {
    blockReasons.push("Donor account already has a linked Google identity - identity ownership is ambiguous");
  }

  const targetIdentity = targetExists
    ? await db.getAuthIdentityByUserAndProvider(targetUserId, "google", dbOrTx)
    : undefined;
  const targetHasGoogleIdentity = Boolean(targetIdentity);
  if (!targetHasGoogleIdentity) {
    blockReasons.push("Survivor requester has no linked Google identity - cannot preserve the active login account");
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
    // Empty-source-account invariant: user-owned data is now an
    // unconditional block, identical in effect to economic data - this PR
    // never moves or merges user-owned data, and never deletes the source
    // user, so approval simply cannot proceed while any exists. Also
    // recorded in `warnings` so the admin UI keeps a human-readable
    // breakdown of *why* (never rely on warnings alone for the gate -
    // canApprove is authoritative).
    blockReasons.push(
      `Source account has user-owned data (${userOwnedDataFindings.map((f) => f.table).join(", ")}) that would be left behind - automated recovery requires a genuinely empty source account; use Advanced Account Merge instead`
    );
    warnings.push(
      `Source account has data that would be left behind (${userOwnedDataFindings.map((f) => f.table).join(", ")}) - never auto-moved or merged by this tool`
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
    targetGoogleIdentity: targetIdentity
      ? { id: targetIdentity.id, providerSubject: targetIdentity.providerSubject, emailAtLink: targetIdentity.emailAtLink }
      : null,
    targetHasGoogleIdentity,
    economicDataFindings,
    userOwnedDataFindings,
    blockReasons,
    warnings,
    canApprove,
    // Equivalent to canApprove under the empty-source-account invariant -
    // every finding that used to be warnings-only now also blocks, so
    // there is no remaining state where canApprove is true but the
    // request isn't fully automatable. Computed independently (not just
    // aliased) so a future finding category that intentionally warns
    // without blocking cannot silently make this drift from canApprove
    // without a test catching it.
    isFullyAutomatable: blockReasons.length === 0 && economicDataFindings.length === 0 && userOwnedDataFindings.length === 0,
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
 * Terminates one historical BLOCKED duplicate request after an admin has
 * identified a newer canonical request for the same requester. This is the
 * only supported blocked -> cancelled transition: it is deliberately NOT a
 * generic reopen/review helper, and it never touches auth identity, users,
 * merge/reconciliation data, or the canonical request itself.
 *
 * Safety contract:
 * - duplicate and canonical ids must be distinct positive ids;
 * - both requests must exist and belong to the exact same requester;
 * - the duplicate must still be blocked and must have no persisted
 *   source/target participants or merge case of its own;
 * - the canonical request must be newer, still blocked, and own exactly one
 *   completed Advanced Account Merge case;
 * - the final write is a blocked/requester-bound CAS; a race fails closed;
 * - state change and append-only audit row commit atomically.
 */
export async function supersedeDuplicateAccountRecoveryRequest(params: {
  duplicateRequestId: number;
  canonicalRequestId: number;
  actorAdminId: number;
  reason: string;
}): Promise<AccountRecoveryRequest> {
  if (!params.reason || !params.reason.trim()) {
    throw new AccountRecoveryError("FORBIDDEN", "A reason is required");
  }
  if (
    !Number.isInteger(params.duplicateRequestId) ||
    params.duplicateRequestId <= 0 ||
    !Number.isInteger(params.canonicalRequestId) ||
    params.canonicalRequestId <= 0 ||
    params.duplicateRequestId === params.canonicalRequestId
  ) {
    throw new AccountRecoveryError("UNSAFE", "Duplicate and canonical recovery request ids must be distinct positive ids");
  }
  if (!Number.isInteger(params.actorAdminId) || params.actorAdminId <= 0) {
    throw new AccountRecoveryError("FORBIDDEN", "A valid admin actor is required");
  }

  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  return database.transaction(async (tx: any) => {
    const lockedRequests = new Map<number, AccountRecoveryRequest>();
    for (const requestId of [params.duplicateRequestId, params.canonicalRequestId].sort((a, b) => a - b)) {
      const row = await db.getAccountRecoveryRequestByIdForUpdate(requestId, tx);
      if (row) lockedRequests.set(requestId, row as AccountRecoveryRequest);
    }
    const duplicate = lockedRequests.get(params.duplicateRequestId);
    const canonical = lockedRequests.get(params.canonicalRequestId);
    if (!duplicate || !canonical) {
      throw new AccountRecoveryError("NOT_FOUND", "Duplicate or canonical recovery request does not exist");
    }
    if (duplicate.status !== "blocked") {
      throw new AccountRecoveryError("ALREADY_PROCESSED", "Duplicate recovery request is no longer blocked");
    }
    if (canonical.status !== "blocked") {
      throw new AccountRecoveryError("UNSAFE", "Canonical recovery request must still be blocked after Advanced Merge completion");
    }
    if (Number(duplicate.requesterUserId) !== Number(canonical.requesterUserId)) {
      throw new AccountRecoveryError("UNSAFE", "Duplicate and canonical recovery requests belong to different requesters");
    }
    if (duplicate.sourceUserId !== null || duplicate.targetUserId !== null) {
      throw new AccountRecoveryError("UNSAFE", "Duplicate recovery request already has persisted recovery participants");
    }

    const duplicateCreatedAt = new Date(duplicate.createdAt).getTime();
    const canonicalCreatedAt = new Date(canonical.createdAt).getTime();
    if (
      !Number.isFinite(duplicateCreatedAt) ||
      !Number.isFinite(canonicalCreatedAt) ||
      canonicalCreatedAt <= duplicateCreatedAt
    ) {
      throw new AccountRecoveryError("UNSAFE", "Canonical recovery request must be newer than the duplicate request");
    }

    const [duplicateMergeCases, canonicalMergeCases] = await Promise.all([
      db.listAccountMergeCasesForRecoveryRequest(params.duplicateRequestId, tx),
      db.listAccountMergeCasesForRecoveryRequest(params.canonicalRequestId, tx),
    ]);
    if (duplicateMergeCases.length > 0) {
      throw new AccountRecoveryError("UNSAFE", "Duplicate recovery request already owns an Account Merge case");
    }
    if (canonicalMergeCases.length !== 1 || String(canonicalMergeCases[0]?.status) !== "completed") {
      throw new AccountRecoveryError(
        "UNSAFE",
        "Canonical recovery request must own exactly one completed Account Merge case"
      );
    }

    const reason = params.reason.trim();
    const transitioned = await db.supersedeBlockedAccountRecoveryRequest(
      {
        id: params.duplicateRequestId,
        expectedRequesterUserId: Number(duplicate.requesterUserId),
        reviewedByAdminId: params.actorAdminId,
        reviewReason: reason,
      },
      tx
    );
    if (!transitioned) {
      throw new AccountRecoveryError("ALREADY_PROCESSED", "Duplicate recovery request changed before reconciliation completed");
    }

    await db.insertAccountRecoveryAuditLog(
      {
        recoveryRequestId: params.duplicateRequestId,
        actorAdminId: params.actorAdminId,
        action: "cancelled",
        safeMetadata: {
          reason,
          resolution: "superseded_duplicate",
          supersededByRequestId: params.canonicalRequestId,
          canonicalRequestStatus: canonical.status,
        },
      },
      tx
    );

    const updated = await db.getAccountRecoveryRequestById(params.duplicateRequestId, tx);
    if (!updated) throw new Error("[AccountRecovery] Superseded request disappeared mid-transaction");
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
 * The admin selects only the inaccessible Donor. The requester's own user id
 * is the Survivor and is rebound from the locked request row before any write.
 * A compromised client therefore cannot redirect recovery into a different
 * canonical account, and Google identity ownership is never moved away from
 * the requester.
 */
export async function executeAccountRecovery(params: {
  requestId: number;
  donorAccountId: number;
  survivorAccountId: number;
  adminId: number;
  reason: string;
}): Promise<{ request: AccountRecoveryRequest; assessment: AccountRecoverySafetyAssessment }> {
  if (!params.reason || !params.reason.trim()) {
    throw new AccountRecoveryError("FORBIDDEN", "A reason is required to approve an account recovery request");
  }
  if (!Number.isInteger(params.donorAccountId) || params.donorAccountId <= 0) {
    throw new AccountRecoveryError("FORBIDDEN", "A valid donor account id is required");
  }
  if (!Number.isInteger(params.survivorAccountId) || params.survivorAccountId <= 0) {
    throw new AccountRecoveryError("FORBIDDEN", "A valid survivor account id is required");
  }
  if (params.donorAccountId === params.survivorAccountId) {
    throw new AccountRecoveryError("UNSAFE", "Donor and Survivor must be different accounts");
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

    const roleBinding = bindAccountRecoveryRoles({
      requesterUserId: Number(requestRow.requesterUserId),
      donorAccountId: params.donorAccountId,
      survivorAccountId: params.survivorAccountId,
    });
    if (!roleBinding.valid) {
      throw new AccountRecoveryError(
        "UNSAFE",
        roleBinding.failure === "SURVIVOR_REQUESTER_MISMATCH"
          ? "Survivor must be the exact account that created this recovery request"
          : "Invalid Donor/Survivor role binding"
      );
    }

    // Storage keeps the historical source/target column names for schema
    // compatibility. At the execution boundary their meaning is explicit:
    // source == Donor, target == Survivor.
    const sourceUserId = roleBinding.donorAccountId;
    const targetUserId = roleBinding.survivorAccountId;

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

    // Step 4: lock the requester's/Survivor's Google identity row. It must
    // already belong to Target and will remain there; Simple Recovery never
    // moves identity ownership under requester-as-Survivor semantics.
    const identityRows = unwrapRows(
      await tx.execute(
        sql`SELECT * FROM authIdentities WHERE userId = ${targetUserId} AND provider = 'google' FOR UPDATE`
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
    if (
      !identityRow ||
      assessment.sourceGoogleIdentity !== null ||
      identityRow.id !== assessment.targetGoogleIdentity?.id
    ) {
      // Reconcile the locked identity row with the fresh safety assessment.
      // Any drift fails closed; ownership is never moved away from Survivor.
      throw new AccountRecoveryError("UNSAFE", "Survivor Google identity changed - please re-review this request");
    }

    // Identity ownership intentionally stays on Target/Survivor. Simple
    // Recovery is therefore a provenance/status transition only and is safe
    // only when the Donor is already empty of recoverable data.

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
        safeMetadata: {
          reason: params.reason.trim(),
          ...accountRecoveryRoleAuditMetadata({
            donorAccountId: sourceUserId,
            survivorAccountId: targetUserId,
          }),
          identityMoved: false,
          identityPreservedOnSurvivor: true,
        },
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
