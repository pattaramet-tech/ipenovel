import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, count, eq, inArray, lte } from "drizzle-orm";
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
  couponUsages,
  dailyCheckinRewardGrants,
  dailyCheckins,
  orders,
  pointsTransactions,
  purchases,
  readingProgress,
  topupLogs,
  users,
  walletAccounts,
  walletTopups,
  walletTransactions,
  workspaceWorkspaces,
} from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import {
  __setHistoricalAccountMergeCompensationFaultForTests,
  buildHistoricalAccountMergeCompensationPreflight,
  executeHistoricalAccountMergeCompensation,
} from "./services/historicalAccountMergeCompensationService";
import { buildAccountRecoveryLifecycleProjection } from "./services/accountRecoveryLifecycleService";

const DONOR = 21_960_193;
const SURVIVOR = 763_680_006;
const REQUEST = 90_007;
const CASE = 1;
const IDENTITY = 5_370_059;
const ACTOR_ADMIN = 1;
const COMPLETED_AT = new Date("2026-09-09T13:48:07.000Z");
const HISTORICAL_AT = new Date("2026-09-09T12:30:00.000Z");
const POST_MERGE_AT = new Date("2026-09-09T14:00:00.000Z");
const SYNTHETIC_PROVIDER_SUBJECT = "integration-only-google-subject";
const EXECUTION_ENABLED_ENV = "ACCOUNT_MERGE_HISTORICAL_COMPENSATION_EXECUTION_ENABLED";
const EXECUTION_SCOPE_ENV = "ACCOUNT_MERGE_HISTORICAL_COMPENSATION_SCOPE";
const ORIGINAL_EXECUTION_ENABLED = process.env[EXECUTION_ENABLED_ENV];
const ORIGINAL_EXECUTION_SCOPE = process.env[EXECUTION_SCOPE_ENV];

const baselineInput = {
  recoveryRequestId: REQUEST,
  historicalMergeCaseId: CASE,
  donorUserId: DONOR,
  survivorUserId: SURVIVOR,
  googleIdentityId: IDENTITY,
} as const;

function tdb() {
  return getTestDb();
}

async function cleanupFixture() {
  const t = tdb();
  const participants = [DONOR, SURVIVOR];
  const compensations = await t
    .select({ id: accountMergeCompensations.id })
    .from(accountMergeCompensations)
    .where(eq(accountMergeCompensations.historicalMergeCaseId, CASE));
  const compensationIds = compensations.map(row => Number(row.id));
  if (compensationIds.length > 0) {
    await t.delete(accountMergeCompensationDedupeRecords).where(inArray(accountMergeCompensationDedupeRecords.compensationId, compensationIds));
    await t.delete(accountMergeCompensationAuditLogs).where(inArray(accountMergeCompensationAuditLogs.compensationId, compensationIds));
    await t.delete(accountMergeCompensationReceipts).where(inArray(accountMergeCompensationReceipts.compensationId, compensationIds));
  }
  await t.delete(accountMergeCompensations).where(eq(accountMergeCompensations.historicalMergeCaseId, CASE));
  await t.delete(accountMergeDataDedupeRecords).where(eq(accountMergeDataDedupeRecords.mergeCaseId, CASE));
  await t.delete(accountMergeDataReconciliations).where(eq(accountMergeDataReconciliations.mergeCaseId, CASE));
  await t.delete(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, CASE));
  await t.delete(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.mergeCaseId, CASE));
  await t.delete(dailyCheckinRewardGrants).where(inArray(dailyCheckinRewardGrants.userId, participants));
  await t.delete(dailyCheckins).where(inArray(dailyCheckins.userId, participants));
  await t.delete(couponUsages).where(inArray(couponUsages.userId, participants));
  await t.delete(purchases).where(inArray(purchases.userId, participants));
  await t.delete(readingProgress).where(inArray(readingProgress.userId, participants));
  await t.delete(carts).where(inArray(carts.userId, participants));
  await t.delete(orders).where(inArray(orders.userId, participants));
  await t.delete(walletTransactions).where(inArray(walletTransactions.userId, participants));
  await t.delete(walletTopups).where(inArray(walletTopups.userId, participants));
  await t.delete(topupLogs).where(inArray(topupLogs.userId, participants));
  await t.delete(walletAccounts).where(inArray(walletAccounts.userId, participants));
  await t.delete(pointsTransactions).where(inArray(pointsTransactions.userId, participants));
  await t.delete(authIdentities).where(orIdentityParticipants());
  await t.delete(accountMergeCases).where(inArray(accountMergeCases.id, [CASE, CASE + 1]));
  await t.delete(accountRecoveryRequests).where(inArray(accountRecoveryRequests.id, [REQUEST, REQUEST + 1]));
  await t.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.ownerUserId, DONOR));
  await t.delete(users).where(inArray(users.id, participants));
}

function orIdentityParticipants() {
  return inArray(authIdentities.userId, [DONOR, SURVIVOR]);
}

async function seedHistoricalProductionLikeFixture() {
  const t = tdb();
  await t.insert(users).values([
    { id: DONOR, openId: `historical-donor-${DONOR}`, role: "user", createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT, lastSignedIn: HISTORICAL_AT },
    { id: SURVIVOR, openId: `historical-survivor-${SURVIVOR}`, role: "user", createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT, lastSignedIn: HISTORICAL_AT },
  ]);
  await t.insert(accountRecoveryRequests).values({
    id: REQUEST,
    requesterUserId: SURVIVOR,
    status: "blocked",
    sourceUserId: null,
    targetUserId: null,
    reviewReason: "historical reversed-role fixture",
    createdAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  });
  await t.insert(authIdentities).values({
    id: IDENTITY,
    userId: DONOR,
    provider: "google",
    providerSubject: SYNTHETIC_PROVIDER_SUBJECT,
    emailAtLink: "integration-only@example.test",
    createdAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  });
  await t.insert(accountMergeCases).values({
    id: CASE,
    originAccountRecoveryRequestId: REQUEST,
    sourceUserId: SURVIVOR,
    targetUserId: DONOR,
    status: "completed",
    createdByAdminId: ACTOR_ADMIN,
    createdAt: HISTORICAL_AT,
    updatedAt: COMPLETED_AT,
    startedAt: HISTORICAL_AT,
    completedAt: COMPLETED_AT,
  });
  await t.insert(accountMergeFinancialReconciliations).values({
    mergeCaseId: CASE,
    sourceUserId: SURVIVOR,
    targetUserId: DONOR,
    actorAdminId: ACTOR_ADMIN,
    walletSourceBefore: "0.00",
    walletTargetBefore: "0.00",
    walletTransferred: "0.00",
    walletSourceAfter: "0.00",
    walletTargetAfter: "0.00",
    pointsSourceBefore: "9.60",
    pointsTargetBefore: "9.00",
    pointsTransferred: "9.60",
    pointsSourceAfter: "0.00",
    pointsTargetAfter: "18.60",
    createdAt: HISTORICAL_AT,
  });
  await t.insert(accountMergeDataReconciliations).values({
    mergeCaseId: CASE,
    sourceUserId: SURVIVOR,
    targetUserId: DONOR,
    actorAdminId: ACTOR_ADMIN,
    safeSummary: JSON.stringify({ historicalFixture: true, sourceRowsMoved: 0 }),
    createdAt: HISTORICAL_AT,
  });
  await t.insert(accountMergeAuditLogs).values([
    { mergeCaseId: CASE, actorAdminId: ACTOR_ADMIN, action: "guard_prepared", sourceUserId: SURVIVOR, targetUserId: DONOR, safeMetadata: "{}", createdAt: HISTORICAL_AT },
    { mergeCaseId: CASE, actorAdminId: ACTOR_ADMIN, action: "guard_started", sourceUserId: SURVIVOR, targetUserId: DONOR, safeMetadata: "{}", createdAt: HISTORICAL_AT },
    { mergeCaseId: CASE, actorAdminId: ACTOR_ADMIN, action: "financial_reconciled", sourceUserId: SURVIVOR, targetUserId: DONOR, safeMetadata: JSON.stringify({ pointsTransferred: "9.60" }), createdAt: HISTORICAL_AT },
    { mergeCaseId: CASE, actorAdminId: ACTOR_ADMIN, action: "data_reconciled", sourceUserId: SURVIVOR, targetUserId: DONOR, safeMetadata: "{}", createdAt: HISTORICAL_AT },
    { mergeCaseId: CASE, actorAdminId: ACTOR_ADMIN, action: "merge_completed", sourceUserId: SURVIVOR, targetUserId: DONOR, safeMetadata: "{}", createdAt: COMPLETED_AT },
  ]);

  await t.insert(walletAccounts).values([
    { userId: DONOR, balance: "0.00", totalTopupApproved: "0.00", totalSpent: "0.00", createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT },
    { userId: SURVIVOR, balance: "0.00", totalTopupApproved: "0.00", totalSpent: "0.00", createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT },
  ]);
  await t.insert(walletTransactions).values(Array.from({ length: 4 }, () => ({
    userId: SURVIVOR,
    type: "adjust" as const,
    amount: "0.00",
    balanceBefore: "0.00",
    balanceAfter: "0.00",
    referenceType: "historical_fixture",
    referenceId: CASE,
    note: "immutable historical wallet row",
    createdAt: HISTORICAL_AT,
  })));
  await t.insert(walletTopups).values(Array.from({ length: 2 }, (_, i) => ({
    userId: SURVIVOR,
    requestedAmount: "0.00",
    bonusAmount: "0.00",
    creditedAmount: "0.00",
    status: "approved" as const,
    approvalSource: "manual" as const,
    extractedData: JSON.stringify({ fixture: i }),
    createdAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  })));
  await t.insert(topupLogs).values(Array.from({ length: 2 }, (_, i) => ({
    userId: SURVIVOR,
    amount: "0.00",
    bonus: "0.00",
    total: "0.00",
    method: "admin_adjust" as const,
    reference: `historical-${i}`,
    note: "immutable historical topup row",
    createdAt: HISTORICAL_AT,
  })));

  const survivorPoints = Array.from({ length: 12 }, (_, i) => ({
    userId: SURVIVOR,
    type: "adjust" as const,
    amount: i === 0 ? "9.60" : i === 11 ? "-9.60" : "0.00",
    balanceAfter: i === 11 ? "0.00" : "9.60",
    referenceType: i === 11 ? "account_merge_financial" : "historical_fixture",
    referenceId: i === 11 ? CASE : i + 1,
    note: "immutable historical survivor points row",
    createdAt: HISTORICAL_AT,
  }));
  const donorPoints = Array.from({ length: 10 }, (_, i) => ({
    userId: DONOR,
    type: "adjust" as const,
    amount: i === 0 ? "9.00" : i === 8 ? "9.60" : "0.00",
    balanceAfter: i < 8 ? "9.00" : "18.60",
    referenceType: i === 8 ? "account_merge_financial" : "historical_fixture",
    referenceId: i === 8 ? CASE : 100 + i,
    note: "immutable historical donor points row",
    createdAt: HISTORICAL_AT,
  }));
  await t.insert(pointsTransactions).values([...survivorPoints, ...donorPoints]);

  const orderRows = Array.from({ length: 16 }, (_, i) => ({
    id: 9_300_001 + i,
    orderNumber: `HIST-90007-${String(i + 1).padStart(2, "0")}`,
    userId: DONOR,
    subtotal: "0.00",
    discountAmount: "0.00",
    pointsDiscountAmount: "0.00",
    totalAmount: "0.00",
    status: "approved" as const,
    paymentStatus: "approved" as const,
    createdAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  }));
  await t.insert(orders).values(orderRows);
  await t.insert(purchases).values(Array.from({ length: 82 }, (_, i) => ({
    userId: DONOR,
    novelId: 40_200_001 + Math.floor(i / 20),
    episodeId: 50_000_001 + i,
    orderId: orderRows[i % orderRows.length].id,
    grantedAt: HISTORICAL_AT,
    createdAt: HISTORICAL_AT,
  })));
  await t.insert(couponUsages).values(Array.from({ length: 12 }, (_, i) => ({
    couponId: 60_000_001 + i,
    userId: DONOR,
    orderId: orderRows[i].id,
    usedAt: HISTORICAL_AT,
  })));
  await t.insert(readingProgress).values(Array.from({ length: 31 }, (_, i) => ({
    userId: DONOR,
    novelId: 40_200_001 + Math.floor(i / 10),
    episodeId: 70_000_001 + i,
    progressPercent: 50,
    scrollPosition: i,
    lastReadAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  })));
  await t.insert(carts).values({ userId: DONOR, createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT });
  await t.insert(dailyCheckins).values({
    id: 8_100_001,
    userId: DONOR,
    checkinDate: "2026-09-09",
    campaignKey: "historical-compensation-fixture",
    status: "issued",
    issuedAt: HISTORICAL_AT,
    createdAt: HISTORICAL_AT,
    updatedAt: HISTORICAL_AT,
  });
  await t.insert(dailyCheckinRewardGrants).values({
    dailyCheckinId: 8_100_001,
    userId: DONOR,
    campaignId: 8_200_001,
    ruleId: 8_300_001,
    rewardKind: "points",
    grantReason: "daily",
    streakCountAtGrant: 1,
    pointsAmount: "0.00",
    status: "granted",
    createdAt: HISTORICAL_AT,
  });
}

async function ownerCount(table: any, userColumn: any, userId: number): Promise<number> {
  const rows = await tdb().select({ value: count() }).from(table).where(eq(userColumn, userId));
  return Number(rows[0]?.value ?? 0);
}

async function readHistoricalFingerprint() {
  const t = tdb();
  const [caseRows, financialRows, dataRows, auditRows, oldPointRows, oldWalletRows] = await Promise.all([
    t.select().from(accountMergeCases).where(eq(accountMergeCases.id, CASE)),
    t.select().from(accountMergeFinancialReconciliations).where(eq(accountMergeFinancialReconciliations.mergeCaseId, CASE)),
    t.select().from(accountMergeDataReconciliations).where(eq(accountMergeDataReconciliations.mergeCaseId, CASE)),
    t.select().from(accountMergeAuditLogs).where(eq(accountMergeAuditLogs.mergeCaseId, CASE)).orderBy(asc(accountMergeAuditLogs.id)),
    t.select().from(pointsTransactions).where(and(inArray(pointsTransactions.userId, [DONOR, SURVIVOR]), lte(pointsTransactions.createdAt, COMPLETED_AT))).orderBy(asc(pointsTransactions.id)),
    t.select().from(walletTransactions).where(and(inArray(walletTransactions.userId, [DONOR, SURVIVOR]), lte(walletTransactions.createdAt, COMPLETED_AT))).orderBy(asc(walletTransactions.id)),
  ]);
  return JSON.stringify({ caseRows, financialRows, dataRows, auditRows, oldPointRows, oldWalletRows });
}

async function readyPreflight() {
  const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
  expect(preflight.decision).toBe("READY");
  expect(preflight.refusals).toEqual([]);
  expect(preflight.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  return preflight;
}

async function executeFromReadyPreflight() {
  const preflight = await readyPreflight();
  return executeHistoricalAccountMergeCompensation({
    ...baselineInput,
    expectedSnapshotDigest: preflight.snapshotDigest,
    actorAdminId: ACTOR_ADMIN,
  });
}

describe.sequential("Historical Account Merge compensation - exact reversed Production fixture", () => {
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(tdb());
    process.env[EXECUTION_ENABLED_ENV] = "true";
    process.env[EXECUTION_SCOPE_ENV] = `${REQUEST}:${CASE}:${DONOR}:${SURVIVOR}:${IDENTITY}`;
  });

  afterAll(() => {
    if (ORIGINAL_EXECUTION_ENABLED === undefined) delete process.env[EXECUTION_ENABLED_ENV];
    else process.env[EXECUTION_ENABLED_ENV] = ORIGINAL_EXECUTION_ENABLED;
    if (ORIGINAL_EXECUTION_SCOPE === undefined) delete process.env[EXECUTION_SCOPE_ENV];
    else process.env[EXECUTION_SCOPE_ENV] = ORIGINAL_EXECUTION_SCOPE;
  });

  beforeEach(async () => {
    await cleanupFixture();
    await seedHistoricalProductionLikeFixture();
  });

  afterEach(async () => {
    __setHistoricalAccountMergeCompensationFaultForTests(null);
    await cleanupFixture();
  });

  it("preflight reproduces the exact reversed-role baseline and refuses to expose providerSubject", async () => {
    const preflight = await readyPreflight();
    expect(preflight.snapshot?.roles).toEqual({
      donorUserId: DONOR,
      survivorUserId: SURVIVOR,
      recoveryRequestId: REQUEST,
      historicalMergeCaseId: CASE,
      googleIdentityId: IDENTITY,
    });
    expect(preflight.snapshot?.request).toMatchObject({ requesterUserId: SURVIVOR, status: "blocked", sourceUserId: null, targetUserId: null });
    expect(preflight.snapshot?.historicalCase).toMatchObject({ sourceUserId: SURVIVOR, targetUserId: DONOR, status: "completed" });
    expect(preflight.snapshot?.financial).toEqual({ donorWallet: "0.00", survivorWallet: "0.00", walletTotal: "0.00", donorPoints: "18.60", survivorPoints: "0.00", pointsTotal: "18.60" });
    expect(JSON.stringify(preflight)).not.toContain(SYNTHETIC_PROVIDER_SUBJECT);
    const expectedOwnership: Record<string, [number, number]> = {
      orders: [16, 0],
      purchases: [82, 0],
      episodePurchases: [0, 0],
      couponUsages: [12, 0],
      dailyCheckins: [1, 0],
      dailyCheckinRewardGrants: [1, 0],
      readingProgress: [31, 0],
      carts: [1, 0],
      cartItems: [0, 0],
      walletTransactions: [0, 4],
      walletTopups: [0, 2],
      pointsTransactions: [10, 12],
      topupLogs: [0, 2],
      wishlists: [0, 0],
      sportsMatchVotes: [0, 0],
      sportsMatchRewards: [0, 0],
      coupons: [0, 0],
    };
    for (const [table, [donorCount, survivorCount]] of Object.entries(expectedOwnership)) {
      expect(preflight.snapshot?.ownershipInventory.find(row => row.table === table)).toMatchObject({ donorCount, survivorCount });
    }
    expect(preflight.snapshot?.postMergeActivity.every(row => row.donorCount === 0 && row.survivorCount === 0)).toBe(true);
  });

  it("fails closed before any mutation when execution is disabled or the exact incident scope is not authorized", async () => {
    const preflight = await readyPreflight();
    const authorizedScope = `${REQUEST}:${CASE}:${DONOR}:${SURVIVOR}:${IDENTITY}`;
    process.env[EXECUTION_ENABLED_ENV] = "false";
    try {
      const disabledGatePreflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
      expect(disabledGatePreflight.decision).toBe("READY");
      expect(disabledGatePreflight.snapshotDigest).toBe(preflight.snapshotDigest);
      await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: disabledGatePreflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    } finally {
      process.env[EXECUTION_ENABLED_ENV] = "true";
    }
    process.env[EXECUTION_SCOPE_ENV] = `${REQUEST}:${CASE}:${DONOR}:${SURVIVOR}:${IDENTITY + 1}`;
    try {
      await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "EXECUTION_SCOPE_MISMATCH" });
    } finally {
      process.env[EXECUTION_SCOPE_ENV] = authorizedScope;
    }
    const unauthorizedButSelfConsistentScope = `${REQUEST + 1}:${CASE}:${DONOR}:${SURVIVOR}:${IDENTITY}`;
    process.env[EXECUTION_SCOPE_ENV] = unauthorizedButSelfConsistentScope;
    try {
      await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, recoveryRequestId: REQUEST + 1, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "EXECUTION_SCOPE_MISMATCH" });
    } finally {
      process.env[EXECUTION_SCOPE_ENV] = authorizedScope;
    }
    expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
    expect(await tdb().select().from(accountMergeCompensations)).toHaveLength(0);
  });

  it("executes atomically: identity, canonical ownership and current 18.60 points move to Survivor while historical evidence stays byte-equivalent", async () => {
    const historicalBefore = await readHistoricalFingerprint();
    const result = await executeFromReadyPreflight();
    expect(result.alreadyCompleted).toBe(false);

    const persistedRequest = (
      await tdb().select().from(accountRecoveryRequests).where(eq(accountRecoveryRequests.id, REQUEST)).limit(1)
    )[0];
    expect(persistedRequest).toMatchObject({
      requesterUserId: SURVIVOR,
      status: "blocked",
      sourceUserId: null,
      targetUserId: null,
    });
    const lifecycle = await buildAccountRecoveryLifecycleProjection(persistedRequest as any);
    expect(lifecycle).toMatchObject({
      persistedStatus: "blocked",
      effectiveStatus: "resolved_via_historical_compensation",
      resolutionKind: "historical_merge_compensation",
      integrity: "verified",
      mergeCaseId: CASE,
    });

    const donorIdentity = await db.getAuthIdentityByUserAndProvider(DONOR, "google");
    const survivorIdentity = await db.getAuthIdentityByUserAndProvider(SURVIVOR, "google");
    const loginIdentity = await db.getAuthIdentity("google", SYNTHETIC_PROVIDER_SUBJECT);
    expect(donorIdentity).toBeUndefined();
    expect(survivorIdentity?.id).toBe(IDENTITY);
    expect(loginIdentity?.userId).toBe(SURVIVOR);
    expect(await db.getCompletedAccountMergeForSource(SURVIVOR)).toBeUndefined();
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("0.00");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("18.60");
    expect(await db.getAccountMergeWalletBalance(DONOR)).toBe("0.00");
    expect(await db.getAccountMergeWalletBalance(SURVIVOR)).toBe("0.00");
    expect(await ownerCount(orders, orders.userId, DONOR)).toBe(0);
    expect(await ownerCount(orders, orders.userId, SURVIVOR)).toBe(16);
    expect(await ownerCount(purchases, purchases.userId, DONOR)).toBe(0);
    expect(await ownerCount(purchases, purchases.userId, SURVIVOR)).toBe(82);
    expect(await ownerCount(couponUsages, couponUsages.userId, SURVIVOR)).toBe(12);
    expect(await ownerCount(readingProgress, readingProgress.userId, SURVIVOR)).toBe(31);
    expect(await readHistoricalFingerprint()).toBe(historicalBefore);

    const receiptRows = await tdb().select().from(accountMergeCompensationReceipts).where(eq(accountMergeCompensationReceipts.historicalMergeCaseId, CASE));
    expect(receiptRows).toHaveLength(1);
    const proof = JSON.parse(receiptRows[0].financialProof);
    expect(proof.points).toMatchObject({ donorBefore: "18.60", survivorBefore: "0.00", transferredCurrentBalance: "18.60", donorAfter: "0.00", survivorAfter: "18.60", totalBefore: "18.60", totalAfter: "18.60", ledgerRowsCreated: 2 });
    expect(proof.wallet).toMatchObject({ donorBefore: "0.00", survivorBefore: "0.00", transferredCurrentBalance: "0.00", totalBefore: "0.00", totalAfter: "0.00", ledgerRowsCreated: 0 });
    expect(JSON.stringify(receiptRows[0])).not.toContain(SYNTHETIC_PROVIDER_SUBJECT);
  });

  it("fails closed on stale identity owner", async () => {
    await tdb().update(authIdentities).set({ userId: SURVIVOR }).where(eq(authIdentities.id, IDENTITY));
    const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("IDENTITY_OWNER_DRIFT");
  });

  it("fails closed on stale current points and does not interpret the historical 9.60 as replayable credit", async () => {
    await tdb().insert(pointsTransactions).values({ userId: DONOR, type: "adjust", amount: "1.00", balanceAfter: "19.60", referenceType: "drift", referenceId: 1, note: "post merge drift", createdAt: POST_MERGE_AT });
    const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("CURRENT_FINANCIAL_DRIFT");
    expect(preflight.refusals.map(row => row.code)).toContain("POST_MERGE_ACTIVITY_DRIFT");
  });

  it("fails closed on Survivor ownership drift", async () => {
    await tdb().insert(orders).values({ orderNumber: "HIST-SURVIVOR-DRIFT", userId: SURVIVOR, status: "approved", paymentStatus: "approved", createdAt: HISTORICAL_AT, updatedAt: HISTORICAL_AT });
    const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("OWNERSHIP_DRIFT");
  });

  it("fails closed on a new post-merge order even when all role bindings remain unchanged", async () => {
    await tdb().insert(orders).values({ orderNumber: "HIST-POST-MERGE-DRIFT", userId: DONOR, status: "approved", paymentStatus: "approved", createdAt: POST_MERGE_AT, updatedAt: POST_MERGE_AT });
    const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("POST_MERGE_ACTIVITY_DRIFT");
  });

  it("fails closed when a classified Workspace domain has no compensation reconciliation semantics", async () => {
    await tdb().insert(workspaceWorkspaces).values({
      name: "Historical compensation blocker",
      ownerUserId: DONOR,
      status: "active",
      createdAt: HISTORICAL_AT,
      updatedAt: HISTORICAL_AT,
    });
    const preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("UNSUPPORTED_OWNERSHIP_DOMAIN");
  });

  it("fails closed on another merge workflow or recovery workflow involving either participant", async () => {
    await tdb().insert(accountMergeCases).values({
      id: CASE + 1,
      originAccountRecoveryRequestId: REQUEST + 1,
      sourceUserId: DONOR,
      targetUserId: SURVIVOR,
      status: "pending",
      createdByAdminId: ACTOR_ADMIN,
      createdAt: HISTORICAL_AT,
      updatedAt: HISTORICAL_AT,
    });
    let preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("CONFLICTING_MERGE_WORKFLOW");

    await tdb().delete(accountMergeCases).where(eq(accountMergeCases.id, CASE + 1));
    await tdb().insert(accountRecoveryRequests).values({
      id: REQUEST + 1,
      requesterUserId: DONOR,
      status: "pending",
      createdAt: HISTORICAL_AT,
      updatedAt: HISTORICAL_AT,
    });
    preflight = await buildHistoricalAccountMergeCompensationPreflight(baselineInput);
    expect(preflight.decision).toBe("REFUSE");
    expect(preflight.refusals.map(row => row.code)).toContain("CONFLICTING_RECOVERY_WORKFLOW");
  });

  it("binds execution to the exact deterministic snapshot digest", async () => {
    const preflight = await readyPreflight();
    await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: "0".repeat(64), actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "SNAPSHOT_DIGEST_DRIFT" });
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
    expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
    expect(preflight.snapshotDigest).not.toBe("0".repeat(64));
  });

  it("fails closed when a stale in-progress lifecycle indicates another worker owns the transition", async () => {
    const preflight = await readyPreflight();
    await tdb().insert(accountMergeCompensations).values({
      historicalMergeCaseId: CASE,
      recoveryRequestId: REQUEST,
      donorUserId: DONOR,
      survivorUserId: SURVIVOR,
      googleIdentityId: IDENTITY,
      status: "in_progress",
      expectedSnapshotDigest: preflight.snapshotDigest,
      createdByAdminId: ACTOR_ADMIN,
      startedAt: HISTORICAL_AT,
    });
    await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "COMPENSATION_STATE_CONFLICT" });
    const lifecycle = (await tdb().select().from(accountMergeCompensations).where(eq(accountMergeCompensations.historicalMergeCaseId, CASE)))[0];
    expect(lifecycle.status).toBe("in_progress");
    expect(await tdb().select().from(accountMergeCompensationReceipts)).toHaveLength(0);
    expect(await tdb().select().from(accountMergeCompensationAuditLogs)).toHaveLength(0);
    expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
  });

  it("fails closed when the historical financial receipt changes after the reviewed preflight", async () => {
    const preflight = await readyPreflight();
    await tdb()
      .update(accountMergeFinancialReconciliations)
      .set({ pointsTransferred: "9.61" })
      .where(eq(accountMergeFinancialReconciliations.mergeCaseId, CASE));

    await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "SNAPSHOT_DIGEST_DRIFT" });
    expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
    expect(await tdb().select().from(accountMergeCompensations)).toHaveLength(0);
    expect(await tdb().select().from(accountMergeCompensationReceipts)).toHaveLength(0);
  });

  it("fails closed when historical audit evidence changes after the reviewed preflight", async () => {
    const preflight = await readyPreflight();
    await tdb().insert(accountMergeAuditLogs).values({
      mergeCaseId: CASE,
      actorAdminId: ACTOR_ADMIN,
      action: "historical_fixture_drift",
      sourceUserId: SURVIVOR,
      targetUserId: DONOR,
      safeMetadata: JSON.stringify({ drift: true }),
      createdAt: HISTORICAL_AT,
    });
    await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "SNAPSHOT_DIGEST_DRIFT" });
    expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
    expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
    expect(await tdb().select().from(accountMergeCompensations)).toHaveLength(0);
    expect(await tdb().select().from(accountMergeCompensationReceipts)).toHaveLength(0);
  });

  for (const point of ["after_identity_move", "after_financial_compensation", "after_data_reconciliation"] as const) {
    it(`rolls back the whole side-effect transaction after ${point} and safely retries`, async () => {
      const preflight = await readyPreflight();
      const historicalBefore = await readHistoricalFingerprint();
      __setHistoricalAccountMergeCompensationFaultForTests(point);
      await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "INJECTED_CRASH" });
      __setHistoricalAccountMergeCompensationFaultForTests(null);
      expect((await db.getAuthIdentityByUserAndProvider(DONOR, "google"))?.id).toBe(IDENTITY);
      expect(await db.getAuthIdentityByUserAndProvider(SURVIVOR, "google")).toBeUndefined();
      expect(await db.getAccountMergePointsBalance(DONOR)).toBe("18.60");
      expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("0.00");
      expect(await ownerCount(orders, orders.userId, DONOR)).toBe(16);
      expect(await tdb().select().from(accountMergeCompensationReceipts)).toHaveLength(0);
      const lifecycleAfterCrash = await tdb().select().from(accountMergeCompensations).where(eq(accountMergeCompensations.historicalMergeCaseId, CASE));
      expect(lifecycleAfterCrash).toHaveLength(1);
      expect(lifecycleAfterCrash[0].status).toBe("failed");
      expect(await readHistoricalFingerprint()).toBe(historicalBefore);

      const retry = await executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN });
      expect(retry.alreadyCompleted).toBe(false);
      expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("18.60");
      expect(await tdb().select().from(accountMergeCompensationReceipts)).toHaveLength(1);
    });
  }

  it("treats a persisted receipt with a lost response as completed and retry produces no duplicate side effects", async () => {
    const preflight = await readyPreflight();
    __setHistoricalAccountMergeCompensationFaultForTests("after_receipt_commit");
    await expect(executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN })).rejects.toMatchObject({ code: "RESPONSE_LOST_AFTER_COMMIT" });
    __setHistoricalAccountMergeCompensationFaultForTests(null);

    const compensation = (await tdb().select().from(accountMergeCompensations).where(eq(accountMergeCompensations.historicalMergeCaseId, CASE)))[0];
    expect(compensation.status).toBe("completed");
    const ledgerCountBefore = await ownerCount(pointsTransactions, pointsTransactions.userId, DONOR) + await ownerCount(pointsTransactions, pointsTransactions.userId, SURVIVOR);
    const receiptCountBefore = (await tdb().select().from(accountMergeCompensationReceipts)).length;
    const retry = await executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: preflight.snapshotDigest, actorAdminId: ACTOR_ADMIN });
    expect(retry.alreadyCompleted).toBe(true);
    const ledgerCountAfter = await ownerCount(pointsTransactions, pointsTransactions.userId, DONOR) + await ownerCount(pointsTransactions, pointsTransactions.userId, SURVIVOR);
    expect(ledgerCountAfter).toBe(ledgerCountBefore);
    expect((await tdb().select().from(accountMergeCompensationReceipts)).length).toBe(receiptCountBefore);
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("18.60");
  });

  it("ordinary duplicate retry is idempotent and never double-credits 9.60 or current 18.60", async () => {
    const first = await executeFromReadyPreflight();
    const receiptId = Number(first.receipt.id);
    const pointRowsBefore = await tdb().select().from(pointsTransactions).where(eq(pointsTransactions.referenceType, "account_merge_compensation"));
    expect(pointRowsBefore).toHaveLength(2);
    expect(pointRowsBefore.map(row => String(row.amount)).sort()).toEqual(["-18.60", "18.60"]);

    const second = await executeHistoricalAccountMergeCompensation({ ...baselineInput, expectedSnapshotDigest: String(first.compensation.expectedSnapshotDigest), actorAdminId: ACTOR_ADMIN });
    expect(second.alreadyCompleted).toBe(true);
    expect(Number(second.receipt.id)).toBe(receiptId);
    expect(await tdb().select().from(pointsTransactions).where(eq(pointsTransactions.referenceType, "account_merge_compensation"))).toHaveLength(2);
    expect(await db.getAccountMergePointsBalance(SURVIVOR)).toBe("18.60");
  });

  it("releases the historical Source guard only for the compensated Survivor and keeps the Donor guarded", async () => {
    await executeFromReadyPreflight();
    await expect(tdb().transaction(tx => db.assertAccountMergeClassifiedMutationAllowed(SURVIVOR, tx))).resolves.toBeUndefined();
    await expect(tdb().transaction(tx => db.assertAccountMergeClassifiedMutationAllowed(DONOR, tx))).rejects.toBeInstanceOf(db.AccountMergeCompensationDonorGuardError);
  });
});
