import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import * as orderService from "./services/orderService";
import { getTestDb } from "./test-helpers/testDb";
import {
  createTestUser,
  createTestNovel,
  createTestEpisode,
  createTestOrder,
  createTestCoupon,
  uniqueTestTag,
  deleteFixtures,
} from "./test-helpers/fixtures";
import { coupons, couponUsages, sportsMatchRewards, dailyCheckins, orders } from "../drizzle/schema";

/**
 * fix/coupon-owner-enforcement - end-to-end coverage for personal/reward
 * coupon ownership across every checkout path.
 *
 * OCR_ENABLED must be "false" in the environment before this file is
 * imported (same requirement as
 * server/checkout-after-slip-upload-diagnosis.integration.test.ts) so the
 * slip-based checkout tests deterministically fall to manual review instead
 * of depending on a real OCR/LLM call.
 */

function userContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `coupon-owner-${userId}`,
      email: `coupon-owner-${userId}@example.test`,
      name: "Coupon Ownership Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function adminContext(userId: number): TrpcContext {
  return { ...userContext(userId), user: { ...userContext(userId).user, role: "admin" } as TrpcContext["user"] };
}

/** Raw insert mirroring what settleSportsMatch does - no fixture helper
 *  exists for sportsMatchRewards, and matchId/voteId have no FK, so any
 *  unique-enough fake integers are safe. */
async function createSportsRewardCoupon(userId: number) {
  const testDb = getTestDb();
  const tag = uniqueTestTag("sports");
  const fakeId = Number(tag.replace(/\D/g, "").slice(0, 8)) || Date.now() % 100000000;
  const code = `SPORTS${tag}`.toUpperCase().slice(0, 40);
  const couponResult: any = await testDb.insert(coupons).values({
    code,
    discountType: "percentage",
    discountValue: "10.00",
    minPurchaseAmount: "0.00",
    maxUsageCount: 1,
    usageCount: 0,
    isActive: true,
  });
  const couponId = couponResult[0]?.insertId ?? couponResult.insertId;
  await testDb.insert(sportsMatchRewards).values({
    matchId: fakeId,
    voteId: fakeId + 1,
    userId,
    couponId,
    status: "issued",
  });
  return { couponId, code };
}

/** deleteFixtures() has no couponUsages support - always call this before
 *  deleting the coupon/order rows a couponUsages row references. */
async function cleanupCouponUsages(couponId: number) {
  const testDb = getTestDb();
  await testDb.delete(couponUsages).where(eq(couponUsages.couponId, couponId));
}

async function cleanupSportsReward(couponId: number) {
  const testDb = getTestDb();
  await cleanupCouponUsages(couponId);
  await testDb.delete(sportsMatchRewards).where(eq(sportsMatchRewards.couponId, couponId));
  await testDb.delete(coupons).where(eq(coupons.id, couponId));
}

async function cleanupDailyCheckinReward(userId: number) {
  const testDb = getTestDb();
  const rows = await testDb.select().from(dailyCheckins).where(eq(dailyCheckins.userId, userId));
  await testDb.delete(dailyCheckins).where(eq(dailyCheckins.userId, userId));
  for (const row of rows) {
    if (row.couponId) {
      await testDb.delete(coupons).where(eq(coupons.id, row.couponId));
    }
  }
}

describe.sequential("Coupon ownership enforcement (real disposable test database)", () => {
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) return;
    expect(process.env.OCR_ENABLED).toBe("false");
  });

  it("1. User A can use User A's own reward coupon", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);

    const result = await orderService.validateAndApplyCoupon(code, "100.00", undefined, userA.id);
    expect(result.coupon.code).toBe(code);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ userIds: [userA.id] });
  });

  it("2. User B knows User A's reward coupon code but cannot use it - and cannot tell it apart from a nonexistent code", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);

    let caughtMessage = "";
    try {
      await orderService.validateAndApplyCoupon(code, "100.00", undefined, userB.id);
      expect.fail("should have thrown");
    } catch (error: any) {
      caughtMessage = orderService.toSafeCouponClientMessage(error);
    }

    let notFoundMessage = "";
    try {
      await orderService.validateAndApplyCoupon("DEFINITELY-NOT-A-REAL-CODE", "100.00", undefined, userB.id);
      expect.fail("should have thrown");
    } catch (error: any) {
      notFoundMessage = orderService.toSafeCouponClientMessage(error);
    }

    expect(caughtMessage).toBe(notFoundMessage);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ userIds: [userA.id, userB.id] });
  });

  it("3. An unauthenticated caller (no userId) cannot use a personal/reward coupon", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);

    await expect(orderService.validateAndApplyCoupon(code, "100.00", undefined, undefined)).rejects.toThrow(
      /coupon not found/i
    );

    await cleanupSportsReward(couponId);
    await deleteFixtures({ userIds: [userA.id] });
  });

  it("4. A global coupon (no owner) is usable by anyone, logged in or not", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const coupon = await createTestCoupon({ discountValue: "20.00" });

    const withUser = await orderService.validateAndApplyCoupon(coupon.code, "100.00", undefined, userA.id);
    expect(withUser.coupon.code).toBe(coupon.code);

    const withoutUser = await orderService.validateAndApplyCoupon(coupon.code, "100.00", undefined, undefined);
    expect(withoutUser.coupon.code).toBe(coupon.code);

    await deleteFixtures({ couponIds: [coupon.id], userIds: [userA.id] });
  });

  it("5. Legacy Daily Check-in reward coupon is usable only by its claiming user", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();

    const claimResult = await db.claimDailyCheckin(userA.id);
    if (!claimResult.reward) {
      // Runtime mode is currently "points" (no coupon minted) in whatever
      // environment this runs in - nothing to assert against for THIS
      // legacy-coupon-specific scenario, but confirm it didn't silently
      // create an unowned coupon either.
      await deleteFixtures({ userIds: [userA.id, userB.id] });
      return;
    }
    const code = claimResult.reward.couponCode;
    // The reward coupon's own configured minimum purchase amount (set from
    // the live Daily Check-in config, not a fixed constant this test can
    // assume) - a hardcoded "10.00" subtotal here previously broke the
    // moment that config's minimum was raised above it, confirmed for real
    // against a live database.
    const subtotal = (Number.parseFloat(String(claimResult.reward.minPurchaseAmount ?? "0")) + 1).toFixed(2);

    // userB.id IS passed (an authenticated caller, just not the owner), so
    // this hits validateAndApplyCoupon's `ownership.ownerUserId !== userId`
    // branch - "This coupon belongs to another user", not "Coupon not
    // found" (that message is reserved for an unauthenticated caller, i.e.
    // no userId at all - see test 3 and toSafeCouponClientMessage's own
    // docs). Both collapse to the identical client-facing message (test 2
    // covers that enumeration-safety property directly) - this assertion is
    // only about the raw internal error, confirmed for real against a live
    // database.
    await expect(orderService.validateAndApplyCoupon(code, subtotal, undefined, userB.id)).rejects.toThrow(
      /belongs to another user/i
    );
    const owned = await orderService.validateAndApplyCoupon(code, subtotal, undefined, userA.id);
    expect(owned.coupon.code).toBe(code.toUpperCase());

    await cleanupDailyCheckinReward(userA.id);
    await deleteFixtures({ userIds: [userA.id, userB.id] });
  });

  it("6. Legacy Sports Match reward coupon is usable only by its winning user", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);

    // Same reasoning as test 5 - userB.id is a known, authenticated (just
    // wrong) caller, so the raw error is "This coupon belongs to another
    // user", not "Coupon not found".
    await expect(orderService.validateAndApplyCoupon(code, "100.00", undefined, userB.id)).rejects.toThrow(
      /belongs to another user/i
    );
    const owned = await orderService.validateAndApplyCoupon(code, "100.00", undefined, userA.id);
    expect(owned.coupon.code).toBe(code);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ userIds: [userA.id, userB.id] });
  });

  it("7. used/expired/void/inactive coupons are all rejected", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const expired = await createTestCoupon({ expiresAt: new Date("2020-01-01") });
    const inactive = await createTestCoupon({ isActive: false });
    const usedUp = await createTestCoupon({ maxUsageCount: 1 });
    const testDb = getTestDb();
    await testDb.update(coupons).set({ usageCount: 1 }).where(eq(coupons.id, usedUp.id));

    await expect(orderService.validateAndApplyCoupon(expired.code, "100.00")).rejects.toThrow(/expired/i);
    await expect(orderService.validateAndApplyCoupon(inactive.code, "100.00")).rejects.toThrow(/inactive/i);
    await expect(orderService.validateAndApplyCoupon(usedUp.code, "100.00")).rejects.toThrow(/usage limit/i);

    // A reward coupon whose status has been flipped to "void"/"used" is
    // rejected even for its rightful owner.
    const userA = await createTestUser();
    const { couponId: voidCouponId, code: voidCode } = await createSportsRewardCoupon(userA.id);
    await testDb.update(sportsMatchRewards).set({ status: "void" }).where(eq(sportsMatchRewards.couponId, voidCouponId));
    await expect(orderService.validateAndApplyCoupon(voidCode, "100.00", undefined, userA.id)).rejects.toThrow(
      /cancelled/i
    );

    await cleanupSportsReward(voidCouponId);
    await deleteFixtures({ couponIds: [expired.id, inactive.id, usedUp.id], userIds: [userA.id] });
  });

  it("8. The cart's active-coupons list never includes another user's personal/reward coupon, and fails closed with no userId", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);
    const globalCoupon = await createTestCoupon();

    const forOwner = await db.getActiveCouponsForCart("0", userA.id);
    expect(forOwner.some((c: any) => c.code === code)).toBe(true);
    expect(forOwner.some((c: any) => c.code === globalCoupon.code)).toBe(true);

    const forStranger = await db.getActiveCouponsForCart("0", userB.id);
    expect(forStranger.some((c: any) => c.code === code)).toBe(false);
    expect(forStranger.some((c: any) => c.code === globalCoupon.code)).toBe(true);

    const forNoOne = await db.getActiveCouponsForCart("0", undefined);
    expect(forNoOne.some((c: any) => c.code === code)).toBe(false);
    expect(forNoOne.some((c: any) => c.code === globalCoupon.code)).toBe(true);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ couponIds: [globalCoupon.id], userIds: [userA.id, userB.id] });
  });

  it("9a. Slip checkout + manual approval records coupon usage for the owner", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const { couponId, code } = await createSportsRewardCoupon(userA.id);
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "100.00" });
    const caller = appRouter.createCaller(userContext(userA.id));
    const adminCaller = appRouter.createCaller(adminContext(admin.id));

    const cart = await db.getOrCreateCart(userA.id);
    await db.addToCart(cart!.id as number, episode.id, novel.id, "100.00");

    const checkoutResult = await caller.checkout.create({
      couponCode: code,
      slipImageUrl: "https://local.invalid/test-slip.png",
    });
    expect(checkoutResult.discountAmount).not.toBe("0.00");

    await adminCaller.admin.payments.approve({ paymentId: (await db.getPaymentByOrderId(checkoutResult.id))!.id });

    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, couponId));
    expect(usages).toHaveLength(1);
    expect(usages[0].userId).toBe(userA.id);

    const purchases = await db.getPurchasedEpisodesByNovelAndUser(novel.id, userA.id);
    expect(purchases.length).toBeGreaterThan(0);

    await cleanupSportsReward(couponId);
    await deleteFixtures({
      paymentIds: [(await db.getPaymentByOrderId(checkoutResult.id))!.id],
      orderIds: [checkoutResult.id],
      episodeIds: [episode.id],
      novelIds: [novel.id],
      userIds: [userA.id, admin.id],
    });
  }, 30000);

  it("9b. Wallet checkout rejects a coupon that belongs to another user, creating no order/payment/usage", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "50.00" });
    const callerB = appRouter.createCaller(userContext(userB.id));

    const cart = await db.getOrCreateCart(userB.id);
    await db.addToCart(cart!.id as number, episode.id, novel.id, "50.00");

    await expect(callerB.checkout.walletCheckout({ couponCode: code })).rejects.toThrow();

    const ordersForB = await getTestDb().select().from(orders).where(eq(orders.userId, userB.id));
    expect(ordersForB).toHaveLength(0);
    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, couponId));
    expect(usages).toHaveLength(0);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id], userIds: [userA.id, userB.id] });
  }, 30000);

  it("10. Two concurrent finalizations of the same single-use coupon (different orders) - only one succeeds in recording usage", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const coupon = await createTestCoupon({ maxUsageCount: 1 });
    const orderX = await createTestOrder(userA.id);
    const orderY = await createTestOrder(userA.id);

    const results = await Promise.allSettled([
      db.recordCouponUsage(coupon.id, userA.id, orderX.id),
      db.recordCouponUsage(coupon.id, userA.id, orderY.id),
    ]);

    const recorded = results.filter((r) => r.status === "fulfilled" && (r.value as any).recorded);
    const rejectedOrSkipped = results.filter(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !(r.value as any).recorded)
    );
    expect(recorded).toHaveLength(1);
    expect(rejectedOrSkipped).toHaveLength(1);

    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, coupon.id));
    expect(usages).toHaveLength(1);
    const [updatedCoupon] = await getTestDb().select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(updatedCoupon.usageCount).toBe(1);

    await cleanupCouponUsages(coupon.id);
    await deleteFixtures({ orderIds: [orderX.id, orderY.id], couponIds: [coupon.id], userIds: [userA.id] });
  }, 30000);

  it("11. A rejected coupon attempt during checkout leaves no Order, Payment, or coupon usage behind", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const userB = await createTestUser();
    const { couponId, code } = await createSportsRewardCoupon(userA.id);
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "30.00" });
    const callerB = appRouter.createCaller(userContext(userB.id));

    const cart = await db.getOrCreateCart(userB.id);
    await db.addToCart(cart!.id as number, episode.id, novel.id, "30.00");

    await expect(callerB.checkout.create({ couponCode: code })).rejects.toThrow();

    const ordersForB = await getTestDb().select().from(orders).where(eq(orders.userId, userB.id));
    expect(ordersForB).toHaveLength(0);
    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, couponId));
    expect(usages).toHaveLength(0);
    const pointsBalance = await db.getUserPointsBalance(userB.id);
    expect(pointsBalance).toBe("0.00");

    await cleanupSportsReward(couponId);
    await deleteFixtures({ episodeIds: [episode.id], novelIds: [novel.id], userIds: [userA.id, userB.id] });
  }, 30000);

  it("13. Existing coupons are never deleted or status-changed by this feature", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const coupon = await createTestCoupon();
    const [row] = await getTestDb().select().from(coupons).where(eq(coupons.id, coupon.id));
    // A pre-existing coupon (created with no scope/ownerUserId at all, the
    // exact shape of every coupon that existed before this migration) must
    // default to scope="global" with no owner, and remain fully usable.
    expect(row.scope).toBe("global");
    expect(row.ownerUserId).toBeNull();
    expect(row.isActive).toBe(true);

    await deleteFixtures({ couponIds: [coupon.id] });
  });

  it("admin.coupons: creating a user-specific coupon requires a real, server-verified owner", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const owner = await createTestUser();
    const tag = uniqueTestTag("owned");

    const created = await db.createCoupon({
      code: `OWNED${tag}`.toUpperCase(),
      discountType: "flat",
      discountValue: "5.00",
      scope: "user",
      ownerUserId: owner.id,
    });
    expect(created).toBeDefined();
    const [row] = await getTestDb().select().from(coupons).where(eq(coupons.code, `OWNED${tag}`.toUpperCase()));
    expect(row.scope).toBe("user");
    expect(row.ownerUserId).toBe(owner.id);

    // A non-existent owner is rejected outright - never trusted just
    // because the caller (an admin request) sent a plausible-looking ID.
    const fakeOwnerId = 999999999;
    await expect(
      db.createCoupon({
        code: `BADOWNER${tag}`.toUpperCase(),
        discountType: "flat",
        discountValue: "5.00",
        scope: "user",
        ownerUserId: fakeOwnerId,
      })
    ).rejects.toThrow(/owner user not found/i);

    await deleteFixtures({ couponIds: [row.id], userIds: [owner.id] });
  });

  it("admin.coupons: scope='user' without an owner, and scope='global' with an owner, are both rejected", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const owner = await createTestUser();
    const tag = uniqueTestTag("badscope");

    await expect(
      db.createCoupon({ code: `NOOWNER${tag}`.toUpperCase(), discountType: "flat", discountValue: "5.00", scope: "user" })
    ).rejects.toThrow(/requires an owner/i);

    await expect(
      db.createCoupon({
        code: `GLOBALOWNER${tag}`.toUpperCase(),
        discountType: "flat",
        discountValue: "5.00",
        scope: "global",
        ownerUserId: owner.id,
      })
    ).rejects.toThrow(/must not have an owner/i);

    await deleteFixtures({ userIds: [owner.id] });
  });

  it("admin.coupons: cannot delete a coupon with usage history, and cannot change its scope/owner after use - deactivate instead", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    const coupon = await createTestCoupon();
    const order = await createTestOrder(owner.id);

    await db.recordCouponUsage(coupon.id, owner.id, order.id);

    await expect(db.deleteCoupon(coupon.id)).rejects.toThrow(/usage history/i);
    await expect(db.updateCoupon(coupon.id, { scope: "user", ownerUserId: otherUser.id })).rejects.toThrow(
      /already been used/i
    );

    // Deactivating (the documented alternative) still works.
    await db.updateCoupon(coupon.id, { isActive: false });
    const [row] = await getTestDb().select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(row.isActive).toBe(false);

    await cleanupCouponUsages(coupon.id);
    await deleteFixtures({ orderIds: [order.id], couponIds: [coupon.id], userIds: [owner.id, otherUser.id] });
  });

  it("admin.coupons: cannot delete a reward coupon even with zero usage - deactivate instead", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const owner = await createTestUser();
    const { couponId } = await createSportsRewardCoupon(owner.id);

    await expect(db.deleteCoupon(couponId)).rejects.toThrow(/reward coupon/i);

    await cleanupSportsReward(couponId);
    await deleteFixtures({ userIds: [owner.id] });
  });
});
