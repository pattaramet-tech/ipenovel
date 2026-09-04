import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("IPE-021-D / 0046 pointsAccounts foundation", () => {
  const schema = read("drizzle/schema.ts");
  const migration = read("drizzle/0046_add_points_accounts_mutex.sql");
  const db = read("server/db.ts");
  const order = read("server/services/orderService.ts");
  const merge = read("server/services/accountMergeFinancialReconciliationService.ts");

  it("creates one authoritative balance row per user and backfills the exact latest ledger balance", () => {
    expect(schema).toContain('export const pointsAccounts = mysqlTable(');
    expect(schema).toContain('userId: int("userId").primaryKey()');
    expect(schema).toContain('balance: decimal("balance", { precision: 10, scale: 2 })');
    expect(schema).toContain('version: bigint("version"');
    expect(migration).toContain("INSERT INTO `pointsAccounts`");
    expect(migration).toContain("ORDER BY pt.`createdAt` DESC, pt.`id` DESC");
    expect(migration).toContain("FROM `users` u");
  });

  it("adds per-user financial effect idempotency without constraining legacy NULL effects", () => {
    expect(schema).toContain('effectKey: varchar("effectKey", { length: 191 })');
    expect(schema).toContain('uniqueIndex("pointsTransactions_userId_effectKey_unique")');
    expect(migration).toContain("UNIQUE(`userId`,`effectKey`)");
  });

  it("reads pointsAccounts with a deterministic latest-ledger rolling-deploy fallback", () => {
    const body = between(db, "export async function getUserPointsBalance", "type PointsTransactionWrite");
    expect(body).toContain(".from(pointsAccounts)");
    expect(body).toContain(".from(pointsTransactions)");
    expect(body).toContain("desc(pointsTransactions.createdAt), desc(pointsTransactions.id)");
  });

  it("points writes serialize on pointsAccounts FOR UPDATE and never take users FOR UPDATE as the balance mutex", () => {
    const lockRows = between(db, "export async function lockPointsAccountRowsForUpdate", "export async function assertAccountMergePointsMutationAllowed");
    const guard = between(db, "export async function assertAccountMergePointsMutationAllowed", "export async function assertAccountMergeClassifiedMutationAllowed");
    expect(lockRows).toContain("FROM pointsAccounts");
    expect(lockRows).toContain("FOR UPDATE");
    expect(lockRows).toContain("ensureProvisionedPointsAccount(userId, tx)");
    expect(lockRows).toContain("ledgerBalance");
    expect(guard).toContain("assertAccountMergeClassifiedMutationAllowed(userId, tx)");
    expect(guard).toContain("lockPointsAccountRowsForUpdate([userId], tx)");
    expect(guard).not.toContain("lockLegacyAccountMergeUsersExclusive");
  });

  it("ledger writes update authoritative balance/version atomically and preserve effectKey", () => {
    const body = between(db, "async function writePointsTransactionUnderLock", "export async function recordPointsTransaction(");
    expect(body).toContain(".update(pointsAccounts)");
    expect(body).toContain("pointsAccounts.version} + 1");
    expect(body).toContain(".insert(pointsTransactions)");
    expect(body).toContain("effectKey: data.effectKey");
  });

  it("approval defers points locking until after payment/claim, and Account Merge uses the same points mutex", () => {
    const approvalGuard = between(order, "export async function lockAndRequireReviewablePayment", "async function approvePaymentInTx");
    expect(approvalGuard).toContain("assertAccountMergeClassifiedMutationAllowed");
    expect(approvalGuard).not.toContain("assertAccountMergePointsMutationAllowed");
    expect(order).toContain("effectKey: `order:${orderId}:redeem`");
    expect(order).toContain("effectKey: `order:${orderId}:earn`");
    expect(merge).toContain("lockPointsAccountRowsForUpdate([sourceUserId, targetUserId], tx)");
    expect(merge).toContain(".update(pointsAccounts)");
    expect(merge).toContain("effectKey: `account_merge:${params.caseId}:points_transfer`");
  });

  it("Sports pre-locks only actual point mutators as canonical multi-user sets", () => {
    const settle = between(db, "export async function settleSportsMatch", "export async function cancelSportsMatch");
    const cancel = between(db, "export async function cancelSportsMatch", "export async function markSportsRewardCouponUsed");
    expect(settle).toContain("const pointWinnerUserIds = pendingVotes");
    expect(settle).toContain(".filter((vote: any) => vote.prediction === result)");
    expect(settle).toContain("lockPointsAccountRowsForUpdate(pointWinnerUserIds, tx)");
    expect(settle).not.toContain("await lockUserForPoints(vote.userId, tx)");
    expect(cancel).toContain("const refundUserIds = pendingVotes.map((vote: any) => vote.userId)");
    expect(cancel).toContain("lockPointsAccountRowsForUpdate(refundUserIds, tx)");
    expect(cancel).not.toContain("await lockUserForPoints(vote.userId, tx)");
  });
});
