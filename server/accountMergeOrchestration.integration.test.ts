import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeDataDedupeRecords,
  accountMergeDataReconciliations,
  accountMergeFinancialReconciliations,
  accountRecoveryRequests,
  authIdentities,
  episodePurchases,
  pointsTransactions,
  walletAccounts,
  walletTransactions,
  wishlists,
} from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import {
  createTestUser,
  deleteFixtures,
  uniqueTestTag,
} from "./test-helpers/fixtures";
import { reviewAccountRecoveryRequest } from "./services/accountRecoveryService";
import { buildAccountMergePreview } from "./services/accountMergePreviewService";
import {
  __setAccountMergeOrchestrationFaultForTests,
  executeAccountMerge,
  getAccountMergeExecutionStatus,
  type AccountMergeOrchestrationFaultPoint,
} from "./services/accountMergeOrchestrationService";
import { buildAccountMergeConfirmationText } from "../shared/accountMergeConfirmation";
import { resolveGoogleIdentity } from "./services/googleIdentityService";
import {
  prepareAccountMergeGuard,
  startAccountMergeGuard,
} from "./services/accountMergeGuardService";
import { reconcileAccountMergeFinancials } from "./services/accountMergeFinancialReconciliationService";

type Fixture = {
  sourceId: number;
  targetId: number;
  requestId: number;
  providerSubject: string;
  emailAtLink: string;
};

const fixtures: Fixture[] = [];

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "IPE-008 integration tests require TEST_DATABASE_URL=.../ipenovel_test"
    );
  }
  return getTestDb();
}

function insertedId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0)
    throw new Error("Unable to read inserted fixture id");
  return id;
}

async function createFixture(): Promise<Fixture> {
  const t = requireTestDb();
  const source = await createTestUser(); // Donor: inaccessible legacy account
  const target = await createTestUser(); // Survivor: current requester account
  const providerSubject = `ipe008-sub-${uniqueTestTag()}`;
  const emailAtLink = `ipe008-${uniqueTestTag()}@example.test`;
  await t.insert(authIdentities).values({
    userId: target.id,
    provider: "google",
    providerSubject,
    emailAtLink,
  });

  const request = await db.createAccountRecoveryRequest({
    requesterUserId: target.id,
  });
  await reviewAccountRecoveryRequest({
    requestId: request.id,
    action: "block",
    actorAdminId: 1,
    reason: "IPE-008 final orchestration integration fixture",
  });

  const fixture: Fixture = {
    sourceId: source.id,
    targetId: target.id,
    requestId: request.id,
    providerSubject,
    emailAtLink,
  };
  fixtures.push(fixture);
  return fixture;
}

async function seedMergeData(f: Fixture) {
  const t = requireTestDb();
  await t.insert(walletAccounts).values([
    { userId: f.sourceId, balance: "30.00" },
    { userId: f.targetId, balance: "10.00" },
  ]);
  await t.insert(pointsTransactions).values([
    {
      userId: f.sourceId,
      type: "earn",
      amount: "20.00",
      balanceAfter: "20.00",
      note: "IPE-008 source seed",
    },
    {
      userId: f.targetId,
      type: "earn",
      amount: "5.00",
      balanceAfter: "5.00",
      note: "IPE-008 target seed",
    },
  ]);
  await t.insert(episodePurchases).values({
    userId: f.sourceId,
    novelId: 9001,
    episodeId: 900101,
    pricePaid: "3.00",
  });
  await t.insert(wishlists).values({ userId: f.sourceId, novelId: 9002 });

}

async function cleanupFixture(f: Fixture) {
  const t = requireTestDb();
  const userIds = [f.sourceId, f.targetId];
  const cases = await t
    .select({ id: accountMergeCases.id })
    .from(accountMergeCases)
    .where(eq(accountMergeCases.originAccountRecoveryRequestId, f.requestId));
  const caseIds = cases.map(row => row.id);

  if (caseIds.length > 0) {
    await t
      .delete(accountMergeDataDedupeRecords)
      .where(inArray(accountMergeDataDedupeRecords.mergeCaseId, caseIds));
    await t
      .delete(accountMergeDataReconciliations)
      .where(inArray(accountMergeDataReconciliations.mergeCaseId, caseIds));
    await t
      .delete(accountMergeFinancialReconciliations)
      .where(
        inArray(accountMergeFinancialReconciliations.mergeCaseId, caseIds)
      );
    await t
      .delete(accountMergeAuditLogs)
      .where(inArray(accountMergeAuditLogs.mergeCaseId, caseIds));
    await t
      .delete(accountMergeCases)
      .where(inArray(accountMergeCases.id, caseIds));
  }

  await t
    .delete(episodePurchases)
    .where(inArray(episodePurchases.userId, userIds));
  await t.delete(wishlists).where(inArray(wishlists.userId, userIds));
  await t
    .delete(walletTransactions)
    .where(inArray(walletTransactions.userId, userIds));
  await t.delete(walletAccounts).where(inArray(walletAccounts.userId, userIds));
  await t
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, userIds));
  await t.delete(authIdentities).where(inArray(authIdentities.userId, userIds));
  await t
    .delete(accountRecoveryRequests)
    .where(eq(accountRecoveryRequests.id, f.requestId));
  await deleteFixtures({ userIds });
}

async function execute(f: Fixture, adminId = 1) {
  return executeAccountMerge({
    requestId: f.requestId,
    donorAccountId: f.sourceId,
    survivorAccountId: f.targetId,
    adminId,
    reason: "Verified ownership and final merge reconciliation",
    confirmation: buildAccountMergeConfirmationText(f.sourceId, f.targetId),
  });
}

async function expectNoFinalEffects(f: Fixture) {
  const t = requireTestDb();
  const [
    sourceIdentity,
    targetIdentity,
    sourceWallet,
    targetWallet,
    sourceEpisode,
    sourceWishlist,
    cases,
  ] = await Promise.all([
    db.getAuthIdentityByUserAndProvider(f.sourceId, "google"),
    db.getAuthIdentityByUserAndProvider(f.targetId, "google"),
    t
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, f.sourceId))
      .limit(1),
    t
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.userId, f.targetId))
      .limit(1),
    t
      .select()
      .from(episodePurchases)
      .where(eq(episodePurchases.userId, f.sourceId)),
    t.select().from(wishlists).where(eq(wishlists.userId, f.sourceId)),
    t
      .select()
      .from(accountMergeCases)
      .where(eq(accountMergeCases.originAccountRecoveryRequestId, f.requestId)),
  ]);
  expect(sourceIdentity).toBeUndefined();
  expect(targetIdentity?.providerSubject).toBe(f.providerSubject);
  expect(sourceWallet[0]?.balance).toBe("30.00");
  expect(targetWallet[0]?.balance).toBe("10.00");
  expect(sourceEpisode).toHaveLength(1);
  expect(sourceWishlist).toHaveLength(1);
  expect(cases).toHaveLength(0);
}

describe.sequential(
  "IPE-008 final Account Merge orchestration - real database",
  () => {
    beforeAll(async () => {
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
      await assertLiveTestDatabaseName(getTestDb());
    });

    afterEach(async () => {
      __setAccountMergeOrchestrationFaultForTests(null);
      while (fixtures.length > 0) await cleanupFixture(fixtures.pop()!);
    });

    it("full success is atomic/idempotent, reconciles Donor into requester Survivor, preserves Survivor Google ownership, and fresh Google login still resolves Survivor", async () => {
      const f = await createFixture();
      await seedMergeData(f);

      const preview = await buildAccountMergePreview({
        requestId: f.requestId,
        sourceUserId: f.sourceId,
        targetUserId: f.targetId,
      });
      expect(preview.isPreviewValid).toBe(true);
      expect(preview.walletProjection).toMatchObject({
        sourceBalance: "30.00",
        targetBalance: "10.00",
        projectedMergedBalance: "40.00",
      });
      expect(preview.pointsProjection).toMatchObject({
        sourceBalance: "20.00",
        targetBalance: "5.00",
        projectedMergedBalance: "25.00",
      });

      const result = await execute(f);
      expect(result.alreadyCompleted).toBe(false);
      expect(result.status).toBe("completed");
      expect(result.identityMoved).toBe(false);
      expect(result.identityPreservedOnSurvivor).toBe(true);
      expect(result.financial.wallet).toMatchObject({
        sourceBefore: "30.00",
        targetBefore: "10.00",
        sourceAfter: "0.00",
        targetAfter: "40.00",
      });
      expect(result.financial.points).toMatchObject({
        sourceBefore: "20.00",
        targetBefore: "5.00",
        sourceAfter: "0.00",
        targetAfter: "25.00",
      });

      const t = requireTestDb();
      const [
        sourceWallet,
        targetWallet,
        sourcePoints,
        targetPoints,
        sourceIdentity,
        targetIdentity,
        sourceUser,
        episodeRows,
        wishlistRows,
      ] = await Promise.all([
        t
          .select()
          .from(walletAccounts)
          .where(eq(walletAccounts.userId, f.sourceId))
          .limit(1),
        t
          .select()
          .from(walletAccounts)
          .where(eq(walletAccounts.userId, f.targetId))
          .limit(1),
        db.getUserPointsBalance(f.sourceId),
        db.getUserPointsBalance(f.targetId),
        db.getAuthIdentityByUserAndProvider(f.sourceId, "google"),
        db.getAuthIdentityByUserAndProvider(f.targetId, "google"),
        db.getUserById(f.sourceId),
        t
          .select()
          .from(episodePurchases)
          .where(eq(episodePurchases.episodeId, 900101)),
        t.select().from(wishlists).where(eq(wishlists.novelId, 9002)),
      ]);
      expect(sourceWallet[0].balance).toBe("0.00");
      expect(targetWallet[0].balance).toBe("40.00");
      expect(sourcePoints).toBe("0.00");
      expect(targetPoints).toBe("25.00");
      expect(sourceIdentity).toBeUndefined();
      expect(targetIdentity?.providerSubject).toBe(f.providerSubject);
      expect(sourceUser?.id).toBe(f.sourceId);
      expect(episodeRows).toHaveLength(1);
      expect(episodeRows[0].userId).toBe(f.targetId);
      expect(wishlistRows).toHaveLength(1);
      expect(wishlistRows[0].userId).toBe(f.targetId);


      const resolution = await resolveGoogleIdentity({
        sub: f.providerSubject,
        email: f.emailAtLink,
        emailVerified: true,
        name: "Merged User",
      });
      expect(resolution.user.id).toBe(f.targetId);

      const retry = await execute(f, 2);
      expect(retry.alreadyCompleted).toBe(true);
      expect(retry.mergeCaseId).toBe(result.mergeCaseId);
      expect(retry.auditLogId).toBe(result.auditLogId);

      const [financialReceipts, dataReceipts, completionAudits, status] =
        await Promise.all([
          t
            .select()
            .from(accountMergeFinancialReconciliations)
            .where(
              eq(
                accountMergeFinancialReconciliations.mergeCaseId,
                result.mergeCaseId
              )
            ),
          t
            .select()
            .from(accountMergeDataReconciliations)
            .where(
              eq(
                accountMergeDataReconciliations.mergeCaseId,
                result.mergeCaseId
              )
            ),
          t
            .select()
            .from(accountMergeAuditLogs)
            .where(
              and(
                eq(accountMergeAuditLogs.mergeCaseId, result.mergeCaseId),
                eq(accountMergeAuditLogs.action, "merge_completed")
              )
            ),
          getAccountMergeExecutionStatus(f.requestId),
        ]);
      expect(financialReceipts).toHaveLength(1);
      expect(dataReceipts).toHaveLength(1);
      expect(completionAudits).toHaveLength(1);
      expect(status).toMatchObject({
        status: "completed",
        mergeCaseId: result.mergeCaseId,
        auditLogId: result.auditLogId,
      });

      const metadata = completionAudits[0].safeMetadata ?? "";
      expect(metadata).toContain(
        "Verified ownership and final merge reconciliation"
      );
      expect(metadata).toContain("tableActions");

      expect(metadata).not.toContain(f.providerSubject);
      expect(metadata).not.toContain(f.emailAtLink);
      expect(metadata.toLowerCase()).not.toContain("token");
    });

    it("refuses reversed explicit Donor/Survivor roles before creating a merge case or moving any value", async () => {
      const f = await createFixture();
      await seedMergeData(f);

      await expect(
        executeAccountMerge({
          requestId: f.requestId,
          donorAccountId: f.targetId,
          survivorAccountId: f.sourceId,
          adminId: 1,
          reason: "attempted reversed role binding",
          confirmation: buildAccountMergeConfirmationText(f.targetId, f.sourceId),
        })
      ).rejects.toMatchObject({ code: "ROLE_MISMATCH" });

      await expectNoFinalEffects(f);
    });

    it("re-runs the final preview under locks and aborts cleanly when Donor connects Google after an earlier valid preview", async () => {
      const f = await createFixture();
      await seedMergeData(f);
      const earlier = await buildAccountMergePreview({
        requestId: f.requestId,
        sourceUserId: f.sourceId,
        targetUserId: f.targetId,
      });
      expect(earlier.isPreviewValid).toBe(true);

      await requireTestDb()
        .insert(authIdentities)
        .values({
          userId: f.sourceId,
          provider: "google",
          providerSubject: `donor-drift-${uniqueTestTag()}`,
          emailAtLink: `donor-drift-${uniqueTestTag()}@example.test`,
        });

      await expect(execute(f)).rejects.toMatchObject({
        code: "FINAL_PREVIEW_BLOCKED",
      });
      const cases = await requireTestDb()
        .select()
        .from(accountMergeCases)
        .where(
          eq(accountMergeCases.originAccountRecoveryRequestId, f.requestId)
        );
      expect(cases).toHaveLength(0);
      const wallets = await requireTestDb()
        .select()
        .from(walletAccounts)
        .where(inArray(walletAccounts.userId, [f.sourceId, f.targetId]));
      expect(wallets.find(row => row.userId === f.sourceId)?.balance).toBe(
        "30.00"
      );
      expect(wallets.find(row => row.userId === f.targetId)?.balance).toBe(
        "10.00"
      );
    });

    it.each<AccountMergeOrchestrationFaultPoint>([
      "after_preview",
      "after_guard_start",
      "after_financial",
      "after_data",
      "after_auth_move",
      "before_complete",
    ])(
      "fault at %s rolls back case/financial/data/auth/user-data as one outer transaction",
      async faultPoint => {
        const f = await createFixture();
        await seedMergeData(f);
        __setAccountMergeOrchestrationFaultForTests(faultPoint);

        await expect(execute(f)).rejects.toThrow(
          `Injected Account Merge orchestration failure at ${faultPoint}`
        );
        await expectNoFinalEffects(f);
      }
    );

    it("two-admin/double-click concurrency produces one value movement and one completion audit", async () => {
      const f = await createFixture();
      await seedMergeData(f);

      const results = await Promise.all([execute(f, 1), execute(f, 2)]);
      expect(results.map(result => result.alreadyCompleted).sort()).toEqual([
        false,
        true,
      ]);
      const caseId = results[0].mergeCaseId;
      expect(results[1].mergeCaseId).toBe(caseId);

      const t = requireTestDb();
      const [receipts, dataReceipts, completionAudits, targetWallet] =
        await Promise.all([
          t
            .select()
            .from(accountMergeFinancialReconciliations)
            .where(
              eq(accountMergeFinancialReconciliations.mergeCaseId, caseId)
            ),
          t
            .select()
            .from(accountMergeDataReconciliations)
            .where(eq(accountMergeDataReconciliations.mergeCaseId, caseId)),
          t
            .select()
            .from(accountMergeAuditLogs)
            .where(
              and(
                eq(accountMergeAuditLogs.mergeCaseId, caseId),
                eq(accountMergeAuditLogs.action, "merge_completed")
              )
            ),
          t
            .select()
            .from(walletAccounts)
            .where(eq(walletAccounts.userId, f.targetId))
            .limit(1),
        ]);
      expect(receipts).toHaveLength(1);
      expect(dataReceipts).toHaveLength(1);
      expect(completionAudits).toHaveLength(1);
      expect(targetWallet[0].balance).toBe("40.00");
      expect(await db.getUserPointsBalance(f.targetId)).toBe("25.00");
    });

    it("fails closed on a pre-existing standalone financial receipt instead of falsely claiming one-transaction Phase-5 atomicity", async () => {
      const f = await createFixture();
      await seedMergeData(f);
      const prepared = await prepareAccountMergeGuard({
        requestId: f.requestId,
        donorUserId: f.sourceId,
        actorAdminId: 1,
      });
      await startAccountMergeGuard(prepared.id, 1);
      await reconcileAccountMergeFinancials({
        caseId: prepared.id,
        actorAdminId: 1,
      });

      await expect(execute(f)).rejects.toMatchObject({
        code: "PARTIAL_RECONCILIATION_STATE",
      });
      expect(
        await db.getAuthIdentityByUserAndProvider(f.sourceId, "google")
      ).toBeUndefined();
      expect(
        await db.getAuthIdentityByUserAndProvider(f.targetId, "google")
      ).toBeTruthy();
      const receipt = await requireTestDb()
        .select()
        .from(accountMergeFinancialReconciliations)
        .where(
          eq(accountMergeFinancialReconciliations.mergeCaseId, prepared.id)
        );
      expect(receipt).toHaveLength(1);
    });
  }
);
