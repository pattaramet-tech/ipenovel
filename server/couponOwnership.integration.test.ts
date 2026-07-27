import { describe, it, expect, beforeAll } from "vitest";
import { eq, and } from "drizzle-orm";
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
import { coupons, couponUsages, sportsMatchRewards, dailyCheckins, orders, payments, purchases, pointsTransactions } from "../drizzle/schema";

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

  it("12. Two simultaneous retries finalizing the SAME already-created order resolve idempotently - one couponUsages row, usageCount incremented once, one purchase, points credited once", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const userA = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    // Unlimited-use coupon (maxUsageCount: null) - this scenario is about
    // the SAME order being finalized twice concurrently (an admin
    // double-click / duplicate webhook retry), not a usage-limit race
    // between two different orders (that is the separate reward-coupon
    // race scenario below) - a single-use coupon here would make the
    // outcome depend on exactly which of the two concurrent calls'
    // pre-lock (couponId, orderId) idempotency check happens to run before
    // the other commits, which is not the property this test is for.
    // Episode price 200.00 with a 10% coupon leaves a 180.00 total (>=100)
    // so a real points-earn row is actually created - otherwise "points
    // credited once" would pass trivially with zero rows either way.
    const coupon = await createTestCoupon({ discountValue: "10.00", maxUsageCount: null });
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "200.00" });
    const caller = appRouter.createCaller(userContext(userA.id));
    const adminCaller = appRouter.createCaller(adminContext(admin.id));

    const cart = await db.getOrCreateCart(userA.id);
    await db.addToCart(cart!.id as number, episode.id, novel.id, "200.00");

    const checkoutResult = await caller.checkout.create({
      couponCode: coupon.code,
      slipImageUrl: "https://local.invalid/test-slip-retry.png",
    });
    const paymentId = (await db.getPaymentByOrderId(checkoutResult.id))!.id;

    // Two concurrent, independent admin-approval calls for the SAME
    // payment - real separate transactions racing on the same order/
    // coupon/user-points rows via Promise.allSettled, not a simulated or
    // sequential retry.
    const results = await Promise.allSettled([
      adminCaller.admin.payments.approve({ paymentId }),
      adminCaller.admin.payments.approve({ paymentId }),
    ]);

    // Both must settle without an uncontrolled crash - either both succeed
    // (the idempotency guards make the second call a clean no-op), or the
    // loser gets a clean, controlled rejection. Neither may leave a raw
    // driver/lock-timeout error surfaced to the caller.
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String((r.reason as any)?.message ?? r.reason)).not.toMatch(
          /ECONNRESET|ER_LOCK_WAIT_TIMEOUT|undefined is not|Cannot read prop/i
        );
      }
    }

    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, coupon.id));
    expect(usages).toHaveLength(1);
    expect(usages[0].orderId).toBe(checkoutResult.id);

    const [updatedCoupon] = await getTestDb().select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(updatedCoupon.usageCount).toBe(1);

    const userPurchases = await db.getPurchasedEpisodesByNovelAndUser(novel.id, userA.id);
    expect(userPurchases.length).toBe(1);

    const earnRows = await getTestDb()
      .select()
      .from(pointsTransactions)
      .where(
        and(
          eq(pointsTransactions.userId, userA.id),
          eq(pointsTransactions.referenceId, checkoutResult.id),
          eq(pointsTransactions.type, "earn")
        )
      );
    expect(earnRows).toHaveLength(1);

    const [finalOrder] = await getTestDb().select().from(orders).where(eq(orders.id, checkoutResult.id));
    expect(finalOrder.status).toBe("approved");
    expect(finalOrder.paymentStatus).toBe("approved");
    const [finalPayment] = await getTestDb().select().from(payments).where(eq(payments.id, paymentId));
    expect(finalPayment.status).toBe("approved");

    await cleanupCouponUsages(coupon.id);
    await deleteFixtures({
      paymentIds: [paymentId],
      orderIds: [checkoutResult.id],
      episodeIds: [episode.id],
      novelIds: [novel.id],
      couponIds: [coupon.id],
      userIds: [userA.id, admin.id],
    });
  }, 30000);

  it("14. Two different orders for the SAME owner racing to consume one single-use reward coupon - exactly one wins, the loser's order/payment fully rolls back", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const owner = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const { couponId, code } = await createSportsRewardCoupon(owner.id);
    const novel = await createTestNovel();
    // Price 150.00 with the reward coupon's fixed 10% discount leaves a
    // 135.00 total (>=100), so each order actually earns a real points row -
    // otherwise "no points effect for loser" would pass trivially.
    const episode1 = await createTestEpisode(novel.id, { price: "150.00" });
    const episode2 = await createTestEpisode(novel.id, { price: "150.00" });
    const caller = appRouter.createCaller(userContext(owner.id));
    const adminCaller = appRouter.createCaller(adminContext(admin.id));

    // Two separate orders for the SAME owner, each independently applying
    // the SAME single-use reward coupon at creation time - both succeed at
    // creation (the coupon is still "issued"/unused at that point; the real
    // race is at approval/finalization time, not here). checkout.create
    // clears the cart itself after each call, so reusing db.getOrCreateCart
    // for the second order does not double up on episode1.
    const cart1 = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart1!.id as number, episode1.id, novel.id, "150.00");
    const order1 = await caller.checkout.create({ couponCode: code, slipImageUrl: "https://local.invalid/race-1.png" });

    const cart2 = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart2!.id as number, episode2.id, novel.id, "150.00");
    const order2 = await caller.checkout.create({ couponCode: code, slipImageUrl: "https://local.invalid/race-2.png" });

    const payment1Id = (await db.getPaymentByOrderId(order1.id))!.id;
    const payment2Id = (await db.getPaymentByOrderId(order2.id))!.id;

    const results = await Promise.allSettled([
      adminCaller.admin.payments.approve({ paymentId: payment1Id }),
      adminCaller.admin.payments.approve({ paymentId: payment2Id }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A controlled, coupon-specific rejection - never a raw SQL/driver
    // error or an uncaught exception shape.
    expect(String((rejected[0] as any).reason?.message ?? "")).toMatch(/usage limit|coupon/i);

    const usages = await getTestDb().select().from(couponUsages).where(eq(couponUsages.couponId, couponId));
    expect(usages).toHaveLength(1);
    const winningOrderId = usages[0].orderId;
    const losingOrderId = winningOrderId === order1.id ? order2.id : order1.id;

    const [updatedCoupon] = await getTestDb().select().from(coupons).where(eq(coupons.id, couponId));
    expect(updatedCoupon.usageCount).toBe(1);

    // Reward status transitions issued -> used exactly once - never fought
    // over, never left "issued" despite a real order having consumed it.
    const [rewardRow] = await getTestDb()
      .select()
      .from(sportsMatchRewards)
      .where(eq(sportsMatchRewards.couponId, couponId));
    expect(rewardRow.status).toBe("used");

    const [winningOrder] = await getTestDb().select().from(orders).where(eq(orders.id, winningOrderId));
    expect(winningOrder.status).toBe("approved");
    expect(winningOrder.paymentStatus).toBe("approved");
    const [winningPayment] = await getTestDb().select().from(payments).where(eq(payments.orderId, winningOrderId));
    expect(winningPayment.status).toBe("approved");

    // The loser's order/payment fully rolled back to its pre-approval
    // state - never left half-approved.
    const [losingOrder] = await getTestDb().select().from(orders).where(eq(orders.id, losingOrderId));
    expect(losingOrder.status).toBe("pending");
    expect(losingOrder.paymentStatus).toBe("submitted");
    const [losingPayment] = await getTestDb().select().from(payments).where(eq(payments.orderId, losingOrderId));
    expect(losingPayment.status).not.toBe("approved");

    const losingEpisodeId = winningOrderId === order1.id ? episode2.id : episode1.id;
    const losingPurchases = await getTestDb()
      .select()
      .from(purchases)
      .where(and(eq(purchases.userId, owner.id), eq(purchases.episodeId, losingEpisodeId)));
    expect(losingPurchases).toHaveLength(0);

    const losingEarnRows = await getTestDb()
      .select()
      .from(pointsTransactions)
      .where(and(eq(pointsTransactions.userId, owner.id), eq(pointsTransactions.referenceId, losingOrderId)));
    expect(losingEarnRows).toHaveLength(0);

    await cleanupSportsReward(couponId);
    await deleteFixtures({
      paymentIds: [payment1Id, payment2Id],
      orderIds: [order1.id, order2.id],
      episodeIds: [episode1.id, episode2.id],
      novelIds: [novel.id],
      userIds: [owner.id, admin.id],
    });
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
