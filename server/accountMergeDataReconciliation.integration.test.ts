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
  cartItems,
  carts,
  couponUsages,
  coupons,
  dailyCheckinRewardGrants,
  dailyCheckins,
  episodePurchases,
  orderHistory,
  orderItems,
  orders,
  paymentSlipClaims,
  payments,
  pointsTransactions,
  purchases,
  readingProgress,
  sportsMatchRewards,
  sportsMatchVotes,
  walletAccounts,
  walletTopups,
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
import {
  prepareAccountMergeGuard,
  startAccountMergeGuard,
} from "./services/accountMergeGuardService";
import { reconcileAccountMergeFinancials } from "./services/accountMergeFinancialReconciliationService";
import {
  __setAccountMergeDataFaultForTests,
  reconcileAccountMergeData,
} from "./services/accountMergeDataReconciliationService";

type DataFixture = {
  sourceId: number;
  targetId: number;
  requestId: number;
  identityId: number;
  caseId: number;
  couponIds: number[];
  extraCaseIds: number[];
};

const fixtures: DataFixture[] = [];

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "IPE-007 integration tests require TEST_DATABASE_URL=.../ipenovel_test"
    );
  }
  return getTestDb();
}

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0)
    throw new Error("Unable to read inserted fixture id");
  return id;
}

async function createMergePair(
  options: { financial?: boolean } = {}
): Promise<DataFixture> {
  const t = requireTestDb();
  const source = await createTestUser();
  const target = await createTestUser();
  const identityResult: any = await t.insert(authIdentities).values({
    userId: source.id,
    provider: "google",
    providerSubject: `ipe007-google-${uniqueTestTag()}`,
    emailAtLink: `ipe007-${uniqueTestTag()}@example.test`,
  });
  const identityId = insertId(identityResult);
  const request = await db.createAccountRecoveryRequest({
    requesterUserId: source.id,
  });
  await reviewAccountRecoveryRequest({
    requestId: request.id,
    action: "block",
    actorAdminId: 1,
    reason: "IPE-007 entitlement/user-data integration fixture",
  });
  const prepared = await prepareAccountMergeGuard({
    requestId: request.id,
    targetUserId: target.id,
    actorAdminId: 1,
  });
  await startAccountMergeGuard(prepared.id, 1);

  const fixture: DataFixture = {
    sourceId: source.id,
    targetId: target.id,
    requestId: request.id,
    identityId,
    caseId: prepared.id,
    couponIds: [],
    extraCaseIds: [],
  };
  fixtures.push(fixture);

  if (options.financial !== false) {
    await reconcileAccountMergeFinancials({
      caseId: prepared.id,
      actorAdminId: 1,
    });
  }
  return fixture;
}

async function createOrder(
  userId: number,
  status: "pending" | "approved" | "rejected" | "cancelled" = "approved"
) {
  const result: any = await requireTestDb()
    .insert(orders)
    .values({
      orderNumber: `IPE007-${uniqueTestTag()}`.slice(0, 50),
      userId,
      status,
    });
  return insertId(result);
}

async function createCoupon(f: DataFixture, ownerUserId: number | null = null) {
  const result: any = await requireTestDb()
    .insert(coupons)
    .values({
      code: `I7${uniqueTestTag()}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 48),
      discountType: "flat",
      discountValue: "5.00",
      scope: ownerUserId == null ? "global" : "user",
      ownerUserId,
    });
  const id = insertId(result);
  f.couponIds.push(id);
  return id;
}

async function readById(table: any, idColumn: any, id: number) {
  return (
    await requireTestDb().select().from(table).where(eq(idColumn, id)).limit(1)
  )[0];
}

async function cleanupFixture(f: DataFixture) {
  const t = requireTestDb();
  const users = [f.sourceId, f.targetId];

  await t
    .delete(paymentSlipClaims)
    .where(inArray(paymentSlipClaims.userId, users));
  await t
    .delete(accountMergeDataDedupeRecords)
    .where(eq(accountMergeDataDedupeRecords.mergeCaseId, f.caseId));
  await t
    .delete(accountMergeDataReconciliations)
    .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId));
  await t
    .delete(accountMergeAuditLogs)
    .where(eq(accountMergeAuditLogs.mergeCaseId, f.caseId));
  await t
    .delete(accountMergeFinancialReconciliations)
    .where(eq(accountMergeFinancialReconciliations.mergeCaseId, f.caseId));

  await t
    .delete(sportsMatchRewards)
    .where(inArray(sportsMatchRewards.userId, users));
  await t
    .delete(sportsMatchVotes)
    .where(inArray(sportsMatchVotes.userId, users));
  await t
    .delete(dailyCheckinRewardGrants)
    .where(inArray(dailyCheckinRewardGrants.userId, users));
  await t.delete(dailyCheckins).where(inArray(dailyCheckins.userId, users));
  await t.delete(couponUsages).where(inArray(couponUsages.userId, users));
  await t.delete(purchases).where(inArray(purchases.userId, users));
  await t
    .delete(episodePurchases)
    .where(inArray(episodePurchases.userId, users));
  await t.delete(readingProgress).where(inArray(readingProgress.userId, users));
  await t.delete(wishlists).where(inArray(wishlists.userId, users));

  const cartRows = await t
    .select({ id: carts.id })
    .from(carts)
    .where(inArray(carts.userId, users));
  if (cartRows.length > 0)
    await t.delete(cartItems).where(
      inArray(
        cartItems.cartId,
        cartRows.map(row => row.id)
      )
    );
  await t.delete(carts).where(inArray(carts.userId, users));

  const orderRows = await t
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.userId, users));
  if (orderRows.length > 0) {
    const orderIds = orderRows.map(row => row.id);
    await t.delete(orderHistory).where(inArray(orderHistory.orderId, orderIds));
    await t.delete(payments).where(inArray(payments.orderId, orderIds));
    await t.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
  }
  await t.delete(orders).where(inArray(orders.userId, users));

  await t
    .delete(walletTransactions)
    .where(inArray(walletTransactions.userId, users));
  await t.delete(walletTopups).where(inArray(walletTopups.userId, users));
  await t.delete(walletAccounts).where(inArray(walletAccounts.userId, users));
  await t
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, users));

  if (f.couponIds.length > 0)
    await t.delete(coupons).where(inArray(coupons.id, f.couponIds));
  await t.delete(coupons).where(inArray(coupons.ownerUserId, users));

  for (const id of f.extraCaseIds) {
    await t
      .delete(accountMergeAuditLogs)
      .where(eq(accountMergeAuditLogs.mergeCaseId, id));
    await t.delete(accountMergeCases).where(eq(accountMergeCases.id, id));
  }
  await t.delete(accountMergeCases).where(eq(accountMergeCases.id, f.caseId));
  await t
    .delete(accountRecoveryRequests)
    .where(eq(accountRecoveryRequests.id, f.requestId));
  await t.delete(authIdentities).where(eq(authIdentities.id, f.identityId));
  await deleteFixtures({ userIds: users });
}

describe.sequential(
  "IPE-007 Account Merge entitlement + user-data reconciliation - real database",
  () => {
    beforeAll(async () => {
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
      await assertLiveTestDatabaseName(getTestDb());
    });

    afterEach(async () => {
      __setAccountMergeDataFaultForTests(null);
      while (fixtures.length > 0) await cleanupFixture(fixtures.pop()!);
    });

    it("reparents orders/entitlements/coupon ownership while preserving order child IDs/history", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const orderId = await createOrder(f.sourceId);
      const itemId = insertId(
        await t.insert(orderItems).values({
          orderId,
          novelId: 10,
          episodeId: 1001,
          unitPrice: "10.00",
          finalPrice: "10.00",
        })
      );
      const paymentId = insertId(
        await t.insert(payments).values({
          orderId,
          ocrConfidence: 0,
          ocrDecision: "needs_review",
        })
      );
      const historyId = insertId(
        await t.insert(orderHistory).values({ orderId, action: "created" })
      );
      const purchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.sourceId,
          novelId: 10,
          episodeId: 1001,
          orderId,
        })
      );
      const couponId = await createCoupon(f, f.sourceId);
      const usageId = insertId(
        await t
          .insert(couponUsages)
          .values({ couponId, userId: f.sourceId, orderId })
      );

      const before = {
        item: await readById(orderItems, orderItems.id, itemId),
        payment: await readById(payments, payments.id, paymentId),
        history: await readById(orderHistory, orderHistory.id, historyId),
      };

      const result = await reconcileAccountMergeData({
        caseId: f.caseId,
        actorAdminId: 7,
      });
      expect(result.alreadyReconciled).toBe(false);
      expect((await readById(orders, orders.id, orderId)).userId).toBe(
        f.targetId
      );
      expect((await readById(purchases, purchases.id, purchaseId)).userId).toBe(
        f.targetId
      );
      expect(await db.getPurchaseByUserAndEpisode(f.targetId, 1001)).toEqual(
        expect.objectContaining({ id: purchaseId })
      );
      expect(
        await db.getPurchaseByUserAndEpisode(f.sourceId, 1001)
      ).toBeUndefined();
      expect(
        (await readById(couponUsages, couponUsages.id, usageId)).userId
      ).toBe(f.targetId);
      expect((await readById(coupons, coupons.id, couponId)).ownerUserId).toBe(
        f.targetId
      );
      expect(await readById(orderItems, orderItems.id, itemId)).toEqual(
        before.item
      );
      expect(await readById(payments, payments.id, paymentId)).toEqual(
        before.payment
      );
      expect(await readById(orderHistory, orderHistory.id, historyId)).toEqual(
        before.history
      );
      expect(
        (await readById(authIdentities, authIdentities.id, f.identityId)).userId
      ).toBe(f.sourceId);

      const receipt = await t
        .select()
        .from(accountMergeDataReconciliations)
        .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId));
      const audits = await t
        .select()
        .from(accountMergeAuditLogs)
        .where(
          and(
            eq(accountMergeAuditLogs.mergeCaseId, f.caseId),
            eq(accountMergeAuditLogs.action, "data_reconciled")
          )
        );
      expect(receipt).toHaveLength(1);
      expect(audits).toHaveLength(1);
    }, 30000);

    it("dedupes overlapping purchases + wallet episode entitlements with immutable source->target mapping", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceOrderId = await createOrder(f.sourceId);
      const targetOrderId = await createOrder(f.targetId);
      const sourcePurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.sourceId,
          novelId: 20,
          episodeId: 2001,
          orderId: sourceOrderId,
        })
      );
      const targetPurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.targetId,
          novelId: 20,
          episodeId: 2001,
          orderId: targetOrderId,
        })
      );
      const sourceWalletPurchaseId = insertId(
        await t.insert(episodePurchases).values({
          userId: f.sourceId,
          novelId: 20,
          episodeId: 2002,
          pricePaid: "3.00",
        })
      );
      const targetWalletPurchaseId = insertId(
        await t.insert(episodePurchases).values({
          userId: f.targetId,
          novelId: 20,
          episodeId: 2002,
          pricePaid: "4.00",
        })
      );

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        await readById(purchases, purchases.id, sourcePurchaseId)
      ).toBeUndefined();
      expect(
        (await readById(purchases, purchases.id, targetPurchaseId)).userId
      ).toBe(f.targetId);
      expect(
        await readById(
          episodePurchases,
          episodePurchases.id,
          sourceWalletPurchaseId
        )
      ).toBeUndefined();
      expect(
        (
          await readById(
            episodePurchases,
            episodePurchases.id,
            targetWalletPurchaseId
          )
        ).userId
      ).toBe(f.targetId);
      expect((await readById(orders, orders.id, sourceOrderId)).userId).toBe(
        f.targetId
      );

      const dedupes = await t
        .select()
        .from(accountMergeDataDedupeRecords)
        .where(eq(accountMergeDataDedupeRecords.mergeCaseId, f.caseId));
      expect(dedupes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            domain: "purchases",
            sourceRowId: sourcePurchaseId,
            targetRowId: targetPurchaseId,
          }),
          expect.objectContaining({
            domain: "episodePurchases",
            sourceRowId: sourceWalletPurchaseId,
            targetRowId: targetWalletPurchaseId,
          }),
        ])
      );
    }, 30000);

    it("keeps the Source approved purchase when the Target duplicate is rejected so reader access survives", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceOrderId = await createOrder(f.sourceId, "approved");
      const targetOrderId = await createOrder(f.targetId, "rejected");
      const sourcePurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.sourceId,
          novelId: 21,
          episodeId: 2101,
          orderId: sourceOrderId,
        })
      );
      const targetPurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.targetId,
          novelId: 21,
          episodeId: 2101,
          orderId: targetOrderId,
        })
      );

      expect(await db.getPurchaseByUserAndEpisode(f.sourceId, 2101)).toEqual(
        expect.objectContaining({ id: sourcePurchaseId })
      );
      expect(
        await db.getPurchaseByUserAndEpisode(f.targetId, 2101)
      ).toBeUndefined();

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        (await readById(purchases, purchases.id, sourcePurchaseId)).userId
      ).toBe(f.targetId);
      expect(
        await readById(purchases, purchases.id, targetPurchaseId)
      ).toBeUndefined();
      expect(await db.getPurchaseByUserAndEpisode(f.targetId, 2101)).toEqual(
        expect.objectContaining({ id: sourcePurchaseId })
      );
      expect(
        await db.getPurchaseByUserAndEpisode(f.sourceId, 2101)
      ).toBeUndefined();

      const [dedupe] = await t
        .select()
        .from(accountMergeDataDedupeRecords)
        .where(eq(accountMergeDataDedupeRecords.mergeCaseId, f.caseId));
      expect(JSON.parse(String(dedupe.safeMetadata))).toMatchObject({
        sourceOrderStatus: "approved",
        targetOrderStatus: "rejected",
        keptPurchaseId: sourcePurchaseId,
        removedPurchaseId: targetPurchaseId,
        resolution: "source_approved_kept",
      });
    }, 30000);

    it("keeps the Target approved purchase when the Source duplicate is rejected", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceOrderId = await createOrder(f.sourceId, "rejected");
      const targetOrderId = await createOrder(f.targetId, "approved");
      const sourcePurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.sourceId,
          novelId: 22,
          episodeId: 2201,
          orderId: sourceOrderId,
        })
      );
      const targetPurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.targetId,
          novelId: 22,
          episodeId: 2201,
          orderId: targetOrderId,
        })
      );

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        await readById(purchases, purchases.id, sourcePurchaseId)
      ).toBeUndefined();
      expect(
        (await readById(purchases, purchases.id, targetPurchaseId)).userId
      ).toBe(f.targetId);
      expect(await db.getPurchaseByUserAndEpisode(f.targetId, 2201)).toEqual(
        expect.objectContaining({ id: targetPurchaseId })
      );
    }, 30000);

    it("fails closed when duplicate purchases are both reader-invalid instead of guessing which future entitlement to keep", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceOrderId = await createOrder(f.sourceId, "pending");
      const targetOrderId = await createOrder(f.targetId, "rejected");
      const sourcePurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.sourceId,
          novelId: 23,
          episodeId: 2301,
          orderId: sourceOrderId,
        })
      );
      const targetPurchaseId = insertId(
        await t.insert(purchases).values({
          userId: f.targetId,
          novelId: 23,
          episodeId: 2301,
          orderId: targetOrderId,
        })
      );

      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "PURCHASE_ENTITLEMENT_CONFLICT" });
      expect(
        (await readById(purchases, purchases.id, sourcePurchaseId)).userId
      ).toBe(f.sourceId);
      expect(
        (await readById(purchases, purchases.id, targetPurchaseId)).userId
      ).toBe(f.targetId);
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);

    it("consolidates cart/wishlist/progress deterministically without losing the latest safe user state", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceCartId = insertId(
        await t.insert(carts).values({ userId: f.sourceId })
      );
      const targetCartId = insertId(
        await t.insert(carts).values({ userId: f.targetId })
      );
      await t.insert(cartItems).values([
        {
          cartId: sourceCartId,
          episodeId: 3001,
          novelId: 30,
          price: "5.00",
          createdAt: new Date("2026-08-29T02:00:00Z"),
        },
        {
          cartId: sourceCartId,
          episodeId: 3002,
          novelId: 30,
          price: "7.00",
          createdAt: new Date("2026-08-29T03:00:00Z"),
        },
        {
          cartId: targetCartId,
          episodeId: 3002,
          novelId: 30,
          price: "9.00",
          createdAt: new Date("2026-08-29T01:00:00Z"),
        },
        {
          cartId: targetCartId,
          episodeId: 3003,
          novelId: 30,
          price: "8.00",
          createdAt: new Date("2026-08-29T04:00:00Z"),
        },
      ]);

      await t.insert(wishlists).values([
        { userId: f.sourceId, novelId: 31 },
        { userId: f.sourceId, novelId: 32 },
        { userId: f.targetId, novelId: 31 },
      ]);

      await t.insert(readingProgress).values([
        {
          userId: f.sourceId,
          novelId: 33,
          episodeId: 3301,
          progressPercent: 80,
          scrollPosition: 800,
          lastReadAt: new Date("2026-08-29T05:00:00Z"),
          updatedAt: new Date("2026-08-29T05:00:00Z"),
        },
        {
          userId: f.targetId,
          novelId: 33,
          episodeId: 3301,
          progressPercent: 20,
          scrollPosition: 200,
          lastReadAt: new Date("2026-08-29T01:00:00Z"),
          updatedAt: new Date("2026-08-29T01:00:00Z"),
        },
        {
          userId: f.sourceId,
          novelId: 33,
          episodeId: 3302,
          progressPercent: 40,
          scrollPosition: 400,
        },
      ]);

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        await t.select().from(carts).where(eq(carts.userId, f.sourceId))
      ).toHaveLength(0);
      const targetItems = await t
        .select()
        .from(cartItems)
        .where(eq(cartItems.cartId, targetCartId));
      expect(targetItems.map(row => row.episodeId).sort()).toEqual([
        3001, 3002, 3003,
      ]);
      expect(targetItems.find(row => row.episodeId === 3002)?.price).toBe(
        "7.00"
      );

      const targetWishlist = await t
        .select()
        .from(wishlists)
        .where(eq(wishlists.userId, f.targetId));
      expect(targetWishlist.map(row => row.novelId).sort()).toEqual([31, 32]);
      expect(
        await t.select().from(wishlists).where(eq(wishlists.userId, f.sourceId))
      ).toHaveLength(0);

      const targetProgress = await t
        .select()
        .from(readingProgress)
        .where(eq(readingProgress.userId, f.targetId));
      expect(targetProgress).toHaveLength(2);
      expect(targetProgress.find(row => row.episodeId === 3301)).toMatchObject({
        progressPercent: 80,
        scrollPosition: 800,
      });
      expect(
        await t
          .select()
          .from(readingProgress)
          .where(eq(readingProgress.userId, f.sourceId))
      ).toHaveLength(0);
    }, 30000);

    it("moves sports/check-in reward ownership without minting any new reward", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sportsCouponId = await createCoupon(f);
      const dailyCouponId = await createCoupon(f);
      const voteId = insertId(
        await t.insert(sportsMatchVotes).values({
          matchId: 4001,
          userId: f.sourceId,
          prediction: "home_win",
          pointsSpent: "2.00",
          status: "won",
          rewardCouponId: sportsCouponId,
        })
      );
      const rewardId = insertId(
        await t.insert(sportsMatchRewards).values({
          matchId: 4001,
          voteId,
          userId: f.sourceId,
          couponId: sportsCouponId,
        })
      );
      const checkinId = insertId(
        await t.insert(dailyCheckins).values({
          userId: f.sourceId,
          checkinDate: "2026-08-28",
          campaignKey: "ipe007",
          couponId: dailyCouponId,
        })
      );
      const grantId = insertId(
        await t.insert(dailyCheckinRewardGrants).values({
          dailyCheckinId: checkinId,
          userId: f.sourceId,
          campaignId: 1,
          ruleId: 7001,
          rewardKind: "points",
          grantReason: "daily",
          streakCountAtGrant: 1,
          pointsAmount: "1.00",
        })
      );

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        (await readById(sportsMatchVotes, sportsMatchVotes.id, voteId)).userId
      ).toBe(f.targetId);
      expect(
        (await readById(sportsMatchRewards, sportsMatchRewards.id, rewardId))
          .userId
      ).toBe(f.targetId);
      expect(
        (await readById(dailyCheckins, dailyCheckins.id, checkinId)).userId
      ).toBe(f.targetId);
      expect(
        (
          await readById(
            dailyCheckinRewardGrants,
            dailyCheckinRewardGrants.id,
            grantId
          )
        ).userId
      ).toBe(f.targetId);
      expect(await db.getRewardCouponOwnership(sportsCouponId)).toEqual(
        expect.objectContaining({ userId: f.targetId })
      );
      expect(await db.getRewardCouponOwnership(dailyCouponId)).toEqual(
        expect.objectContaining({ userId: f.targetId })
      );
      expect(
        await t
          .select()
          .from(sportsMatchRewards)
          .where(eq(sportsMatchRewards.couponId, sportsCouponId))
      ).toHaveLength(1);
      expect(
        await t
          .select()
          .from(dailyCheckinRewardGrants)
          .where(eq(dailyCheckinRewardGrants.id, grantId))
      ).toHaveLength(1);
    }, 30000);

    it("fails closed before writes when both accounts voted on the same sports match", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      await t.insert(sportsMatchVotes).values([
        { matchId: 5001, userId: f.sourceId, prediction: "home_win" },
        { matchId: 5001, userId: f.targetId, prediction: "away_win" },
      ]);
      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "SPORTS_VOTE_CONFLICT" });
      expect(
        await t
          .select()
          .from(sportsMatchVotes)
          .where(eq(sportsMatchVotes.userId, f.sourceId))
      ).toHaveLength(1);
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);

    it("preserves distinct daily grants from the same daily rule on different check-in dates", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const sourceCheckinId = insertId(
        await t.insert(dailyCheckins).values({
          userId: f.sourceId,
          checkinDate: "2026-08-26",
          campaignKey: "daily-points",
        })
      );
      const targetCheckinId = insertId(
        await t.insert(dailyCheckins).values({
          userId: f.targetId,
          checkinDate: "2026-08-25",
          campaignKey: "daily-points",
        })
      );
      const sourceGrantId = insertId(
        await t.insert(dailyCheckinRewardGrants).values({
          dailyCheckinId: sourceCheckinId,
          userId: f.sourceId,
          campaignId: 1,
          ruleId: 8001,
          rewardKind: "points",
          grantReason: "daily",
          milestoneInstanceNumber: null,
          streakCountAtGrant: 1,
          pointsAmount: "1.00",
        })
      );
      const targetGrantId = insertId(
        await t.insert(dailyCheckinRewardGrants).values({
          dailyCheckinId: targetCheckinId,
          userId: f.targetId,
          campaignId: 1,
          ruleId: 8001,
          rewardKind: "points",
          grantReason: "daily",
          milestoneInstanceNumber: null,
          streakCountAtGrant: 1,
          pointsAmount: "1.00",
        })
      );

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });

      expect(
        (
          await readById(
            dailyCheckinRewardGrants,
            dailyCheckinRewardGrants.id,
            sourceGrantId
          )
        ).userId
      ).toBe(f.targetId);
      expect(
        (
          await readById(
            dailyCheckinRewardGrants,
            dailyCheckinRewardGrants.id,
            targetGrantId
          )
        ).userId
      ).toBe(f.targetId);
      expect(
        await t
          .select()
          .from(dailyCheckinRewardGrants)
          .where(eq(dailyCheckinRewardGrants.userId, f.targetId))
      ).toHaveLength(2);
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(1);
    }, 30000);

    it("fails closed on duplicate check-in or a true milestone rule-instance collision", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      await t.insert(dailyCheckins).values([
        { userId: f.sourceId, checkinDate: "2026-08-27", campaignKey: "same" },
        { userId: f.targetId, checkinDate: "2026-08-27", campaignKey: "same" },
      ]);
      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "DAILY_CHECKIN_CONFLICT" });
      await t
        .delete(dailyCheckins)
        .where(inArray(dailyCheckins.userId, [f.sourceId, f.targetId]));

      const sourceCheckinId = insertId(
        await t.insert(dailyCheckins).values({
          userId: f.sourceId,
          checkinDate: "2026-08-26",
          campaignKey: "source",
        })
      );
      const targetCheckinId = insertId(
        await t.insert(dailyCheckins).values({
          userId: f.targetId,
          checkinDate: "2026-08-25",
          campaignKey: "target",
        })
      );
      await t.insert(dailyCheckinRewardGrants).values([
        {
          dailyCheckinId: sourceCheckinId,
          userId: f.sourceId,
          campaignId: 1,
          ruleId: 8002,
          rewardKind: "points",
          grantReason: "milestone",
          milestoneDay: 7,
          milestoneInstanceNumber: 1,
          streakCountAtGrant: 7,
          pointsAmount: "5.00",
        },
        {
          dailyCheckinId: targetCheckinId,
          userId: f.targetId,
          campaignId: 1,
          ruleId: 8002,
          rewardKind: "points",
          grantReason: "milestone",
          milestoneDay: 7,
          milestoneInstanceNumber: 1,
          streakCountAtGrant: 7,
          pointsAmount: "5.00",
        },
      ]);
      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "DAILY_REWARD_CONFLICT" });
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);

    it("ordinary retry and two-admin concurrency commit one receipt/audit and never move twice", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const orderId = await createOrder(f.sourceId);

      const [a, b] = await Promise.all([
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 11 }),
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 22 }),
      ]);
      expect([a.alreadyReconciled, b.alreadyReconciled].sort()).toEqual([
        false,
        true,
      ]);
      expect((await readById(orders, orders.id, orderId)).userId).toBe(
        f.targetId
      );
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(1);
      expect(
        await t
          .select()
          .from(accountMergeAuditLogs)
          .where(
            and(
              eq(accountMergeAuditLogs.mergeCaseId, f.caseId),
              eq(accountMergeAuditLogs.action, "data_reconciled")
            )
          )
      ).toHaveLength(1);

      const retry = await reconcileAccountMergeData({
        caseId: f.caseId,
        actorAdminId: 33,
      });
      expect(retry.alreadyReconciled).toBe(true);
    }, 30000);

    it("injected failure rolls back entitlement writes, user-data writes, dedupe evidence and receipt atomically", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const orderId = await createOrder(f.sourceId);
      await t.insert(wishlists).values({ userId: f.sourceId, novelId: 9001 });
      __setAccountMergeDataFaultForTests("after_user_data");

      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toThrow(
        "Injected Account Merge data failure at after_user_data"
      );
      expect((await readById(orders, orders.id, orderId)).userId).toBe(
        f.sourceId
      );
      expect(
        await t.select().from(wishlists).where(eq(wishlists.userId, f.sourceId))
      ).toHaveLength(1);
      expect(
        await t
          .select()
          .from(accountMergeDataDedupeRecords)
          .where(eq(accountMergeDataDedupeRecords.mergeCaseId, f.caseId))
      ).toHaveLength(0);
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);

    it("leaves IPE-006 financial history and paymentSlipClaims byte-for-byte untouched", async () => {
      const f = await createMergePair({ financial: false });
      const t = requireTestDb();
      const createdAt = new Date("2026-08-29T00:00:00Z");
      await t.insert(walletAccounts).values({
        userId: f.sourceId,
        balance: "10.00",
        createdAt,
        updatedAt: createdAt,
      });
      const walletHistoryId = insertId(
        await t.insert(walletTransactions).values({
          userId: f.sourceId,
          type: "adjust",
          amount: "10.00",
          balanceBefore: "0.00",
          balanceAfter: "10.00",
          referenceType: "ipe007_history",
          referenceId: f.caseId,
          createdAt,
        })
      );
      const pointsHistoryId = insertId(
        await t.insert(pointsTransactions).values({
          userId: f.sourceId,
          type: "adjust",
          amount: "2.00",
          balanceAfter: "2.00",
          referenceType: "ipe007_history",
          referenceId: f.caseId,
          createdAt,
        })
      );
      const topupId = insertId(
        await t.insert(walletTopups).values({
          userId: f.sourceId,
          requestedAmount: "10.00",
          status: "approved",
          createdAt,
          updatedAt: createdAt,
        })
      );
      const claimId = insertId(
        await t.insert(paymentSlipClaims).values({
          sourceType: "wallet_topup",
          sourceId: topupId,
          userId: f.sourceId,
          fileHash: uniqueTestTag("ipe007")
            .replace(/[^A-Za-z0-9]/g, "0")
            .padEnd(64, "0")
            .slice(0, 64),
          claimedAt: createdAt,
        })
      );

      await reconcileAccountMergeFinancials({
        caseId: f.caseId,
        actorAdminId: 1,
      });
      const before = {
        wallet: await readById(
          walletTransactions,
          walletTransactions.id,
          walletHistoryId
        ),
        points: await readById(
          pointsTransactions,
          pointsTransactions.id,
          pointsHistoryId
        ),
        topup: await readById(walletTopups, walletTopups.id, topupId),
        claim: await readById(paymentSlipClaims, paymentSlipClaims.id, claimId),
      };

      await reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 });
      expect(
        await readById(
          walletTransactions,
          walletTransactions.id,
          walletHistoryId
        )
      ).toEqual(before.wallet);
      expect(
        await readById(
          pointsTransactions,
          pointsTransactions.id,
          pointsHistoryId
        )
      ).toEqual(before.points);
      expect(await readById(walletTopups, walletTopups.id, topupId)).toEqual(
        before.topup
      );
      expect(
        await readById(paymentSlipClaims, paymentSlipClaims.id, claimId)
      ).toEqual(before.claim);
    }, 30000);

    it("requires the exact IPE-006 financial receipt before any Phase-4 write", async () => {
      const f = await createMergePair({ financial: false });
      const t = requireTestDb();
      const orderId = await createOrder(f.sourceId);
      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "FINANCIAL_NOT_RECONCILED" });
      expect((await readById(orders, orders.id, orderId)).userId).toBe(
        f.sourceId
      );
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);

    it("fails closed when Target is itself the guarded Source of another merge", async () => {
      const f = await createMergePair();
      const t = requireTestDb();
      const extraCaseId = insertId(
        await t.insert(accountMergeCases).values({
          originAccountRecoveryRequestId: f.requestId + 1000000,
          sourceUserId: f.targetId,
          targetUserId: f.sourceId,
          status: "pending",
          createdByAdminId: 1,
        })
      );
      f.extraCaseIds.push(extraCaseId);
      await expect(
        reconcileAccountMergeData({ caseId: f.caseId, actorAdminId: 1 })
      ).rejects.toMatchObject({ code: "TARGET_ACCOUNT_GUARDED" });
      expect(
        await t
          .select()
          .from(accountMergeDataReconciliations)
          .where(eq(accountMergeDataReconciliations.mergeCaseId, f.caseId))
      ).toHaveLength(0);
    }, 30000);
  }
);
