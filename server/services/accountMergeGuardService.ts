import { and, eq, sql } from "drizzle-orm";
import { accountMergeAuditLogs, accountMergeCases } from "../../drizzle/schema";
import * as db from "../db";

export type AccountMergeLifecycleStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export class AccountMergeLifecycleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AccountMergeLifecycleError";
  }
}

type AccountMergeLifecycleFaultPoint = "after_case_insert" | "after_transition_update";
let lifecycleFaultForTests: AccountMergeLifecycleFaultPoint | null = null;

/** Test-only deterministic fault injection for proving transaction rollback. */
export function __setAccountMergeLifecycleFaultForTests(point: AccountMergeLifecycleFaultPoint | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Account Merge lifecycle fault injection is test-only");
  }
  lifecycleFaultForTests = point;
}

function maybeInjectLifecycleFault(point: AccountMergeLifecycleFaultPoint): void {
  if (lifecycleFaultForTests === point) {
    throw new Error(`Injected Account Merge lifecycle failure at ${point}`);
  }
}

function unwrapRows(raw: any): any[] {
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Array.isArray(rows) ? rows : [];
}

async function lockRecoveryRequest(requestId: number, tx: any) {
  const rows = unwrapRows(
    await tx.execute(
      sql`SELECT id, requesterUserId, status FROM accountRecoveryRequests WHERE id = ${requestId} FOR UPDATE`
    )
  );
  return rows[0];
}

async function lockMergeCase(caseId: number, tx: any) {
  const rows = unwrapRows(
    await tx.execute(
      sql`SELECT id, originAccountRecoveryRequestId, sourceUserId, targetUserId, status, createdByAdminId, startedAt, completedAt, failedAt, failureReason, cancelledAt, cancelReason FROM accountMergeCases WHERE id = ${caseId} FOR UPDATE`
    )
  );
  return rows[0];
}

async function readMergeCase(caseId: number, database: any) {
  const rows = await database.select().from(accountMergeCases).where(eq(accountMergeCases.id, caseId)).limit(1);
  return rows[0];
}

async function validatePairingUnderLock(sourceUserId: number, targetUserId: number, tx: any): Promise<void> {
  if (sourceUserId === targetUserId) {
    throw new AccountMergeLifecycleError("SAME_ACCOUNT", "Source and target must be different accounts");
  }

  const [source, target] = await Promise.all([
    db.getUserById(sourceUserId, tx),
    db.getUserById(targetUserId, tx),
  ]);
  if (!source || !target) {
    throw new AccountMergeLifecycleError("ACCOUNT_NOT_FOUND", "Source or target account no longer exists");
  }
  if (source.role === "admin" || target.role === "admin") {
    throw new AccountMergeLifecycleError("ADMIN_ACCOUNT", "Admin accounts cannot participate in account merge");
  }

  const [sourceIdentity, targetIdentity] = await Promise.all([
    db.getAuthIdentityByUserAndProvider(sourceUserId, "google", tx),
    db.getAuthIdentityByUserAndProvider(targetUserId, "google", tx),
  ]);
  if (!sourceIdentity) {
    throw new AccountMergeLifecycleError("SOURCE_IDENTITY_MISSING", "Source Google identity is no longer linked");
  }
  if (targetIdentity) {
    throw new AccountMergeLifecycleError("TARGET_IDENTITY_PRESENT", "Target already has a Google identity");
  }
}

async function appendLifecycleAudit(
  tx: any,
  input: {
    mergeCaseId: number;
    actorAdminId: number;
    action: string;
    sourceUserId: number;
    targetUserId: number;
    safeMetadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.insert(accountMergeAuditLogs).values({
    mergeCaseId: input.mergeCaseId,
    actorAdminId: input.actorAdminId,
    action: input.action,
    sourceUserId: input.sourceUserId,
    targetUserId: input.targetUserId,
    safeMetadata: input.safeMetadata ? JSON.stringify(input.safeMetadata) : null,
  });
}

/**
 * Prepare a durable merge case. Source is derived only from the locked
 * BLOCKED Account Recovery request. The Source + Target users rows are then
 * locked in ascending id order before the merge-case guard is inspected or
 * created. `pending` is already a guarded state, so a classified Source write
 * can never slip between prepare and a later start/snapshot.
 */
export async function prepareAccountMergeGuard(params: {
  requestId: number;
  targetUserId: number;
  actorAdminId: number;
}) {
  const database = await db.getDb();
  if (!database) throw new AccountMergeLifecycleError("DATABASE_UNAVAILABLE", "Database unavailable");

  return database.transaction(async (tx: any) => {
    // Match Account Recovery's request-first hierarchy; start/complete never
    // acquire the recovery-request row, so this cannot form a request/user cycle.
    const request = await lockRecoveryRequest(params.requestId, tx);
    if (!request) throw new AccountMergeLifecycleError("REQUEST_NOT_FOUND", "Account Recovery request not found");
    if (request.status !== "blocked") {
      throw new AccountMergeLifecycleError("REQUEST_NOT_BLOCKED", "Only a BLOCKED Account Recovery request can be merged");
    }

    const sourceUserId = Number(request.requesterUserId);
    await db.lockAccountMergeUserRows([sourceUserId, params.targetUserId], tx);
    await validatePairingUnderLock(sourceUserId, params.targetUserId, tx);

    const existingCases = await db.getAccountMergeCasesForSourceForUpdate(sourceUserId, tx);
    const nonCancelled = existingCases.filter((row: any) => row.status !== "cancelled");
    if (nonCancelled.length > 1) {
      throw new AccountMergeLifecycleError("INCONSISTENT_GUARD_STATE", "Multiple guarded merge cases exist for Source");
    }
    if (nonCancelled.length === 1) {
      const existing = nonCancelled[0];
      if (
        Number(existing.originAccountRecoveryRequestId) === params.requestId &&
        Number(existing.targetUserId) === params.targetUserId
      ) {
        // Retried prepare after a lost response: both durable representations
        // must already agree. Never accept an old case row while the new
        // account-mutation guard points elsewhere (or is missing).
        await db.assertAccountMutationGuardBoundToMergeCase(sourceUserId, Number(existing.id), tx);
        // Never append a second audit event for a no-op retry.
        return existing;
      }
      throw new AccountMergeLifecycleError("SOURCE_ALREADY_GUARDED", "Source already belongs to another merge case");
    }

    const insertResult: any = await tx.insert(accountMergeCases).values({
      originAccountRecoveryRequestId: params.requestId,
      sourceUserId,
      targetUserId: params.targetUserId,
      status: "pending",
      createdByAdminId: params.actorAdminId,
    });
    const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    const mergeCaseId = Number(header?.insertId ?? insertResult?.insertId);
    if (!Number.isInteger(mergeCaseId) || mergeCaseId <= 0) {
      throw new AccountMergeLifecycleError("CASE_CREATE_FAILED", "Unable to create merge case");
    }

    // Publish the dedicated guard in the SAME transaction as the case row.
    // The Source guard was locked exclusively before the legacy users rows,
    // so no bridged V1 mutation or another merge can observe an intermediate
    // state. Generation advances exactly once for open -> merge_guarded.
    await db.activateAccountMutationGuardForMerge(sourceUserId, mergeCaseId, tx);

    maybeInjectLifecycleFault("after_case_insert");

    await appendLifecycleAudit(tx, {
      mergeCaseId,
      actorAdminId: params.actorAdminId,
      action: "guard_prepared",
      sourceUserId,
      targetUserId: params.targetUserId,
      safeMetadata: { fromStatus: null, toStatus: "pending" },
    });

    return await readMergeCase(mergeCaseId, tx);
  });
}

async function transitionGuardCase(params: {
  caseId: number;
  actorAdminId: number;
  transition: "start" | "complete" | "fail" | "cancel";
  reason?: string;
}) {
  const database = await db.getDb();
  if (!database) throw new AccountMergeLifecycleError("DATABASE_UNAVAILABLE", "Database unavailable");

  const initial = await readMergeCase(params.caseId, database);
  if (!initial) throw new AccountMergeLifecycleError("CASE_NOT_FOUND", "Account merge case not found");

  return database.transaction(async (tx: any) => {
    // Same Source/Target users-row hierarchy as prepare and all classified
    // mutations. The case row is always locked only AFTER both user rows.
    await db.lockAccountMergeUserRows([initial.sourceUserId, initial.targetUserId], tx);
    const current = await lockMergeCase(params.caseId, tx);
    if (!current) throw new AccountMergeLifecycleError("CASE_NOT_FOUND", "Account merge case not found");
    if (
      Number(current.sourceUserId) !== Number(initial.sourceUserId) ||
      Number(current.targetUserId) !== Number(initial.targetUserId)
    ) {
      throw new AccountMergeLifecycleError("INCONSISTENT_CASE", "Merge case participants changed unexpectedly");
    }

    const status = current.status as AccountMergeLifecycleStatus;
    if (status !== "cancelled") {
      // Every still-guarded legacy case must remain bound to the exact new
      // accountMutationGuards row before privileged lifecycle work proceeds.
      await db.assertAccountMutationGuardBoundToMergeCase(
        Number(current.sourceUserId),
        params.caseId,
        tx
      );
    }
    const now = new Date();
    let nextStatus: AccountMergeLifecycleStatus;
    let updates: Record<string, unknown>;
    let action: string;

    if (params.transition === "start") {
      if (status === "in_progress" || status === "completed") return current;
      if (status !== "pending") {
        throw new AccountMergeLifecycleError("INVALID_START_STATE", `Cannot start merge case from ${status}`);
      }
      nextStatus = "in_progress";
      updates = { status: nextStatus, startedAt: now, failedAt: null, failureReason: null };
      action = "guard_started";
    } else if (params.transition === "complete") {
      if (status === "completed") return current;
      if (status !== "in_progress") {
        throw new AccountMergeLifecycleError("INVALID_COMPLETE_STATE", `Cannot complete merge case from ${status}`);
      }
      nextStatus = "completed";
      updates = { status: nextStatus, completedAt: now };
      action = "guard_completed";
    } else if (params.transition === "fail") {
      if (status === "failed") return current;
      if (status !== "in_progress") {
        throw new AccountMergeLifecycleError("INVALID_FAIL_STATE", `Cannot fail merge case from ${status}`);
      }
      const reason = params.reason?.trim();
      if (!reason) throw new AccountMergeLifecycleError("REASON_REQUIRED", "Failure reason is required");
      nextStatus = "failed";
      updates = { status: nextStatus, failedAt: now, failureReason: reason };
      action = "guard_failed";
    } else {
      if (status === "cancelled") return current;
      if (status !== "pending") {
        // Never release an in-progress/failed/completed guard. Later phases may
        // have already made partial progress; releasing it would permit stale
        // Source writes into an unknown state.
        throw new AccountMergeLifecycleError("INVALID_CANCEL_STATE", `Cannot cancel merge case from ${status}`);
      }
      const reason = params.reason?.trim();
      if (!reason) throw new AccountMergeLifecycleError("REASON_REQUIRED", "Cancellation reason is required");
      nextStatus = "cancelled";
      updates = { status: nextStatus, cancelledAt: now, cancelReason: reason };
      action = "guard_cancelled";
    }

    const updateResult: any = await tx
      .update(accountMergeCases)
      .set(updates)
      .where(and(eq(accountMergeCases.id, params.caseId), eq(accountMergeCases.status, status as any)));
    const header = Array.isArray(updateResult) ? updateResult[0] : updateResult;
    if ((header?.affectedRows ?? 0) !== 1) {
      throw new AccountMergeLifecycleError("STATE_RACE", "Merge case state changed while transition was in progress");
    }

    if (params.transition === "cancel") {
      // Cancellation is the only release transition. The case update and
      // guard open/generation increment commit or roll back together.
      await db.releaseAccountMutationGuardFromMerge(
        Number(current.sourceUserId),
        params.caseId,
        tx
      );
    }

    maybeInjectLifecycleFault("after_transition_update");

    await appendLifecycleAudit(tx, {
      mergeCaseId: params.caseId,
      actorAdminId: params.actorAdminId,
      action,
      sourceUserId: Number(current.sourceUserId),
      targetUserId: Number(current.targetUserId),
      safeMetadata: {
        fromStatus: status,
        toStatus: nextStatus,
        ...(params.reason ? { reason: params.reason.trim() } : {}),
      },
    });

    return await readMergeCase(params.caseId, tx);
  });
}

export function startAccountMergeGuard(caseId: number, actorAdminId: number) {
  return transitionGuardCase({ caseId, actorAdminId, transition: "start" });
}

/** Internal lifecycle hooks for later execution phases and focused IPE-005 tests. */
export function completeAccountMergeGuard(caseId: number, actorAdminId: number) {
  return transitionGuardCase({ caseId, actorAdminId, transition: "complete" });
}

export function failAccountMergeGuard(caseId: number, actorAdminId: number, reason: string) {
  return transitionGuardCase({ caseId, actorAdminId, transition: "fail", reason });
}

export function cancelAccountMergeGuard(caseId: number, actorAdminId: number, reason: string) {
  return transitionGuardCase({ caseId, actorAdminId, transition: "cancel", reason });
}
