import { and, desc, eq, sql } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeDataReconciliations,
  accountMergeFinancialReconciliations,
  accountRecoveryRequests,
} from "../../drizzle/schema";
import { isAccountMergeConfirmationExact } from "../../shared/accountMergeConfirmation";
import * as db from "../db";
import { buildAccountMergePreview } from "./accountMergePreviewService";
import { reconcileAccountMergeFinancialsInTransaction } from "./accountMergeFinancialReconciliationService";
import { reconcileAccountMergeDataInTransaction } from "./accountMergeDataReconciliationService";

export type AccountMergeOrchestrationFaultPoint =
  | "after_preview"
  | "after_guard_start"
  | "after_financial"
  | "after_data"
  | "after_auth_move"
  | "before_complete";

let orchestrationFaultForTests: AccountMergeOrchestrationFaultPoint | null =
  null;

export class AccountMergeOrchestrationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AccountMergeOrchestrationError";
  }
}

/** Test-only deterministic fault injection for proving one outer rollback boundary. */
export function __setAccountMergeOrchestrationFaultForTests(
  point: AccountMergeOrchestrationFaultPoint | null
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Account Merge orchestration fault injection is test-only");
  }
  orchestrationFaultForTests = point;
}

function maybeInjectFault(point: AccountMergeOrchestrationFaultPoint): void {
  if (orchestrationFaultForTests === point) {
    throw new Error(`Injected Account Merge orchestration failure at ${point}`);
  }
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AccountMergeOrchestrationError(
      "INVALID_ARGUMENT",
      `${fieldName} must be a positive integer`
    );
  }
}

function unwrapRows(raw: any): any[] {
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Array.isArray(rows) ? rows : [];
}

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountMergeOrchestrationError(
      "AUDIT_WRITE_FAILED",
      "Unable to read persisted audit id"
    );
  }
  return id;
}

function parseSafeSummary(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    throw new AccountMergeOrchestrationError(
      "CORRUPT_RECEIPT",
      "Persisted merge receipt summary is not valid JSON"
    );
  }
}

async function readFinancialReceipt(caseId: number, tx: any) {
  return (
    await tx
      .select()
      .from(accountMergeFinancialReconciliations)
      .where(eq(accountMergeFinancialReconciliations.mergeCaseId, caseId))
      .limit(1)
  )[0];
}

async function readDataReceipt(caseId: number, tx: any) {
  return (
    await tx
      .select()
      .from(accountMergeDataReconciliations)
      .where(eq(accountMergeDataReconciliations.mergeCaseId, caseId))
      .limit(1)
  )[0];
}

async function readCompletionAudit(caseId: number, tx: any) {
  return (
    await tx
      .select()
      .from(accountMergeAuditLogs)
      .where(
        and(
          eq(accountMergeAuditLogs.mergeCaseId, caseId),
          eq(accountMergeAuditLogs.action, "merge_completed")
        )
      )
      .orderBy(desc(accountMergeAuditLogs.id))
      .limit(1)
  )[0];
}

function financialDto(receipt: any) {
  return {
    wallet: {
      sourceBefore: String(receipt.walletSourceBefore),
      targetBefore: String(receipt.walletTargetBefore),
      transferred: String(receipt.walletTransferred),
      sourceAfter: String(receipt.walletSourceAfter),
      targetAfter: String(receipt.walletTargetAfter),
    },
    points: {
      sourceBefore: String(receipt.pointsSourceBefore),
      targetBefore: String(receipt.pointsTargetBefore),
      transferred: String(receipt.pointsTransferred),
      sourceAfter: String(receipt.pointsSourceAfter),
      targetAfter: String(receipt.pointsTargetAfter),
    },
  };
}

async function completedResult(
  caseRow: any,
  tx: any,
  alreadyCompleted: boolean
) {
  const caseId = Number(caseRow.id);
  const sourceUserId = Number(caseRow.sourceUserId);
  const targetUserId = Number(caseRow.targetUserId);
  const [
    financialReceipt,
    dataReceipt,
    completionAudit,
    sourceIdentity,
    targetIdentity,
  ] = await Promise.all([
    readFinancialReceipt(caseId, tx),
    readDataReceipt(caseId, tx),
    readCompletionAudit(caseId, tx),
    db.getAuthIdentityByUserAndProvider(sourceUserId, "google", tx),
    db.getAuthIdentityByUserAndProvider(targetUserId, "google", tx),
  ]);

  if (
    !financialReceipt ||
    !dataReceipt ||
    !completionAudit ||
    sourceIdentity ||
    !targetIdentity
  ) {
    throw new AccountMergeOrchestrationError(
      "INCONSISTENT_COMPLETION",
      "Completed merge is missing durable receipts/audit or has inconsistent Google identity ownership"
    );
  }

  const completionMetadata = parseSafeSummary(completionAudit.safeMetadata);
  return {
    alreadyCompleted,
    mergeCaseId: caseId,
    requestId: Number(caseRow.originAccountRecoveryRequestId),
    sourceUserId,
    targetUserId,
    status: "completed" as const,
    completedAt: caseRow.completedAt ?? null,
    auditLogId: Number(completionAudit.id),
    financial: financialDto(financialReceipt),
    dataSummary: parseSafeSummary(dataReceipt.safeSummary),
    tableActions: Array.isArray(completionMetadata.tableActions)
      ? completionMetadata.tableActions
      : [],
    paymentSlipClaimsPreserved: Number(
      completionMetadata.paymentSlipClaimsPreserved ?? 0
    ),
    identityMoved: true as const,
  };
}

export async function getAccountMergeExecutionStatus(requestId: number) {
  assertPositiveInteger(requestId, "requestId");
  const database = await db.getDb();
  if (!database)
    throw new AccountMergeOrchestrationError(
      "DATABASE_UNAVAILABLE",
      "Database unavailable"
    );

  const rows = await database
    .select()
    .from(accountMergeCases)
    .where(eq(accountMergeCases.originAccountRecoveryRequestId, requestId))
    .orderBy(desc(accountMergeCases.id));
  const caseRow =
    rows.find((row: any) => row.status !== "cancelled") ?? rows[0];
  if (!caseRow) return null;
  if (caseRow.status === "completed") {
    return database.transaction((tx: any) =>
      completedResult(caseRow, tx, true)
    );
  }
  return {
    mergeCaseId: Number(caseRow.id),
    requestId,
    sourceUserId: Number(caseRow.sourceUserId),
    targetUserId: Number(caseRow.targetUserId),
    status: String(caseRow.status),
    completedAt: caseRow.completedAt ?? null,
  };
}

export async function executeAccountMerge(params: {
  requestId: number;
  targetUserId: number;
  adminId: number;
  reason: string;
  confirmation: string;
}) {
  assertPositiveInteger(params.requestId, "requestId");
  assertPositiveInteger(params.targetUserId, "targetUserId");
  assertPositiveInteger(params.adminId, "adminId");
  const reason = params.reason?.trim();
  if (!reason)
    throw new AccountMergeOrchestrationError(
      "INVALID_ARGUMENT",
      "A merge reason is required"
    );

  await db.assertDatabaseAvailable();
  const database = await db.getDb();
  if (!database)
    throw new AccountMergeOrchestrationError(
      "DATABASE_UNAVAILABLE",
      "Database unavailable"
    );

  return database.transaction(async (tx: any) => {
    // Lock the historical recovery request first. Source identity is always
    // derived from this persisted BLOCKED request; clients can never supply it.
    const requestRows = unwrapRows(
      await tx.execute(
        sql`SELECT id, requesterUserId, status FROM accountRecoveryRequests WHERE id = ${params.requestId} FOR UPDATE`
      )
    );
    const requestRow = requestRows[0];
    if (!requestRow)
      throw new AccountMergeOrchestrationError(
        "REQUEST_NOT_FOUND",
        "Recovery request not found"
      );
    if (requestRow.status !== "blocked") {
      throw new AccountMergeOrchestrationError(
        "REQUEST_NOT_BLOCKED",
        "Advanced Account Merge requires a BLOCKED recovery request"
      );
    }

    const sourceUserId = Number(requestRow.requesterUserId);
    const targetUserId = params.targetUserId;
    if (
      !isAccountMergeConfirmationExact(
        sourceUserId,
        targetUserId,
        params.confirmation
      )
    ) {
      throw new AccountMergeOrchestrationError(
        "CONFIRMATION_MISMATCH",
        "Typed Source-to-Target confirmation does not match this merge"
      );
    }

    // Canonical lock hierarchy: request -> participant users ascending ->
    // merge-case -> domain rows. The request lock serializes double-clicks for
    // this exact workflow while user locks protect cross-request collisions.
    await db.lockAccountMergeUserRows([sourceUserId, targetUserId], tx);
    const sourceCases = await db.getAccountMergeCasesForSourceForUpdate(
      sourceUserId,
      tx
    );
    let caseRow = sourceCases.find((row: any) => row.status !== "cancelled");

    if (caseRow) {
      if (
        Number(caseRow.originAccountRecoveryRequestId) !== params.requestId ||
        Number(caseRow.targetUserId) !== targetUserId
      ) {
        throw new AccountMergeOrchestrationError(
          "SOURCE_ALREADY_GUARDED",
          "Source account already belongs to a different active merge case"
        );
      }
      if (caseRow.status === "completed") {
        return completedResult(caseRow, tx, true);
      }
      if (caseRow.status === "failed") {
        throw new AccountMergeOrchestrationError(
          "FAILED_CASE",
          "Failed merge case requires explicit review before retry"
        );
      }
    }

    // Lock Google identity ownership BEFORE the final read-only preview. A
    // target that connected Google since the admin previewed moments ago is a
    // final-snapshot drift and fails before any reconciliation write.
    const identityRows = unwrapRows(
      await tx.execute(
        sql`SELECT id, userId, provider, emailAtLink FROM authIdentities WHERE provider = 'google' AND userId IN (${sourceUserId}, ${targetUserId}) ORDER BY userId, id FOR UPDATE`
      )
    );
    const sourceIdentity = identityRows.find(
      (row: any) => Number(row.userId) === sourceUserId
    );
    const targetIdentity = identityRows.find(
      (row: any) => Number(row.userId) === targetUserId
    );

    const preview = await buildAccountMergePreview(
      { requestId: params.requestId, sourceUserId, targetUserId },
      tx
    );
    if (
      !preview.isPreviewValid ||
      !preview.targetValidation.isValid ||
      !sourceIdentity ||
      targetIdentity
    ) {
      throw new AccountMergeOrchestrationError(
        "FINAL_PREVIEW_BLOCKED",
        preview.targetValidation.blockers.join("; ") ||
          "Final locked preview is no longer mergeable"
      );
    }
    maybeInjectFault("after_preview");

    if (!caseRow) {
      const inserted: any = await tx.insert(accountMergeCases).values({
        originAccountRecoveryRequestId: params.requestId,
        sourceUserId,
        targetUserId,
        status: "pending",
        createdByAdminId: params.adminId,
      });
      const caseId = Number(inserted?.[0]?.insertId ?? inserted?.insertId);
      if (!Number.isInteger(caseId) || caseId <= 0) {
        throw new AccountMergeOrchestrationError(
          "CASE_CREATE_FAILED",
          "Unable to create merge case"
        );
      }
      caseRow = (
        await tx
          .select()
          .from(accountMergeCases)
          .where(eq(accountMergeCases.id, caseId))
          .limit(1)
      )[0];
      await tx.insert(accountMergeAuditLogs).values({
        mergeCaseId: caseId,
        actorAdminId: params.adminId,
        action: "guard_prepared",
        sourceUserId,
        targetUserId,
        safeMetadata: JSON.stringify({ requestId: params.requestId }),
      });
    }

    const caseId = Number(caseRow.id);
    // Re-lock exact case after creation/reuse and reject legacy partial Phase
    // receipts. Continuing such a case would be safe mathematically but could
    // not truthfully claim Phase-5's one-transaction atomicity.
    const lockedCaseRows = unwrapRows(
      await tx.execute(
        sql`SELECT * FROM accountMergeCases WHERE id = ${caseId} FOR UPDATE`
      )
    );
    caseRow = lockedCaseRows[0];
    if (!caseRow)
      throw new AccountMergeOrchestrationError(
        "CASE_NOT_FOUND",
        "Merge case disappeared"
      );

    const [preexistingFinancial, preexistingData] = await Promise.all([
      readFinancialReceipt(caseId, tx),
      readDataReceipt(caseId, tx),
    ]);
    if (preexistingFinancial || preexistingData) {
      throw new AccountMergeOrchestrationError(
        "PARTIAL_RECONCILIATION_STATE",
        "Merge case contains reconciliation receipts from a prior standalone phase and cannot claim atomic final execution"
      );
    }

    if (caseRow.status === "pending") {
      const now = new Date();
      await tx
        .update(accountMergeCases)
        .set({
          status: "in_progress",
          startedAt: now,
          failedAt: null,
          failureReason: null,
        })
        .where(
          and(
            eq(accountMergeCases.id, caseId),
            eq(accountMergeCases.status, "pending")
          )
        );
      await tx.insert(accountMergeAuditLogs).values({
        mergeCaseId: caseId,
        actorAdminId: params.adminId,
        action: "guard_started",
        sourceUserId,
        targetUserId,
        safeMetadata: JSON.stringify({ requestId: params.requestId }),
      });
      caseRow = { ...caseRow, status: "in_progress", startedAt: now };
    }
    if (caseRow.status !== "in_progress") {
      throw new AccountMergeOrchestrationError(
        "CASE_NOT_IN_PROGRESS",
        `Final execution requires pending/in_progress case, got ${String(caseRow.status)}`
      );
    }
    maybeInjectFault("after_guard_start");

    const financial = await reconcileAccountMergeFinancialsInTransaction(
      { caseId, actorAdminId: params.adminId },
      tx
    );
    maybeInjectFault("after_financial");

    const data = await reconcileAccountMergeDataInTransaction(
      { caseId, actorAdminId: params.adminId },
      tx
    );
    maybeInjectFault("after_data");

    // Auth move is deliberately LAST after every economic/user-data phase.
    // The row was locked before the final preview and this CAS additionally
    // requires it still belongs to Source at the write itself.
    const moved = await db.moveAuthIdentityOwner(
      {
        authIdentityId: Number(sourceIdentity.id),
        expectedCurrentUserId: sourceUserId,
        targetUserId,
      },
      tx
    );
    if (!moved) {
      throw new AccountMergeOrchestrationError(
        "AUTH_MOVE_CONFLICT",
        "Google identity ownership changed during merge"
      );
    }
    await db.finalizeAccountRecoveryTargetUser(
      { targetUserId, fallbackEmail: sourceIdentity.emailAtLink ?? null },
      tx
    );
    maybeInjectFault("after_auth_move");
    maybeInjectFault("before_complete");

    const now = new Date();
    const transitionResult: any = await tx
      .update(accountMergeCases)
      .set({
        status: "completed",
        completedAt: now,
        failedAt: null,
        failureReason: null,
      })
      .where(
        and(
          eq(accountMergeCases.id, caseId),
          eq(accountMergeCases.status, "in_progress")
        )
      );
    const transitionHeader = Array.isArray(transitionResult)
      ? transitionResult[0]
      : transitionResult;
    if (Number(transitionHeader?.affectedRows ?? 0) !== 1) {
      throw new AccountMergeOrchestrationError(
        "CASE_TRANSITION_CONFLICT",
        "Merge case completion transition lost a race"
      );
    }

    const tableActions = preview.tableFindings.map(finding => ({
      table: finding.table,
      sourceCount: finding.sourceCount,
      targetCount: finding.targetCount,
      conflictCount: finding.conflictCount,
      projectedAction: finding.projectedAction,
    }));
    const safeMetadata = {
      reason,
      identityMoved: true,
      financial: financialDto(financial.reconciliation),
      dataSummary: parseSafeSummary(data.reconciliation.safeSummary),
      tableActions,
      paymentSlipClaimsPreserved: preview.paymentSlipClaims.sourceCount,
    };
    const auditInsert: any = await tx.insert(accountMergeAuditLogs).values({
      mergeCaseId: caseId,
      actorAdminId: params.adminId,
      action: "merge_completed",
      sourceUserId,
      targetUserId,
      safeMetadata: JSON.stringify(safeMetadata),
    });
    const auditLogId = insertId(auditInsert);

    return {
      alreadyCompleted: false,
      mergeCaseId: caseId,
      requestId: params.requestId,
      sourceUserId,
      targetUserId,
      status: "completed" as const,
      completedAt: now,
      auditLogId,
      financial: financialDto(financial.reconciliation),
      dataSummary: parseSafeSummary(data.reconciliation.safeSummary),
      tableActions,
      paymentSlipClaimsPreserved: preview.paymentSlipClaims.sourceCount,
      identityMoved: true as const,
    };
  });
}
