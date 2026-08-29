import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeFinancialReconciliations,
  accountRecoveryRequests,
  authIdentities,
  paymentSlipClaims,
  pointsTransactions,
  walletAccounts,
  walletTopups,
  walletTransactions,
} from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestUser, deleteFixtures, uniqueTestTag } from "./test-helpers/fixtures";
import { reviewAccountRecoveryRequest } from "./services/accountRecoveryService";
import { prepareAccountMergeGuard, startAccountMergeGuard } from "./services/accountMergeGuardService";
import {
  __setAccountMergeFinancialFaultForTests,
  reconcileAccountMergeFinancials,
} from "./services/accountMergeFinancialReconciliationService";

type FinancialFixture = {
  sourceId: number;
  targetId: number;
  requestId: number;
  identityId: number;
  caseId: number;
};

const fixtures: FinancialFixture[] = [];

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("IPE-006 integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Unable to read inserted fixture id");
  return id;
}

async function createMergePair(options: { start?: boolean } = {}): Promise<FinancialFixture> {
  const t = requireTestDb();
  const source = await createTestUser();
  const target = await createTestUser();
  const identityResult: any = await t.insert(authIdentities).values({
    userId: source.id,
    provider: "google",
    providerSubject: `ipe006-google-${uniqueTestTag()}`,
    emailAtLink: `ipe006-${uniqueTestTag()}@example.test`,
  });
  const identityId = insertId(identityResult);
  const request = await db.createAccountRecoveryRequest({ requesterUserId: source.id });
  await reviewAccountRecoveryRequest({
    requestId: request.id,
    action: "block",
    actorAdminId: 1,
    reason: "IPE-006 financial reconciliation integration fixture",
  });
  const prepared = await prepareAccountMergeGuard({
    requestId: request.id,
    targetUserId: target.id,
    actorAdminId: 1,
  });
  if (options.start !== false) await startAccountMergeGuard(prepared.id, 1);

  const fixture = {
    sourceId: source.id,
    targetId: target.id,
    requestId: request.id,
    identityId,
    caseId: prepared.id,
  };
  fixtures.push(fixture);
  return fixture;
}

async function seedBalances(
  f: FinancialFixture,
  values: {
    sourceWallet?: string;
    targetWallet?: string;
    sourcePoints?: string;
    targetPoints?: string;
    createTargetWallet?: boolean;
  }
) {
  const t = requireTestDb();
  const sourceWallet = values.sourceWallet ?? "10.01";
  const targetWallet = values.targetWallet ?? "2.02";
  const sourcePoints = values.sourcePoints ?? "3.03";
  const targetPoints = values.targetPoints ?? "4.04";
  const createdAt = new Date("2026-08-29T00:00:00Z");

  await t.insert(walletAccounts).values({
    userId: f.sourceId,
    balance: sourceWallet,
    totalTopupApproved: "777.77",
    totalSpent: "111.11",
    createdAt,
    updatedAt: createdAt,
  });
  if (values.createTargetWallet !== false) {
    await t.insert(walletAccounts).values({
      userId: f.targetId,
      balance: targetWallet,
      totalTopupApproved: "222.22",
      totalSpent: "33.33",
      createdAt,
      updatedAt: createdAt,
    });
  }

  const sourceWalletHistory: any = await t.insert(walletTransactions).values({
    userId: f.sourceId,
    type: "adjust",
    amount: sourceWallet,
    balanceBefore: "0.00",
    balanceAfter: sourceWallet,
    referenceType: "ipe006_history",
    referenceId: f.caseId,
    note: "immutable source wallet history",
    createdAt,
  });
  const targetWalletHistory: any = await t.insert(walletTransactions).values({
    userId: f.targetId,
    type: "adjust",
    amount: targetWallet,
    balanceBefore: "0.00",
    balanceAfter: targetWallet,
    referenceType: "ipe006_history",
    referenceId: f.caseId,
    note: "immutable target wallet history",
    createdAt,
  });

  const sourcePointsHistory: any = await t.insert(pointsTransactions).values({
    userId: f.sourceId,
    type: "adjust",
    amount: sourcePoints,
    balanceAfter: sourcePoints,
    referenceType: "ipe006_history",
    referenceId: f.caseId,
    note: "immutable source points history",
    createdAt,
  });
  const targetPointsHistory: any = await t.insert(pointsTransactions).values({
    userId: f.targetId,
    type: "adjust",
    amount: targetPoints,
    balanceAfter: targetPoints,
    referenceType: "ipe006_history",
    referenceId: f.caseId,
    note: "immutable target points history",
    createdAt,
  });

  const topupResult: any = await t.insert(walletTopups).values({
    userId: f.sourceId,
    requestedAmount: "50.00",
    bonusAmount: "5.00",
    creditedAmount: "55.00",
    status: "approved",
    createdAt,
    updatedAt: createdAt,
  });
  const topupId = insertId(topupResult);
  const claimResult: any = await t.insert(paymentSlipClaims).values({
    sourceType: "wallet_topup",
    sourceId: topupId,
    userId: f.sourceId,
    fileHash: uniqueTestTag("ipe006_claim").padEnd(64, "0").slice(0, 64),
    claimedAt: createdAt,
  });

  return {
    historyIds: {
      sourceWallet: insertId(sourceWalletHistory),
      targetWallet: insertId(targetWalletHistory),
      sourcePoints: insertId(sourcePointsHistory),
      targetPoints: insertId(targetPointsHistory),
      topup: topupId,
      claim: insertId(claimResult),
    },
    expected: { sourceWallet, targetWallet, sourcePoints, targetPoints },
  };
}

async function cleanupFixture(f: FinancialFixture): Promise<void> {
  const t = requireTestDb();
  await t.delete(paymentSlipClaims).where(inArray(paymentSlipClaims.userId, [f.sourceId, f.targetId]));
  await t.delete(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.mergeCaseId, f.caseId));
  await t.delete(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId));
  await t.delete(walletTransactions).where(inArray(walletTransactions.userId, [f.sourceId, f.targetId]));
  await t.delete(walletTopups).where(inArray(walletTopups.userId, [f.sourceId, f.targetId]));
  await t.delete(walletAccounts).where(inArray(walletAccounts.userId, [f.sourceId, f.targetId]));
  await t.delete(pointsTransactions).where(inArray(pointsTransactions.userId, [f.sourceId, f.targetId]));
  await t.delete(accountMergeCases).where(eq(accountMergeCases.id, f.caseId));
  await t.delete(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, f.requestId));
  await t.delete(authIdentities).where(eq(authIdentities.id, f.identityId));
  await deleteFixtures({ userIds: [f.sourceId, f.targetId] });
}

async function readRowById(table: any, idColumn: any, id: number) {
  return (await requireTestDb().select().from(table).where(eq(idColumn, id)).limit(1))[0];
}

describe.sequential("IPE-006 Account Merge financial reconciliation - real database", () => {
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(getTestDb());
  });

  afterEach(async () => {
    __setAccountMergeFinancialFaultForTests(null);
    while (fixtures.length > 0) await cleanupFixture(fixtures.pop()!);
  });

  it("moves Wallet + Points exactly, appends explicit ledgers/receipt/audit, and leaves historical financial + anti-replay rows byte-for-byte unchanged", async () => {
    const f = await createMergePair();
    const seeded = await seedBalances(f, {});
    const t = requireTestDb();

    const historyBefore = {
      sourceWallet: await readRowById(walletTransactions, walletTransactions.id, seeded.historyIds.sourceWallet),
      targetWallet: await readRowById(walletTransactions, walletTransactions.id, seeded.historyIds.targetWallet),
      sourcePoints: await readRowById(pointsTransactions, pointsTransactions.id, seeded.historyIds.sourcePoints),
      targetPoints: await readRowById(pointsTransactions, pointsTransactions.id, seeded.historyIds.targetPoints),
      topup: await readRowById(walletTopups, walletTopups.id, seeded.historyIds.topup),
      claim: await readRowById(paymentSlipClaims, paymentSlipClaims.id, seeded.historyIds.claim),
    };

    const result = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 11 });
    expect(result.alreadyReconciled).toBe(false);

    const sourceWallet = (await t.select().from(walletAccounts).where(eq(walletAccounts.userId, f.sourceId)))[0];
    const targetWallet = (await t.select().from(walletAccounts).where(eq(walletAccounts.userId, f.targetId)))[0];
    expect(sourceWallet.balance).toBe("0.00");
    expect(targetWallet.balance).toBe("12.03");
    expect(sourceWallet.totalTopupApproved).toBe("777.77");
    expect(sourceWallet.totalSpent).toBe("111.11");
    expect(targetWallet.totalTopupApproved).toBe("222.22");
    expect(targetWallet.totalSpent).toBe("33.33");
    expect(await db.getAccountMergePointsBalance(f.sourceId)).toBe("0.00");
    expect(await db.getAccountMergePointsBalance(f.targetId)).toBe("7.07");

    const walletMoves = await t.select().from(walletTransactions).where(
      and(eq(walletTransactions.referenceType, "account_merge_financial"), eq(walletTransactions.referenceId, f.caseId))
    );
    expect(walletMoves).toHaveLength(2);
    expect(walletMoves.map((r) => [r.userId, r.amount, r.balanceBefore, r.balanceAfter])).toEqual(
      expect.arrayContaining([
        [f.sourceId, "-10.01", "10.01", "0.00"],
        [f.targetId, "10.01", "2.02", "12.03"],
      ])
    );

    const pointMoves = await t.select().from(pointsTransactions).where(
      and(eq(pointsTransactions.referenceType, "account_merge_financial"), eq(pointsTransactions.referenceId, f.caseId))
    );
    expect(pointMoves).toHaveLength(2);
    expect(pointMoves.map((r) => [r.userId, r.amount, r.balanceAfter])).toEqual(
      expect.arrayContaining([
        [f.sourceId, "-3.03", "0.00"],
        [f.targetId, "3.03", "7.07"],
      ])
    );

    const receipt = (await t.select().from(accountMergeFinancialReconciliations).where(
      eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId)
    ))[0];
    expect(receipt).toMatchObject({
      sourceUserId: f.sourceId,
      targetUserId: f.targetId,
      walletSourceBefore: "10.01",
      walletTargetBefore: "2.02",
      walletTransferred: "10.01",
      walletSourceAfter: "0.00",
      walletTargetAfter: "12.03",
      pointsSourceBefore: "3.03",
      pointsTargetBefore: "4.04",
      pointsTransferred: "3.03",
      pointsSourceAfter: "0.00",
      pointsTargetAfter: "7.07",
    });

    const audits = await t.select().from(accountMergeAuditLogs).where(
      and(eq(accountMergeAuditLogs.mergeCaseId, f.caseId), eq(accountMergeAuditLogs.action, "financial_reconciled"))
    );
    expect(audits).toHaveLength(1);

    expect(await readRowById(walletTransactions, walletTransactions.id, seeded.historyIds.sourceWallet)).toEqual(historyBefore.sourceWallet);
    expect(await readRowById(walletTransactions, walletTransactions.id, seeded.historyIds.targetWallet)).toEqual(historyBefore.targetWallet);
    expect(await readRowById(pointsTransactions, pointsTransactions.id, seeded.historyIds.sourcePoints)).toEqual(historyBefore.sourcePoints);
    expect(await readRowById(pointsTransactions, pointsTransactions.id, seeded.historyIds.targetPoints)).toEqual(historyBefore.targetPoints);
    expect(await readRowById(walletTopups, walletTopups.id, seeded.historyIds.topup)).toEqual(historyBefore.topup);
    expect(await readRowById(paymentSlipClaims, paymentSlipClaims.id, seeded.historyIds.claim)).toEqual(historyBefore.claim);
  }, 30000);

  it("preserves exact Wallet + Points values at both DECIMAL schema boundaries without floating-point rounding", async () => {
    const f = await createMergePair();
    await seedBalances(f, {
      sourceWallet: "0.01",
      targetWallet: "9999999999.98",
      sourcePoints: "0.01",
      targetPoints: "99999999.98",
    });

    const result = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 12 });
    expect(result.reconciliation.walletTargetAfter).toBe("9999999999.99");
    expect(result.reconciliation.pointsTargetAfter).toBe("99999999.99");

    const targetWallet = (await requireTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, f.targetId)))[0];
    expect(targetWallet.balance).toBe("9999999999.99");
  }, 30000);

  it("creates a missing Target wallet singleton only when value must be received", async () => {
    const f = await createMergePair();
    await seedBalances(f, {
      sourceWallet: "0.01",
      targetWallet: "0.00",
      sourcePoints: "0.00",
      targetPoints: "0.00",
      createTargetWallet: false,
    });

    const result = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 12 });
    expect(result.reconciliation.walletTargetAfter).toBe("0.01");

    const targetWallet = (await requireTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, f.targetId)))[0];
    expect(targetWallet.balance).toBe("0.01");
    expect(targetWallet.totalTopupApproved).toBe("0.00");
    expect(targetWallet.totalSpent).toBe("0.00");
  }, 30000);

  it("zero Source balances commit one receipt but create no artificial transfer ledger rows", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "0.00", targetWallet: "8.88", sourcePoints: "0.00", targetPoints: "9.99" });

    const result = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 13 });
    expect(result.reconciliation).toMatchObject({
      walletTransferred: "0.00",
      walletTargetAfter: "8.88",
      pointsTransferred: "0.00",
      pointsTargetAfter: "9.99",
    });

    const walletMoves = await requireTestDb().select().from(walletTransactions).where(
      and(eq(walletTransactions.referenceType, "account_merge_financial"), eq(walletTransactions.referenceId, f.caseId))
    );
    const pointMoves = await requireTestDb().select().from(pointsTransactions).where(
      and(eq(pointsTransactions.referenceType, "account_merge_financial"), eq(pointsTransactions.referenceId, f.caseId))
    );
    expect(walletMoves).toHaveLength(0);
    expect(pointMoves).toHaveLength(0);
  }, 30000);

  it("a normal retry returns the durable receipt and never credits twice", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "15.15", targetWallet: "5.05", sourcePoints: "7.07", targetPoints: "1.01" });

    const first = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 21 });
    const second = await reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 22 });
    expect(first.alreadyReconciled).toBe(false);
    expect(second.alreadyReconciled).toBe(true);
    expect(second.reconciliation.id).toBe(first.reconciliation.id);

    const receipts = await requireTestDb().select().from(accountMergeFinancialReconciliations).where(
      eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId)
    );
    const walletMoves = await requireTestDb().select().from(walletTransactions).where(
      and(eq(walletTransactions.referenceType, "account_merge_financial"), eq(walletTransactions.referenceId, f.caseId))
    );
    const pointMoves = await requireTestDb().select().from(pointsTransactions).where(
      and(eq(pointsTransactions.referenceType, "account_merge_financial"), eq(pointsTransactions.referenceId, f.caseId))
    );
    const audits = await requireTestDb().select().from(accountMergeAuditLogs).where(
      and(eq(accountMergeAuditLogs.mergeCaseId, f.caseId), eq(accountMergeAuditLogs.action, "financial_reconciled"))
    );
    expect(receipts).toHaveLength(1);
    expect(walletMoves).toHaveLength(2);
    expect(pointMoves).toHaveLength(2);
    expect(audits).toHaveLength(1);
  }, 30000);

  it("two concurrent admins serialize on the merge locks and move value exactly once", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "20.20", targetWallet: "1.01", sourcePoints: "2.02", targetPoints: "3.03" });

    const [a, b] = await Promise.all([
      reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 31 }),
      reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 32 }),
    ]);
    expect([a.alreadyReconciled, b.alreadyReconciled].sort()).toEqual([false, true]);
    expect(a.reconciliation.id).toBe(b.reconciliation.id);

    const targetWallet = (await requireTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, f.targetId)))[0];
    expect(targetWallet.balance).toBe("21.21");
    expect(await db.getAccountMergePointsBalance(f.targetId)).toBe("5.05");
    expect(await requireTestDb().select().from(accountMergeFinancialReconciliations).where(
      eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId)
    )).toHaveLength(1);
  }, 30000);

  it("refuses a pending case before any financial write", async () => {
    const f = await createMergePair({ start: false });
    await seedBalances(f, { sourceWallet: "1.00", targetWallet: "2.00", sourcePoints: "3.00", targetPoints: "4.00" });

    await expect(reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 41 })).rejects.toMatchObject({
      code: "CASE_NOT_IN_PROGRESS",
    });
    expect(await requireTestDb().select().from(accountMergeFinancialReconciliations).where(
      eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId)
    )).toHaveLength(0);
  }, 30000);

  it("fails closed when the Target is itself a guarded Source of another merge", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "1.00", targetWallet: "2.00", sourcePoints: "3.00", targetPoints: "4.00" });
    const t = requireTestDb();
    const downstreamTarget = await createTestUser();
    let downstreamRequestId = 0;
    let downstreamCaseId = 0;
    let targetIdentityId = 0;

    try {
      const identityResult: any = await t.insert(authIdentities).values({
        userId: f.targetId,
        provider: "google",
        providerSubject: `ipe006-target-guard-${uniqueTestTag()}`,
        emailAtLink: `ipe006-target-guard-${uniqueTestTag()}@example.test`,
      });
      targetIdentityId = insertId(identityResult);
      const downstreamRequest = await db.createAccountRecoveryRequest({ requesterUserId: f.targetId });
      downstreamRequestId = downstreamRequest.id;
      await reviewAccountRecoveryRequest({
        requestId: downstreamRequestId,
        action: "block",
        actorAdminId: 1,
        reason: "IPE-006 target-guard fixture",
      });
      const downstreamCase = await prepareAccountMergeGuard({
        requestId: downstreamRequestId,
        targetUserId: downstreamTarget.id,
        actorAdminId: 1,
      });
      downstreamCaseId = downstreamCase.id;

      await expect(reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 42 })).rejects.toMatchObject({
        code: "TARGET_ACCOUNT_GUARDED",
      });
      expect(await t.select().from(accountMergeFinancialReconciliations).where(
        eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId)
      )).toHaveLength(0);
    } finally {
      if (downstreamCaseId) {
        await t.delete(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.mergeCaseId, downstreamCaseId));
        await t.delete(accountMergeCases).where(eq(accountMergeCases.id, downstreamCaseId));
      }
      if (downstreamRequestId) {
        await t.delete(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, downstreamRequestId));
      }
      if (targetIdentityId) {
        await t.delete(authIdentities).where(eq(authIdentities.id, targetIdentityId));
      }
      await deleteFixtures({ userIds: [downstreamTarget.id] });
    }
  }, 30000);

  it("an injected failure after Wallet work rolls back balances, ledgers, receipt, and audit", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "6.66", targetWallet: "7.77", sourcePoints: "8.88", targetPoints: "9.99" });
    __setAccountMergeFinancialFaultForTests("after_wallet");

    await expect(reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 51 })).rejects.toThrow(
      "Injected Account Merge financial failure at after_wallet"
    );

    const wallets = await requireTestDb().select().from(walletAccounts).where(inArray(walletAccounts.userId, [f.sourceId, f.targetId]));
    expect(wallets.find((r) => r.userId === f.sourceId)?.balance).toBe("6.66");
    expect(wallets.find((r) => r.userId === f.targetId)?.balance).toBe("7.77");
    expect(await db.getAccountMergePointsBalance(f.sourceId)).toBe("8.88");
    expect(await db.getAccountMergePointsBalance(f.targetId)).toBe("9.99");
    expect(await requireTestDb().select().from(walletTransactions).where(eq(walletTransactions.referenceType, "account_merge_financial"))).toHaveLength(0);
    expect(await requireTestDb().select().from(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId))).toHaveLength(0);
  }, 30000);

  it("an injected failure after Points work rolls back BOTH domains atomically", async () => {
    const f = await createMergePair();
    await seedBalances(f, { sourceWallet: "11.11", targetWallet: "22.22", sourcePoints: "33.33", targetPoints: "44.44" });
    __setAccountMergeFinancialFaultForTests("after_points");

    await expect(reconcileAccountMergeFinancials({ caseId: f.caseId, actorAdminId: 61 })).rejects.toThrow(
      "Injected Account Merge financial failure at after_points"
    );

    const sourceWallet = (await requireTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, f.sourceId)))[0];
    const targetWallet = (await requireTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, f.targetId)))[0];
    expect(sourceWallet.balance).toBe("11.11");
    expect(targetWallet.balance).toBe("22.22");
    expect(await db.getAccountMergePointsBalance(f.sourceId)).toBe("33.33");
    expect(await db.getAccountMergePointsBalance(f.targetId)).toBe("44.44");
    expect(await requireTestDb().select().from(pointsTransactions).where(eq(pointsTransactions.referenceType, "account_merge_financial"))).toHaveLength(0);
    expect(await requireTestDb().select().from(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId))).toHaveLength(0);
  }, 30000);
});
