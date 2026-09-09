import * as db from "../db";
import {
  AccountMergeOrchestrationError,
  getAccountMergeExecutionStatus,
} from "./accountMergeOrchestrationService";

export type AccountRecoveryPersistedStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "blocked";

export type AccountRecoveryEffectiveStatus =
  | AccountRecoveryPersistedStatus
  | "resolved_via_advanced_merge";

export type AccountRecoveryLifecycleIntegrity =
  | "not_applicable"
  | "unresolved"
  | "verified"
  | "inconsistent";

export type AccountRecoveryLifecycleProjection = {
  persistedStatus: AccountRecoveryPersistedStatus;
  effectiveStatus: AccountRecoveryEffectiveStatus;
  resolutionKind: "advanced_account_merge" | null;
  integrity: AccountRecoveryLifecycleIntegrity;
  integrityIssue:
    | "MULTIPLE_NON_CANCELLED_MERGE_CASES"
    | "MERGE_ROLE_MISMATCH"
    | "COMPLETION_EVIDENCE_INCONSISTENT"
    | null;
  mergeCaseId: number | null;
  mergeCaseStatus: string | null;
  completedAt: Date | string | null;
  auditLogId: number | null;
};

type RecoveryRequestLike = {
  id: number;
  requesterUserId: number;
  status: string;
};

function normalizePersistedStatus(status: string): AccountRecoveryPersistedStatus {
  if (["pending", "approved", "rejected", "cancelled", "blocked"].includes(status)) {
    return status as AccountRecoveryPersistedStatus;
  }
  // The DB column is enum-backed, so this should be unreachable. Treat any
  // unexpected runtime value as blocked-like rather than presenting success.
  return "blocked";
}

function projection(
  persistedStatus: AccountRecoveryPersistedStatus,
  overrides: Partial<AccountRecoveryLifecycleProjection> = {}
): AccountRecoveryLifecycleProjection {
  return {
    persistedStatus,
    effectiveStatus: persistedStatus,
    resolutionKind: null,
    integrity: persistedStatus === "blocked" ? "unresolved" : "not_applicable",
    integrityIssue: null,
    mergeCaseId: null,
    mergeCaseStatus: null,
    completedAt: null,
    auditLogId: null,
    ...overrides,
  };
}

/**
 * Read-only lifecycle projection for Account Recovery.
 *
 * A BLOCKED recovery request remains BLOCKED in accountRecoveryRequests as
 * historical provenance. Only when exactly one non-cancelled Advanced Merge
 * case exists and the orchestration service can re-prove the completed case's
 * financial/data/completion receipts plus final Google identity ownership do
 * we expose the derived status `resolved_via_advanced_merge`.
 *
 * Any ambiguous/partial/inconsistent state fails closed to the persisted
 * BLOCKED status. This function performs no write and never changes the
 * recovery request row merely to improve presentation.
 */
export async function buildAccountRecoveryLifecycleProjection(
  request: RecoveryRequestLike
): Promise<AccountRecoveryLifecycleProjection> {
  const persistedStatus = normalizePersistedStatus(String(request.status));
  if (persistedStatus !== "blocked") {
    return projection(persistedStatus);
  }

  const cases = await db.listAccountMergeCasesForRecoveryRequest(Number(request.id));
  const nonCancelled = (cases as any[]).filter(row => String(row.status) !== "cancelled");

  if (nonCancelled.length === 0) {
    return projection(persistedStatus);
  }

  if (nonCancelled.length !== 1) {
    return projection(persistedStatus, {
      integrity: "inconsistent",
      integrityIssue: "MULTIPLE_NON_CANCELLED_MERGE_CASES",
    });
  }

  const mergeCase = nonCancelled[0];
  const mergeCaseId = Number(mergeCase.id);
  const mergeCaseStatus = String(mergeCase.status);
  const sourceUserId = Number(mergeCase.sourceUserId);
  const targetUserId = Number(mergeCase.targetUserId);
  const originRequestId = Number(mergeCase.originAccountRecoveryRequestId);

  if (
    originRequestId !== Number(request.id) ||
    sourceUserId !== Number(request.requesterUserId) ||
    !Number.isInteger(targetUserId) ||
    targetUserId <= 0 ||
    sourceUserId === targetUserId
  ) {
    return projection(persistedStatus, {
      integrity: "inconsistent",
      integrityIssue: "MERGE_ROLE_MISMATCH",
      mergeCaseId,
      mergeCaseStatus,
      completedAt: mergeCase.completedAt ?? null,
    });
  }

  if (mergeCaseStatus !== "completed") {
    return projection(persistedStatus, {
      mergeCaseId,
      mergeCaseStatus,
      completedAt: mergeCase.completedAt ?? null,
    });
  }

  try {
    const completed = await getAccountMergeExecutionStatus(Number(request.id));
    if (
      !completed ||
      completed.status !== "completed" ||
      Number(completed.mergeCaseId) !== mergeCaseId ||
      Number(completed.requestId) !== Number(request.id) ||
      Number(completed.sourceUserId) !== Number(request.requesterUserId) ||
      Number(completed.targetUserId) !== targetUserId ||
      !("auditLogId" in completed) ||
      !Number.isInteger(Number(completed.auditLogId)) ||
      Number(completed.auditLogId) <= 0
    ) {
      return projection(persistedStatus, {
        integrity: "inconsistent",
        integrityIssue: "COMPLETION_EVIDENCE_INCONSISTENT",
        mergeCaseId,
        mergeCaseStatus,
        completedAt: mergeCase.completedAt ?? null,
      });
    }

    return projection(persistedStatus, {
      effectiveStatus: "resolved_via_advanced_merge",
      resolutionKind: "advanced_account_merge",
      integrity: "verified",
      mergeCaseId,
      mergeCaseStatus: "completed",
      completedAt: completed.completedAt ?? mergeCase.completedAt ?? null,
      auditLogId: Number(completed.auditLogId),
    });
  } catch (error) {
    if (error instanceof AccountMergeOrchestrationError) {
      return projection(persistedStatus, {
        integrity: "inconsistent",
        integrityIssue: "COMPLETION_EVIDENCE_INCONSISTENT",
        mergeCaseId,
        mergeCaseStatus,
        completedAt: mergeCase.completedAt ?? null,
      });
    }
    throw error;
  }
}
