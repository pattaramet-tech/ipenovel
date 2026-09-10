import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeCompensationAuditLogs,
  accountMergeCompensationDedupeRecords,
  accountMergeCompensationReceipts,
  accountMergeCompensations,
  accountMergeDataDedupeRecords,
  accountMergeDataReconciliations,
  accountMergeFinancialReconciliations,
  accountRecoveryRequests,
  authIdentities,
  carts,
  dailyCheckinRewardGrants,
  dailyCheckins,
  episodePurchases,
  orders,
  pointsTransactions,
  purchases,
  readingProgress,
  topupLogs,
  walletAccounts,
  walletTopups,
  walletTransactions,
} from "../../drizzle/schema";
import * as db from "../db";
import {
  IPE007_FINANCIAL_HISTORY_TABLES,
  IPE007_HANDLED_DIRECT_TABLES,
  IPE007_HANDLED_INDIRECT_TABLES,
  IPE007_PRESERVED_VIA_ORDER_TABLES,
  reconcileAccountMergeOwnedDataCore,
} from "./accountMergeDataReconciliationService";
import {
  addNonNegativeFixedDecimals,
  minorUnitsToDecimal,
  type FixedDecimalSpec,
} from "./accountMergeFinancialMath";

const SNAPSHOT_VERSION = "historical-account-merge-compensation-snapshot-v1" as const;
const FINANCIAL_REFERENCE_TYPE = "account_merge_compensation";
const EXECUTION_ENABLED_ENV = "ACCOUNT_MERGE_HISTORICAL_COMPENSATION_EXECUTION_ENABLED";
const EXECUTION_SCOPE_ENV = "ACCOUNT_MERGE_HISTORICAL_COMPENSATION_SCOPE";
const AUTHORIZED_EXECUTION_SCOPE = "90007:1:21960193:763680006:5370059";
const WALLET_SPEC: FixedDecimalSpec = { precision: 12, scale: 2 };
const POINTS_SPEC: FixedDecimalSpec = { precision: 10, scale: 2 };
const TRANSFERABLE_TABLES = new Set<string>([
  ...IPE007_HANDLED_DIRECT_TABLES,
  ...IPE007_HANDLED_INDIRECT_TABLES,
  ...IPE007_PRESERVED_VIA_ORDER_TABLES,
]);
const PRESERVED_FINANCIAL_TABLES = new Set<string>(IPE007_FINANCIAL_HISTORY_TABLES);

export type HistoricalAccountMergeCompensationStatus = "pending" | "in_progress" | "completed" | "failed";
export type HistoricalAccountMergeCompensationInput = {
  recoveryRequestId: number;
  historicalMergeCaseId: number;
  donorUserId: number;
  survivorUserId: number;
  googleIdentityId: number;
};
export type ExecuteHistoricalAccountMergeCompensationInput = HistoricalAccountMergeCompensationInput & {
  expectedSnapshotDigest: string;
  actorAdminId: number;
};
export type HistoricalAccountMergeCompensationRefusal = { code: string; message: string };

export class HistoricalAccountMergeCompensationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HistoricalAccountMergeCompensationError";
  }
}

type CompensationFaultPoint =
  | "after_identity_move"
  | "after_financial_compensation"
  | "after_data_reconciliation"
  | "after_receipt_commit";
let compensationFaultForTests: CompensationFaultPoint | null = null;

export function __setHistoricalAccountMergeCompensationFaultForTests(point: CompensationFaultPoint | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Historical compensation fault injection is test-only");
  compensationFaultForTests = point;
}
function maybeInjectFault(point: CompensationFaultPoint): void {
  if (compensationFaultForTests === point) {
    throw new HistoricalAccountMergeCompensationError(
      point === "after_receipt_commit" ? "RESPONSE_LOST_AFTER_COMMIT" : "INJECTED_CRASH",
      `Injected historical compensation fault at ${point}`
    );
  }
}
function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HistoricalAccountMergeCompensationError("INVALID_ARGUMENT", `${fieldName} must be a positive integer`);
  }
}
function validateIdentityInput(input: HistoricalAccountMergeCompensationInput): void {
  assertPositiveInteger(input.recoveryRequestId, "recoveryRequestId");
  assertPositiveInteger(input.historicalMergeCaseId, "historicalMergeCaseId");
  assertPositiveInteger(input.donorUserId, "donorUserId");
  assertPositiveInteger(input.survivorUserId, "survivorUserId");
  assertPositiveInteger(input.googleIdentityId, "googleIdentityId");
  if (input.donorUserId === input.survivorUserId) {
    throw new HistoricalAccountMergeCompensationError("INVALID_ROLE_BINDING", "Donor and Survivor must be different accounts");
  }
}
function executionScope(input: HistoricalAccountMergeCompensationInput): string {
  return [
    input.recoveryRequestId,
    input.historicalMergeCaseId,
    input.donorUserId,
    input.survivorUserId,
    input.googleIdentityId,
  ].join(":");
}
function assertExecutionAuthorized(input: HistoricalAccountMergeCompensationInput): void {
  if (process.env[EXECUTION_ENABLED_ENV] !== "true") {
    throw new HistoricalAccountMergeCompensationError(
      "EXECUTION_DISABLED",
      `Historical Account Merge compensation execution is disabled; set ${EXECUTION_ENABLED_ENV}=true only in an explicitly authorized Preview/disposable environment`
    );
  }
  const expectedScope = executionScope(input);
  if (expectedScope !== AUTHORIZED_EXECUTION_SCOPE || process.env[EXECUTION_SCOPE_ENV] !== AUTHORIZED_EXECUTION_SCOPE) {
    throw new HistoricalAccountMergeCompensationError(
      "EXECUTION_SCOPE_MISMATCH",
      `Historical Account Merge compensation scope is not authorized for this exact incident`
    );
  }
}
function unwrapRows(raw: any): any[] {
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Array.isArray(rows) ? rows : [];
}
function affectedRows(raw: any): number {
  const header = Array.isArray(raw) ? raw[0] : raw;
  return Number(header?.affectedRows ?? raw?.affectedRows ?? 0);
}
function assertLifecycleCas(raw: any, transition: string): void {
  if (affectedRows(raw) !== 1) {
    throw new HistoricalAccountMergeCompensationError(
      "COMPENSATION_STATE_CAS_FAILED",
      `Historical compensation lifecycle CAS failed during ${transition}`
    );
  }
}
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}
function digestJson(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function decimalEquals(left: unknown, right: unknown, spec: FixedDecimalSpec): boolean {
  try {
    const l = addNonNegativeFixedDecimals(String(left), "0.00", "left", spec);
    const r = addNonNegativeFixedDecimals(String(right), "0.00", "right", spec);
    return l.leftMinor === r.leftMinor;
  } catch {
    return false;
  }
}
function isZeroDecimal(value: unknown, spec: FixedDecimalSpec): boolean {
  return decimalEquals(value, "0.00", spec);
}

async function readCase(caseId: number, database: any, lock: boolean): Promise<any | undefined> {
  if (lock) {
    await database.execute(sql`SELECT id FROM accountMergeCases WHERE id = ${caseId} LIMIT 1 FOR UPDATE`);
  }
  const rows = await database.select().from(accountMergeCases).where(eq(accountMergeCases.id, caseId)).limit(1);
  return rows[0];
}
async function readRequest(requestId: number, database: any, lock: boolean): Promise<any | undefined> {
  if (lock) {
    await database.execute(sql`SELECT id FROM accountRecoveryRequests WHERE id = ${requestId} LIMIT 1 FOR UPDATE`);
  }
  const rows = await database
    .select({
      id: accountRecoveryRequests.id,
      requesterUserId: accountRecoveryRequests.requesterUserId,
      status: accountRecoveryRequests.status,
      sourceUserId: accountRecoveryRequests.sourceUserId,
      targetUserId: accountRecoveryRequests.targetUserId,
      createdAt: accountRecoveryRequests.createdAt,
      updatedAt: accountRecoveryRequests.updatedAt,
    })
    .from(accountRecoveryRequests)
    .where(eq(accountRecoveryRequests.id, requestId))
    .limit(1);
  return rows[0];
}
async function readParticipantGoogleIdentities(
  input: HistoricalAccountMergeCompensationInput,
  database: any,
  lock: boolean
): Promise<Array<{ id: number; userId: number; provider: string }>> {
  if (lock) {
    return unwrapRows(
      await database.execute(sql`SELECT id, userId, provider FROM authIdentities WHERE provider = 'google' AND (id = ${input.googleIdentityId} OR userId IN (${input.donorUserId}, ${input.survivorUserId})) ORDER BY id FOR UPDATE`)
    ).map((row: any) => ({ id: Number(row.id), userId: Number(row.userId), provider: String(row.provider) }));
  }
  const rows = await database
    .select({ id: authIdentities.id, userId: authIdentities.userId, provider: authIdentities.provider })
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, "google"),
        or(eq(authIdentities.id, input.googleIdentityId), inArray(authIdentities.userId, [input.donorUserId, input.survivorUserId]))
      )
    )
    .orderBy(asc(authIdentities.id));
  return rows.map((row: any) => ({ id: Number(row.id), userId: Number(row.userId), provider: String(row.provider) }));
}
async function readCompensationForCase(historicalMergeCaseId: number, database: any, lock: boolean) {
  if (lock) {
    return unwrapRows(
      await database.execute(sql`SELECT id, historicalMergeCaseId, recoveryRequestId, donorUserId, survivorUserId, googleIdentityId, status, expectedSnapshotDigest, createdByAdminId, startedAt, completedAt, failedAt, failureReason, createdAt, updatedAt FROM accountMergeCompensations WHERE historicalMergeCaseId = ${historicalMergeCaseId} LIMIT 1 FOR UPDATE`)
    )[0];
  }
  const rows = await database.select().from(accountMergeCompensations).where(eq(accountMergeCompensations.historicalMergeCaseId, historicalMergeCaseId)).limit(1);
  return rows[0];
}
async function readCompensationReceipt(compensationId: number, database: any, lock: boolean) {
  if (lock) {
    return unwrapRows(
      await database.execute(sql`SELECT id, compensationId, historicalMergeCaseId, recoveryRequestId, donorUserId, survivorUserId, googleIdentityId, expectedSnapshotDigest, beforeSnapshot, afterSnapshot, actionCounts, financialProof, createdAt FROM accountMergeCompensationReceipts WHERE compensationId = ${compensationId} LIMIT 1 FOR UPDATE`)
    )[0];
  }
  const rows = await database.select().from(accountMergeCompensationReceipts).where(eq(accountMergeCompensationReceipts.compensationId, compensationId)).limit(1);
  return rows[0];
}
async function readWorkflowConflicts(input: HistoricalAccountMergeCompensationInput, database: any, lock: boolean) {
  let caseRows: any[];
  let requestRows: any[];
  if (lock) {
    caseRows = unwrapRows(
      await database.execute(sql`SELECT id, status FROM accountMergeCases WHERE id <> ${input.historicalMergeCaseId} AND status <> 'cancelled' AND (sourceUserId IN (${input.donorUserId}, ${input.survivorUserId}) OR targetUserId IN (${input.donorUserId}, ${input.survivorUserId})) ORDER BY id FOR UPDATE`)
    );
    requestRows = unwrapRows(
      await database.execute(sql`SELECT id, status FROM accountRecoveryRequests WHERE id <> ${input.recoveryRequestId} AND status IN ('pending', 'blocked', 'approved') AND (requesterUserId IN (${input.donorUserId}, ${input.survivorUserId}) OR sourceUserId IN (${input.donorUserId}, ${input.survivorUserId}) OR targetUserId IN (${input.donorUserId}, ${input.survivorUserId})) ORDER BY id FOR UPDATE`)
    );
  } else {
    const [cases, requests] = await Promise.all([
      db.listAccountMergeCasesForParticipants([input.donorUserId, input.survivorUserId], database),
      db.listAccountRecoveryRequestsForParticipants([input.donorUserId, input.survivorUserId], database),
    ]);
    caseRows = (cases as any[]).filter(row => Number(row.id) !== input.historicalMergeCaseId && String(row.status) !== "cancelled");
    requestRows = (requests as any[]).filter(row => Number(row.id) !== input.recoveryRequestId && ["pending", "blocked", "approved"].includes(String(row.status)));
  }
  return {
    mergeCaseIds: caseRows.map(row => Number(row.id)).sort((a, b) => a - b),
    recoveryRequestIds: requestRows.map(row => Number(row.id)).sort((a, b) => a - b),
  };
}
async function readHistoricalImmutableEvidence(
  input: HistoricalAccountMergeCompensationInput,
  historicalCase: any,
  database: any
) {
  const completedAt = new Date(historicalCase?.completedAt as any);
  if (!Number.isFinite(completedAt.getTime())) {
    return {
      dataDedupeCount: 0,
      dataDedupeDigest: digestJson([]),
      walletTransactionCount: 0,
      walletTransactionDigest: digestJson([]),
      walletTopupCount: 0,
      walletTopupDigest: digestJson([]),
      pointsTransactionCount: 0,
      pointsTransactionDigest: digestJson([]),
      topupLogCount: 0,
      topupLogDigest: digestJson([]),
    };
  }
  const participantIds = [input.donorUserId, input.survivorUserId];
  const [dedupes, walletTxRows, walletTopupRows, pointsTxRows, topupLogRows] = await Promise.all([
    database
      .select()
      .from(accountMergeDataDedupeRecords)
      .where(eq(accountMergeDataDedupeRecords.mergeCaseId, input.historicalMergeCaseId))
      .orderBy(asc(accountMergeDataDedupeRecords.id)),
    database
      .select()
      .from(walletTransactions)
      .where(and(inArray(walletTransactions.userId, participantIds), lte(walletTransactions.createdAt, completedAt)))
      .orderBy(asc(walletTransactions.id)),
    database
      .select()
      .from(walletTopups)
      .where(and(inArray(walletTopups.userId, participantIds), lte(walletTopups.createdAt, completedAt)))
      .orderBy(asc(walletTopups.id)),
    database
      .select()
      .from(pointsTransactions)
      .where(and(inArray(pointsTransactions.userId, participantIds), lte(pointsTransactions.createdAt, completedAt)))
      .orderBy(asc(pointsTransactions.id)),
    database
      .select()
      .from(topupLogs)
      .where(and(inArray(topupLogs.userId, participantIds), lte(topupLogs.createdAt, completedAt)))
      .orderBy(asc(topupLogs.id)),
  ]);
  return {
    dataDedupeCount: dedupes.length,
    dataDedupeDigest: digestJson(dedupes),
    walletTransactionCount: walletTxRows.length,
    walletTransactionDigest: digestJson(walletTxRows),
    walletTopupCount: walletTopupRows.length,
    walletTopupDigest: digestJson(walletTopupRows),
    pointsTransactionCount: pointsTxRows.length,
    pointsTransactionDigest: digestJson(pointsTxRows),
    topupLogCount: topupLogRows.length,
    topupLogDigest: digestJson(topupLogRows),
  };
}

async function readHistoricalEvidence(caseId: number, database: any) {
  const [financialRows, dataRows, auditRows] = await Promise.all([
    database.select().from(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, caseId)).limit(2),
    database.select().from(accountMergeDataReconciliations).where(eq(accountMergeDataReconciliations.mergeCaseId, caseId)).limit(2),
    database
      .select({
        id: accountMergeAuditLogs.id,
        action: accountMergeAuditLogs.action,
        sourceUserId: accountMergeAuditLogs.sourceUserId,
        targetUserId: accountMergeAuditLogs.targetUserId,
        safeMetadata: accountMergeAuditLogs.safeMetadata,
        createdAt: accountMergeAuditLogs.createdAt,
      })
      .from(accountMergeAuditLogs)
      .where(eq(accountMergeAuditLogs.mergeCaseId, caseId))
      .orderBy(asc(accountMergeAuditLogs.id)),
  ]);
  const financial = financialRows[0] as any | undefined;
  const data = dataRows[0] as any | undefined;
  const financialSafe = financial
    ? {
        id: Number(financial.id),
        mergeCaseId: Number(financial.mergeCaseId),
        sourceUserId: Number(financial.sourceUserId),
        targetUserId: Number(financial.targetUserId),
        walletSourceBefore: String(financial.walletSourceBefore),
        walletTargetBefore: String(financial.walletTargetBefore),
        walletTransferred: String(financial.walletTransferred),
        walletSourceAfter: String(financial.walletSourceAfter),
        walletTargetAfter: String(financial.walletTargetAfter),
        pointsSourceBefore: String(financial.pointsSourceBefore),
        pointsTargetBefore: String(financial.pointsTargetBefore),
        pointsTransferred: String(financial.pointsTransferred),
        pointsSourceAfter: String(financial.pointsSourceAfter),
        pointsTargetAfter: String(financial.pointsTargetAfter),
        createdAt: toIso(financial.createdAt),
      }
    : null;
  const dataSafe = data
    ? {
        id: Number(data.id),
        mergeCaseId: Number(data.mergeCaseId),
        sourceUserId: Number(data.sourceUserId),
        targetUserId: Number(data.targetUserId),
        safeSummaryDigest: digestJson(String(data.safeSummary)),
        createdAt: toIso(data.createdAt),
      }
    : null;
  const auditSafe = (auditRows as any[]).map(row => ({
    id: Number(row.id),
    action: String(row.action),
    sourceUserId: row.sourceUserId == null ? null : Number(row.sourceUserId),
    targetUserId: row.targetUserId == null ? null : Number(row.targetUserId),
    safeMetadataDigest: row.safeMetadata == null ? null : digestJson(String(row.safeMetadata)),
    createdAt: toIso(row.createdAt),
  }));
  return {
    financialReceiptCount: financialRows.length,
    financialReceipt: financialSafe,
    dataReceiptCount: dataRows.length,
    dataReceipt: dataSafe,
    mergeAuditCount: auditSafe.length,
    mergeAuditDigest: digestJson(auditSafe),
    completionAuditCount: auditSafe.filter(row => row.action === "merge_completed").length,
  };
}
async function countRowsAfter(database: any, table: any, userColumn: any, timeColumn: any, userId: number, completedAt: Date) {
  const rows = await database.select({ value: count() }).from(table).where(and(eq(userColumn, userId), gt(timeColumn, completedAt)));
  return Number(rows[0]?.value ?? 0);
}
async function readPostMergeActivity(donorUserId: number, survivorUserId: number, completedAtRaw: unknown, database: any) {
  const completedAt = new Date(completedAtRaw as any);
  if (!Number.isFinite(completedAt.getTime())) return [];
  const checks = [
    ["orders", orders, orders.userId, orders.updatedAt],
    ["purchases", purchases, purchases.userId, purchases.createdAt],
    ["episodePurchases", episodePurchases, episodePurchases.userId, episodePurchases.createdAt],
    ["walletTransactions", walletTransactions, walletTransactions.userId, walletTransactions.createdAt],
    ["walletTopups", walletTopups, walletTopups.userId, walletTopups.updatedAt],
    ["pointsTransactions", pointsTransactions, pointsTransactions.userId, pointsTransactions.createdAt],
    ["readingProgress", readingProgress, readingProgress.userId, readingProgress.updatedAt],
    ["carts", carts, carts.userId, carts.updatedAt],
    ["dailyCheckins", dailyCheckins, dailyCheckins.userId, dailyCheckins.updatedAt],
    ["dailyCheckinRewardGrants", dailyCheckinRewardGrants, dailyCheckinRewardGrants.userId, dailyCheckinRewardGrants.createdAt],
  ] as const;
  const rows: Array<{ table: string; donorCount: number; survivorCount: number }> = [];
  for (const [tableName, table, userColumn, timeColumn] of checks) {
    const [donorCount, survivorCount] = await Promise.all([
      countRowsAfter(database, table, userColumn, timeColumn, donorUserId, completedAt),
      countRowsAfter(database, table, userColumn, timeColumn, survivorUserId, completedAt),
    ]);
    rows.push({ table: tableName, donorCount, survivorCount });
  }
  return rows;
}
async function readSnapshotAfterPrelude(input: HistoricalAccountMergeCompensationInput, database: any, options: { lockRelatedRows: boolean; historicalCase: any }) {
  const request = await readRequest(input.recoveryRequestId, database, options.lockRelatedRows);
  const identities = await readParticipantGoogleIdentities(input, database, options.lockRelatedRows);
  const conflicts = await readWorkflowConflicts(input, database, options.lockRelatedRows);
  const [
    inventory,
    donorWallet,
    survivorWallet,
    donorPoints,
    survivorPoints,
    historicalEvidence,
    historicalImmutableEvidence,
  ] = await Promise.all([
    db.findAccountMergeTableInventory(input.donorUserId, input.survivorUserId, database),
    db.getAccountMergeWalletBalance(input.donorUserId, database),
    db.getAccountMergeWalletBalance(input.survivorUserId, database),
    db.getAccountMergePointsBalance(input.donorUserId, database),
    db.getAccountMergePointsBalance(input.survivorUserId, database),
    readHistoricalEvidence(input.historicalMergeCaseId, database),
    readHistoricalImmutableEvidence(input, options.historicalCase, database),
  ]);
  const postMergeActivity = await readPostMergeActivity(input.donorUserId, input.survivorUserId, options.historicalCase?.completedAt, database);
  const normalizedInventory = (inventory as any[])
    .map(row => ({ table: String(row.table), category: String(row.category), donorCount: Number(row.sourceCount), survivorCount: Number(row.targetCount), conflictCount: Number(row.conflictCount) }))
    .sort((a, b) => a.table.localeCompare(b.table));
  const walletTotal = addNonNegativeFixedDecimals(String(donorWallet), String(survivorWallet), "currentWalletTotal", WALLET_SPEC).sum;
  const pointsTotal = addNonNegativeFixedDecimals(String(donorPoints), String(survivorPoints), "currentPointsTotal", POINTS_SPEC).sum;
  return {
    version: SNAPSHOT_VERSION,
    roles: { donorUserId: input.donorUserId, survivorUserId: input.survivorUserId, recoveryRequestId: input.recoveryRequestId, historicalMergeCaseId: input.historicalMergeCaseId, googleIdentityId: input.googleIdentityId },
    request: request ? { id: Number(request.id), requesterUserId: Number(request.requesterUserId), status: String(request.status), sourceUserId: request.sourceUserId == null ? null : Number(request.sourceUserId), targetUserId: request.targetUserId == null ? null : Number(request.targetUserId), createdAt: toIso(request.createdAt), updatedAt: toIso(request.updatedAt) } : null,
    historicalCase: options.historicalCase ? { id: Number(options.historicalCase.id), originAccountRecoveryRequestId: Number(options.historicalCase.originAccountRecoveryRequestId), sourceUserId: Number(options.historicalCase.sourceUserId), targetUserId: Number(options.historicalCase.targetUserId), status: String(options.historicalCase.status), completedAt: toIso(options.historicalCase.completedAt), createdAt: toIso(options.historicalCase.createdAt), updatedAt: toIso(options.historicalCase.updatedAt) } : null,
    googleIdentities: identities,
    financial: { donorWallet: String(donorWallet), survivorWallet: String(survivorWallet), walletTotal, donorPoints: String(donorPoints), survivorPoints: String(survivorPoints), pointsTotal },
    ownershipInventory: normalizedInventory,
    postMergeActivity,
    conflicts,
    historicalEvidence,
    historicalImmutableEvidence,
  };
}
async function readUnlockedSnapshot(input: HistoricalAccountMergeCompensationInput, database: any) {
  const historicalCase = await readCase(input.historicalMergeCaseId, database, false);
  return readSnapshotAfterPrelude(input, database, { lockRelatedRows: false, historicalCase });
}
type HistoricalCompensationSnapshot = Awaited<ReturnType<typeof readUnlockedSnapshot>>;

function validateHistoricalBeforeSnapshot(snapshot: HistoricalCompensationSnapshot): HistoricalAccountMergeCompensationRefusal[] {
  const refusals: HistoricalAccountMergeCompensationRefusal[] = [];
  const refuse = (code: string, message: string) => refusals.push({ code, message });
  const { roles, request, historicalCase, googleIdentities, financial, historicalEvidence } = snapshot;
  if (!request) refuse("REQUEST_NOT_FOUND", "Recovery request does not exist");
  else {
    if (request.requesterUserId !== roles.survivorUserId) refuse("REQUESTER_DRIFT", "Recovery requester is not the canonical Survivor");
    if (request.status !== "blocked") refuse("REQUEST_STATUS_DRIFT", `Recovery request is ${request.status}, expected blocked`);
    if (request.sourceUserId !== null || request.targetUserId !== null) refuse("REQUEST_PARTICIPANT_DRIFT", "Historical blocked request sourceUserId/targetUserId must remain NULL");
  }
  if (!historicalCase) refuse("HISTORICAL_CASE_NOT_FOUND", "Historical merge case does not exist");
  else {
    if (historicalCase.originAccountRecoveryRequestId !== roles.recoveryRequestId) refuse("HISTORICAL_CASE_REQUEST_DRIFT", "Historical case no longer belongs to the recovery request");
    if (historicalCase.sourceUserId !== roles.survivorUserId || historicalCase.targetUserId !== roles.donorUserId) refuse("HISTORICAL_ROLE_DRIFT", "Historical case does not match the expected reversed Source/Target role fact");
    if (historicalCase.status !== "completed" || !historicalCase.completedAt) refuse("HISTORICAL_CASE_STATUS_DRIFT", "Historical merge case must remain completed");
  }
  const participantGoogleRows = googleIdentities.filter(row => [roles.donorUserId, roles.survivorUserId].includes(row.userId));
  const expectedIdentity = googleIdentities.find(row => row.id === roles.googleIdentityId);
  if (participantGoogleRows.length !== 1 || !expectedIdentity || expectedIdentity.provider !== "google" || expectedIdentity.userId !== roles.donorUserId) refuse("IDENTITY_OWNER_DRIFT", "Expected Google identity must be the only participant Google identity and still belong to Donor");
  if (snapshot.conflicts.mergeCaseIds.length > 0) refuse("CONFLICTING_MERGE_WORKFLOW", `Conflicting merge case(s): ${snapshot.conflicts.mergeCaseIds.join(",")}`);
  if (snapshot.conflicts.recoveryRequestIds.length > 0) refuse("CONFLICTING_RECOVERY_WORKFLOW", `Conflicting recovery request(s): ${snapshot.conflicts.recoveryRequestIds.join(",")}`);
  const historicalFinancial = historicalEvidence.financialReceipt as any;
  if (historicalEvidence.financialReceiptCount !== 1 || !historicalFinancial) refuse("HISTORICAL_FINANCIAL_RECEIPT_DRIFT", "Historical case must have exactly one financial receipt");
  else {
    if (historicalFinancial.sourceUserId !== roles.survivorUserId || historicalFinancial.targetUserId !== roles.donorUserId) refuse("HISTORICAL_FINANCIAL_ROLE_DRIFT", "Historical financial receipt participants do not match the reversed historical case");
    if (!decimalEquals(financial.survivorWallet, historicalFinancial.walletSourceAfter, WALLET_SPEC) || !decimalEquals(financial.donorWallet, historicalFinancial.walletTargetAfter, WALLET_SPEC) || !decimalEquals(financial.survivorPoints, historicalFinancial.pointsSourceAfter, POINTS_SPEC) || !decimalEquals(financial.donorPoints, historicalFinancial.pointsTargetAfter, POINTS_SPEC)) refuse("CURRENT_FINANCIAL_DRIFT", "Current participant balances no longer equal the authoritative historical post-merge distribution");
    const historicalWalletTotal = addNonNegativeFixedDecimals(historicalFinancial.walletSourceAfter, historicalFinancial.walletTargetAfter, "historicalWalletTotal", WALLET_SPEC).sum;
    const historicalPointsTotal = addNonNegativeFixedDecimals(historicalFinancial.pointsSourceAfter, historicalFinancial.pointsTargetAfter, "historicalPointsTotal", POINTS_SPEC).sum;
    if (!decimalEquals(financial.walletTotal, historicalWalletTotal, WALLET_SPEC) || !decimalEquals(financial.pointsTotal, historicalPointsTotal, POINTS_SPEC)) refuse("FINANCIAL_CONSERVATION_DRIFT", "Current total value differs from historical post-merge total");
  }
  if (historicalEvidence.dataReceiptCount !== 1 || !historicalEvidence.dataReceipt) refuse("HISTORICAL_DATA_RECEIPT_DRIFT", "Historical case must have exactly one data receipt");
  if (historicalEvidence.completionAuditCount !== 1) refuse("HISTORICAL_COMPLETION_AUDIT_DRIFT", "Historical case must have exactly one merge_completed audit event");
  const unsupportedRows = snapshot.ownershipInventory.filter(
    row =>
      (row.donorCount !== 0 || row.survivorCount !== 0) &&
      !TRANSFERABLE_TABLES.has(row.table) &&
      !PRESERVED_FINANCIAL_TABLES.has(row.table)
  );
  if (unsupportedRows.length > 0) {
    refuse(
      "UNSUPPORTED_OWNERSHIP_DOMAIN",
      `Compensation has no explicit reconciliation semantics for: ${unsupportedRows.map(row => `${row.table}:${row.donorCount}/${row.survivorCount}`).join(",")}`
    );
  }
  const survivorTransferableRows = snapshot.ownershipInventory.filter(row => TRANSFERABLE_TABLES.has(row.table) && row.survivorCount !== 0);
  if (survivorTransferableRows.length > 0) refuse("OWNERSHIP_DRIFT", `Canonical Survivor already owns transferable rows: ${survivorTransferableRows.map(row => `${row.table}:${row.survivorCount}`).join(",")}`);
  const postMergeDrift = snapshot.postMergeActivity.filter(row => row.donorCount !== 0 || row.survivorCount !== 0);
  if (postMergeDrift.length > 0) refuse("POST_MERGE_ACTIVITY_DRIFT", `Post-merge activity exists: ${postMergeDrift.map(row => `${row.table}:${row.donorCount}/${row.survivorCount}`).join(",")}`);
  return refusals;
}
function assertCompensationBinding(compensation: any, input: ExecuteHistoricalAccountMergeCompensationInput): void {
  if (Number(compensation.historicalMergeCaseId) !== input.historicalMergeCaseId || Number(compensation.recoveryRequestId) !== input.recoveryRequestId || Number(compensation.donorUserId) !== input.donorUserId || Number(compensation.survivorUserId) !== input.survivorUserId || Number(compensation.googleIdentityId) !== input.googleIdentityId) throw new HistoricalAccountMergeCompensationError("COMPENSATION_BINDING_DRIFT", "Existing compensation lifecycle is bound to different immutable participants");
  if (String(compensation.expectedSnapshotDigest) !== input.expectedSnapshotDigest) throw new HistoricalAccountMergeCompensationError("COMPENSATION_DIGEST_DRIFT", "Existing compensation lifecycle was prepared against a different snapshot digest");
}
function assertCompletedReceiptBinding(compensation: any, receipt: any, input: ExecuteHistoricalAccountMergeCompensationInput): void {
  if (!receipt) throw new HistoricalAccountMergeCompensationError("COMPLETED_RECEIPT_MISSING", "Completed compensation is missing its immutable receipt");
  if (Number(receipt.compensationId) !== Number(compensation.id) || Number(receipt.historicalMergeCaseId) !== input.historicalMergeCaseId || Number(receipt.recoveryRequestId) !== input.recoveryRequestId || Number(receipt.donorUserId) !== input.donorUserId || Number(receipt.survivorUserId) !== input.survivorUserId || Number(receipt.googleIdentityId) !== input.googleIdentityId || String(receipt.expectedSnapshotDigest) !== input.expectedSnapshotDigest) throw new HistoricalAccountMergeCompensationError("COMPLETED_RECEIPT_DRIFT", "Completed compensation receipt does not match the immutable lifecycle binding");
}

export async function buildHistoricalAccountMergeCompensationPreflight(input: HistoricalAccountMergeCompensationInput) {
  validateIdentityInput(input);
  const database = await db.getDb();
  if (!database) throw new HistoricalAccountMergeCompensationError("DATABASE_UNAVAILABLE", "Database unavailable");
  const existing = await readCompensationForCase(input.historicalMergeCaseId, database, false);
  if (existing?.status === "completed") {
    const receipt = await readCompensationReceipt(Number(existing.id), database, false);
    const bindingMatches = Boolean(receipt && Number(existing.recoveryRequestId) === input.recoveryRequestId && Number(existing.donorUserId) === input.donorUserId && Number(existing.survivorUserId) === input.survivorUserId && Number(existing.googleIdentityId) === input.googleIdentityId);
    return { mode: "read_only_preflight" as const, decision: bindingMatches ? ("ALREADY_COMPLETED" as const) : ("REFUSE" as const), snapshotDigest: String(existing.expectedSnapshotDigest), refusals: bindingMatches ? [] : [{ code: "COMPLETED_COMPENSATION_BINDING_DRIFT", message: "Existing completed compensation belongs to different participants" }], snapshot: null, compensationStatus: String(existing.status) as HistoricalAccountMergeCompensationStatus, receiptId: receipt ? Number(receipt.id) : null };
  }
  const snapshot = await readUnlockedSnapshot(input, database);
  const refusals = validateHistoricalBeforeSnapshot(snapshot);
  return { mode: "read_only_preflight" as const, decision: refusals.length === 0 ? ("READY" as const) : ("REFUSE" as const), snapshotDigest: digestJson(snapshot), refusals, snapshot, compensationStatus: existing ? (String(existing.status) as HistoricalAccountMergeCompensationStatus) : null, receiptId: null };
}
async function appendCompensationAudit(tx: any, input: { compensationId: number; actorAdminId: number; action: string; safeMetadata?: Record<string, unknown> }) {
  await tx.insert(accountMergeCompensationAuditLogs).values({ compensationId: input.compensationId, actorAdminId: input.actorAdminId, action: input.action, safeMetadata: input.safeMetadata ? JSON.stringify(input.safeMetadata) : null });
}
async function prepareCompensationLifecycle(database: any, input: ExecuteHistoricalAccountMergeCompensationInput): Promise<any> {
  return database.transaction(async (tx: any) => {
    await db.lockAccountMergeUserRows([input.donorUserId, input.survivorUserId], tx);
    const historicalCase = await readCase(input.historicalMergeCaseId, tx, true);
    if (!historicalCase) throw new HistoricalAccountMergeCompensationError("HISTORICAL_CASE_NOT_FOUND", "Historical merge case not found");
    const existing = await readCompensationForCase(input.historicalMergeCaseId, tx, true);
    if (existing) { assertCompensationBinding(existing, input); return existing; }
    const snapshot = await readSnapshotAfterPrelude(input, tx, { lockRelatedRows: true, historicalCase });
    const refusals = validateHistoricalBeforeSnapshot(snapshot);
    if (refusals.length > 0) throw new HistoricalAccountMergeCompensationError(refusals[0].code, refusals.map(row => `${row.code}: ${row.message}`).join("; "));
    const currentDigest = digestJson(snapshot);
    if (currentDigest !== input.expectedSnapshotDigest) throw new HistoricalAccountMergeCompensationError("SNAPSHOT_DIGEST_DRIFT", `Current snapshot digest ${currentDigest} does not match the reviewed expected digest`);
    const insertResult: any = await tx.insert(accountMergeCompensations).values({ historicalMergeCaseId: input.historicalMergeCaseId, recoveryRequestId: input.recoveryRequestId, donorUserId: input.donorUserId, survivorUserId: input.survivorUserId, googleIdentityId: input.googleIdentityId, status: "pending", expectedSnapshotDigest: input.expectedSnapshotDigest, createdByAdminId: input.actorAdminId });
    const header = Array.isArray(insertResult) ? insertResult[0] : insertResult;
    const compensationId = Number(header?.insertId ?? insertResult?.insertId);
    if (!Number.isInteger(compensationId) || compensationId <= 0) throw new HistoricalAccountMergeCompensationError("COMPENSATION_CREATE_FAILED", "Unable to create compensation lifecycle");
    await appendCompensationAudit(tx, { compensationId, actorAdminId: input.actorAdminId, action: "prepared", safeMetadata: { expectedSnapshotDigest: input.expectedSnapshotDigest, historicalMergeCaseId: input.historicalMergeCaseId, recoveryRequestId: input.recoveryRequestId } });
    return readCompensationForCase(input.historicalMergeCaseId, tx, true);
  });
}
async function compensateFinancialState(tx: any, compensationId: number, input: ExecuteHistoricalAccountMergeCompensationInput, before: HistoricalCompensationSnapshot) {
  const wallet = addNonNegativeFixedDecimals(before.financial.donorWallet, before.financial.survivorWallet, "compensationWallet", WALLET_SPEC);
  const points = addNonNegativeFixedDecimals(before.financial.donorPoints, before.financial.survivorPoints, "compensationPoints", POINTS_SPEC);
  const donorWalletBefore = minorUnitsToDecimal(wallet.leftMinor, WALLET_SPEC.scale);
  const survivorWalletBefore = minorUnitsToDecimal(wallet.rightMinor, WALLET_SPEC.scale);
  const survivorWalletAfter = wallet.sum;
  const donorPointsBefore = minorUnitsToDecimal(points.leftMinor, POINTS_SPEC.scale);
  const survivorPointsBefore = minorUnitsToDecimal(points.rightMinor, POINTS_SPEC.scale);
  const survivorPointsAfter = points.sum;
  let walletLedgerRows = 0;
  let pointsLedgerRows = 0;
  if (wallet.leftMinor > 0) {
    const donorWalletRows = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, input.donorUserId)).limit(1);
    if (!donorWalletRows[0]) throw new HistoricalAccountMergeCompensationError("DONOR_WALLET_ROW_MISSING", "Positive Donor wallet balance has no wallet account row");
    const survivorWalletRows = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, input.survivorUserId)).limit(1);
    await tx.update(walletAccounts).set({ balance: "0.00" }).where(eq(walletAccounts.userId, input.donorUserId));
    if (survivorWalletRows[0]) await tx.update(walletAccounts).set({ balance: survivorWalletAfter }).where(eq(walletAccounts.userId, input.survivorUserId));
    else await tx.insert(walletAccounts).values({ userId: input.survivorUserId, balance: survivorWalletAfter, totalTopupApproved: "0.00", totalSpent: "0.00" });
    await tx.insert(walletTransactions).values([
      { userId: input.donorUserId, type: "adjust" as const, amount: minorUnitsToDecimal(-wallet.leftMinor, WALLET_SPEC.scale), balanceBefore: donorWalletBefore, balanceAfter: "0.00", referenceType: FINANCIAL_REFERENCE_TYPE, referenceId: compensationId, note: `Historical account merge compensation #${compensationId}: Donor balance moved to Survivor` },
      { userId: input.survivorUserId, type: "adjust" as const, amount: donorWalletBefore, balanceBefore: survivorWalletBefore, balanceAfter: survivorWalletAfter, referenceType: FINANCIAL_REFERENCE_TYPE, referenceId: compensationId, note: `Historical account merge compensation #${compensationId}: Survivor received current canonical balance` },
    ]);
    walletLedgerRows = 2;
  }
  if (points.leftMinor > 0) {
    await tx.insert(pointsTransactions).values([
      { userId: input.donorUserId, type: "adjust" as const, amount: minorUnitsToDecimal(-points.leftMinor, POINTS_SPEC.scale), balanceAfter: "0.00", referenceType: FINANCIAL_REFERENCE_TYPE, referenceId: compensationId, note: `Historical account merge compensation #${compensationId}: Donor current points moved to Survivor` },
      { userId: input.survivorUserId, type: "adjust" as const, amount: donorPointsBefore, balanceAfter: survivorPointsAfter, referenceType: FINANCIAL_REFERENCE_TYPE, referenceId: compensationId, note: `Historical account merge compensation #${compensationId}: Survivor received current canonical points` },
    ]);
    pointsLedgerRows = 2;
  }
  return {
    wallet: { donorBefore: donorWalletBefore, survivorBefore: survivorWalletBefore, transferredCurrentBalance: donorWalletBefore, donorAfter: "0.00", survivorAfter: survivorWalletAfter, totalBefore: before.financial.walletTotal, totalAfter: survivorWalletAfter, ledgerRowsCreated: walletLedgerRows },
    points: { donorBefore: donorPointsBefore, survivorBefore: survivorPointsBefore, transferredCurrentBalance: donorPointsBefore, donorAfter: "0.00", survivorAfter: survivorPointsAfter, totalBefore: before.financial.pointsTotal, totalAfter: survivorPointsAfter, ledgerRowsCreated: pointsLedgerRows },
  };
}
function assertAfterState(before: HistoricalCompensationSnapshot, after: HistoricalCompensationSnapshot, input: ExecuteHistoricalAccountMergeCompensationInput): void {
  const participantGoogle = after.googleIdentities.filter(row => [input.donorUserId, input.survivorUserId].includes(row.userId));
  if (participantGoogle.length !== 1 || participantGoogle[0].id !== input.googleIdentityId || participantGoogle[0].userId !== input.survivorUserId) throw new HistoricalAccountMergeCompensationError("POSTCONDITION_IDENTITY_FAILED", "Google identity is not uniquely owned by canonical Survivor after compensation");
  if (!isZeroDecimal(after.financial.donorWallet, WALLET_SPEC) || !isZeroDecimal(after.financial.donorPoints, POINTS_SPEC) || !decimalEquals(after.financial.walletTotal, before.financial.walletTotal, WALLET_SPEC) || !decimalEquals(after.financial.pointsTotal, before.financial.pointsTotal, POINTS_SPEC) || !decimalEquals(after.financial.survivorWallet, before.financial.walletTotal, WALLET_SPEC) || !decimalEquals(after.financial.survivorPoints, before.financial.pointsTotal, POINTS_SPEC)) throw new HistoricalAccountMergeCompensationError("POSTCONDITION_FINANCIAL_FAILED", "Compensating financial ledger did not preserve total value or zero Donor balances");
  const donorTransferable = after.ownershipInventory.filter(row => TRANSFERABLE_TABLES.has(row.table) && row.donorCount !== 0);
  if (donorTransferable.length > 0) throw new HistoricalAccountMergeCompensationError("POSTCONDITION_OWNERSHIP_FAILED", `Donor still owns transferable rows: ${donorTransferable.map(row => `${row.table}:${row.donorCount}`).join(",")}`);
  const duplicateConflicts = after.ownershipInventory.filter(row => TRANSFERABLE_TABLES.has(row.table) && row.conflictCount !== 0);
  if (duplicateConflicts.length > 0) throw new HistoricalAccountMergeCompensationError("POSTCONDITION_DUPLICATE_FAILED", "Transferable ownership still contains merge-key conflicts after compensation");
  if (after.request?.status !== before.request?.status || after.request?.sourceUserId !== before.request?.sourceUserId || after.request?.targetUserId !== before.request?.targetUserId || after.historicalCase?.status !== before.historicalCase?.status || after.historicalCase?.sourceUserId !== before.historicalCase?.sourceUserId || after.historicalCase?.targetUserId !== before.historicalCase?.targetUserId || after.historicalEvidence.financialReceiptCount !== before.historicalEvidence.financialReceiptCount || digestJson(after.historicalEvidence.financialReceipt) !== digestJson(before.historicalEvidence.financialReceipt) || after.historicalEvidence.dataReceiptCount !== before.historicalEvidence.dataReceiptCount || digestJson(after.historicalEvidence.dataReceipt) !== digestJson(before.historicalEvidence.dataReceipt) || after.historicalEvidence.mergeAuditCount !== before.historicalEvidence.mergeAuditCount || after.historicalEvidence.mergeAuditDigest !== before.historicalEvidence.mergeAuditDigest) throw new HistoricalAccountMergeCompensationError("HISTORICAL_EVIDENCE_MUTATED", "Historical recovery/merge evidence changed during compensation");
  if (digestJson(after.historicalImmutableEvidence) !== digestJson(before.historicalImmutableEvidence)) throw new HistoricalAccountMergeCompensationError("HISTORICAL_IMMUTABLE_DATA_MUTATED", "Historical financial ledgers or Account Merge dedupe evidence changed during compensation");
}
async function markCompensationFailed(database: any, compensationId: number, actorAdminId: number, error: unknown) {
  const reason = error instanceof HistoricalAccountMergeCompensationError ? `${error.code}: ${error.message}`.slice(0, 2000) : "UNEXPECTED_EXECUTION_FAILURE";
  await database.transaction(async (tx: any) => {
    const current = unwrapRows(await tx.execute(sql`SELECT id, status FROM accountMergeCompensations WHERE id = ${compensationId} LIMIT 1 FOR UPDATE`))[0];
    if (!current || current.status === "completed") return;
    const expectedStatus = String(current.status);
    if (expectedStatus !== "pending" && expectedStatus !== "failed") return;
    const failedUpdate = await tx
      .update(accountMergeCompensations)
      .set({ status: "failed", failedAt: new Date(), failureReason: reason })
      .where(and(eq(accountMergeCompensations.id, compensationId), eq(accountMergeCompensations.status, expectedStatus)));
    assertLifecycleCas(failedUpdate, `${expectedStatus}->failed`);
    await appendCompensationAudit(tx, { compensationId, actorAdminId, action: "failed", safeMetadata: { code: error instanceof HistoricalAccountMergeCompensationError ? error.code : "UNEXPECTED_EXECUTION_FAILURE" } });
  });
}
async function executePreparedCompensation(database: any, input: ExecuteHistoricalAccountMergeCompensationInput, compensationId: number) {
  return database.transaction(async (tx: any) => {
    // Required lock order: users ascending -> historical case -> request/identity/conflicting workflows.
    await db.lockAccountMergeUserRows([input.donorUserId, input.survivorUserId], tx);
    const historicalCase = await readCase(input.historicalMergeCaseId, tx, true);
    if (!historicalCase) throw new HistoricalAccountMergeCompensationError("HISTORICAL_CASE_NOT_FOUND", "Historical merge case not found");
    const compensation = await readCompensationForCase(input.historicalMergeCaseId, tx, true);
    if (!compensation || Number(compensation.id) !== compensationId) throw new HistoricalAccountMergeCompensationError("COMPENSATION_LIFECYCLE_DRIFT", "Prepared compensation lifecycle changed before execution");
    assertCompensationBinding(compensation, input);
    if (compensation.status === "completed") {
      const receipt = await readCompensationReceipt(compensationId, tx, true);
      assertCompletedReceiptBinding(compensation, receipt, input);
      return { alreadyCompleted: true, compensation, receipt };
    }
    if (!["pending", "failed"].includes(String(compensation.status))) throw new HistoricalAccountMergeCompensationError("COMPENSATION_STATE_CONFLICT", `Compensation is ${String(compensation.status)} and cannot be started`);
    const expectedStartStatus = String(compensation.status) as "pending" | "failed";
    const before = await readSnapshotAfterPrelude(input, tx, { lockRelatedRows: true, historicalCase });
    const refusals = validateHistoricalBeforeSnapshot(before);
    if (refusals.length > 0) throw new HistoricalAccountMergeCompensationError(refusals[0].code, refusals.map(row => `${row.code}: ${row.message}`).join("; "));
    const currentDigest = digestJson(before);
    if (currentDigest !== input.expectedSnapshotDigest) throw new HistoricalAccountMergeCompensationError("SNAPSHOT_DIGEST_DRIFT", `Current snapshot digest ${currentDigest} does not match prepared digest`);
    const startedUpdate = await tx
      .update(accountMergeCompensations)
      .set({ status: "in_progress", startedAt: new Date(), failedAt: null, failureReason: null })
      .where(and(eq(accountMergeCompensations.id, compensationId), eq(accountMergeCompensations.status, expectedStartStatus)));
    assertLifecycleCas(startedUpdate, `${expectedStartStatus}->in_progress`);
    await appendCompensationAudit(tx, { compensationId, actorAdminId: input.actorAdminId, action: "started", safeMetadata: { expectedSnapshotDigest: input.expectedSnapshotDigest } });
    const moved = await db.moveAuthIdentityOwner({ authIdentityId: input.googleIdentityId, expectedCurrentUserId: input.donorUserId, targetUserId: input.survivorUserId }, tx);
    if (!moved) throw new HistoricalAccountMergeCompensationError("IDENTITY_CAS_FAILED", "Google identity owner changed before the compensating CAS");
    maybeInjectFault("after_identity_move");
    const financialProof = await compensateFinancialState(tx, compensationId, input, before);
    maybeInjectFault("after_financial_compensation");
    const { dedupes, summary, safeSummary } = await reconcileAccountMergeOwnedDataCore({ scopeId: compensationId, sourceUserId: input.donorUserId, targetUserId: input.survivorUserId }, tx);
    if (dedupes.length > 0) {
      await tx.insert(accountMergeCompensationDedupeRecords).values(dedupes.map(row => ({ compensationId, domain: row.domain, donorRowId: row.sourceRowId, survivorRowId: row.targetRowId, keySummary: row.keySummary, safeMetadata: row.safeMetadata ?? null })));
    }
    maybeInjectFault("after_data_reconciliation");
    const afterHistoricalCase = await readCase(input.historicalMergeCaseId, tx, false);
    const after = await readSnapshotAfterPrelude(input, tx, { lockRelatedRows: false, historicalCase: afterHistoricalCase });
    assertAfterState(before, after, input);
    const actionCounts = { identityMoved: 1, walletLedgerRowsCreated: financialProof.wallet.ledgerRowsCreated, pointsLedgerRowsCreated: financialProof.points.ledgerRowsCreated, data: summary, dedupeRecordsCreated: dedupes.length };
    await tx.insert(accountMergeCompensationReceipts).values({ compensationId, historicalMergeCaseId: input.historicalMergeCaseId, recoveryRequestId: input.recoveryRequestId, donorUserId: input.donorUserId, survivorUserId: input.survivorUserId, googleIdentityId: input.googleIdentityId, expectedSnapshotDigest: input.expectedSnapshotDigest, beforeSnapshot: JSON.stringify(before), afterSnapshot: JSON.stringify(after), actionCounts: JSON.stringify(actionCounts), financialProof: JSON.stringify(financialProof) });
    await appendCompensationAudit(tx, { compensationId, actorAdminId: input.actorAdminId, action: "completed", safeMetadata: { beforeSnapshotDigest: input.expectedSnapshotDigest, afterSnapshotDigest: digestJson(after), dedupeRecordsCreated: dedupes.length } });
    const completedUpdate = await tx
      .update(accountMergeCompensations)
      .set({ status: "completed", completedAt: new Date(), failedAt: null, failureReason: null })
      .where(and(eq(accountMergeCompensations.id, compensationId), eq(accountMergeCompensations.status, "in_progress")));
    assertLifecycleCas(completedUpdate, "in_progress->completed");
    const completed = await readCompensationForCase(input.historicalMergeCaseId, tx, true);
    const receipt = await readCompensationReceipt(compensationId, tx, true);
    assertCompletedReceiptBinding(completed, receipt, input);
    return { alreadyCompleted: false, compensation: completed, receipt, safeSummary, financialProof };
  });
}

/** Controlled historical compensation; historical Case/receipts/audit/ledgers are never rewritten. */
export async function executeHistoricalAccountMergeCompensation(input: ExecuteHistoricalAccountMergeCompensationInput) {
  validateIdentityInput(input);
  assertPositiveInteger(input.actorAdminId, "actorAdminId");
  if (!/^[a-f0-9]{64}$/i.test(input.expectedSnapshotDigest)) throw new HistoricalAccountMergeCompensationError("INVALID_SNAPSHOT_DIGEST", "expectedSnapshotDigest must be a SHA-256 hex digest");
  assertExecutionAuthorized(input);
  const database = await db.getDb();
  if (!database) throw new HistoricalAccountMergeCompensationError("DATABASE_UNAVAILABLE", "Database unavailable");
  const existingBefore = await readCompensationForCase(input.historicalMergeCaseId, database, false);
  if (existingBefore?.status === "completed") {
    assertCompensationBinding(existingBefore, input);
    const receipt = await readCompensationReceipt(Number(existingBefore.id), database, false);
    assertCompletedReceiptBinding(existingBefore, receipt, input);
    return { alreadyCompleted: true, compensation: existingBefore, receipt };
  }
  const prepared = await prepareCompensationLifecycle(database, input);
  if (!prepared) throw new HistoricalAccountMergeCompensationError("COMPENSATION_CREATE_FAILED", "Compensation lifecycle could not be prepared");
  assertCompensationBinding(prepared, input);
  const compensationId = Number(prepared.id);
  try {
    const result = await executePreparedCompensation(database, input, compensationId);
    maybeInjectFault("after_receipt_commit");
    return result;
  } catch (error) {
    await markCompensationFailed(database, compensationId, input.actorAdminId, error);
    throw error;
  }
}
