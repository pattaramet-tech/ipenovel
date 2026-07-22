import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import {
  createTestUser,
  createTestNovel,
  createTestEpisode,
  createTestCoupon,
  uniqueTestTag,
  deleteFixtures,
} from "./test-helpers/fixtures";
import { carts, cartItems, dailyCheckins, orders, orderItems, payments, couponUsages, purchases } from "../drizzle/schema";

/**
 * Diagnosis + regression coverage for two rounds of the same Production
 * incident:
 *
 * Round 1 (fixed by explicitly setting `ocrConfidence: 0` in
 * db.createPayment): after payment.uploadSlipFile succeeded, checkout.create
 * failed on the INSERT INTO payments statement itself (migration 0021 left
 * `ocrConfidence` with no DEFAULT), which the client saw as the generic
 * sanitized "Unable to process this request at this time" message.
 *
 * Round 2 (this file's Cases E/F and the retry case): checkout.create's own
 * Order/OrderItems/Payment creation was not transactional, so (a) a failure
 * after Order/Payment creation (e.g. in post-commit OCR processing) could
 * leave partial data, and (b) two concurrent checkout.create calls for the
 * same cart could both succeed, creating two Orders from one cart. Fixed by
 * splitting checkout.create into a Phase 1 atomic transaction (lock the
 * cart row with SELECT ... FOR UPDATE, re-read cart items, create
 * Order/OrderItems/Payment, clear the cart, commit) and a Phase 2
 * post-commit step (OCR/Storage/Discord, with no transaction held open)
 * whose failure is never reported as a checkout failure - see
 * server/routers.ts checkout.create and server/db.ts lockCartForCheckout.
 *
 * Storage/OCR/Discord are never called for real here: OCR_ENABLED=false
 * (must be set in the environment before this file is imported - see
 * server/_core/env.ts, a module-level const), storagePut is mocked to
 * return a synthetic https://local.invalid/... URL, and
 * DISCORD_OCR_REVIEW_WEBHOOK_URL is left unset so
 * sendOCRReviewNotification's own no-op guard fires.
 */

vi.mock("./storage", () => ({
  storagePut: vi.fn(async (key: string) => ({ key, url: `https://local.invalid/${key}` })),
}));

const SYNTHETIC_SLIP_URL = "https://local.invalid/test-payment-slip.png";

function makeUserContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `checkout-diag-${userId}`,
      email: `checkout-diag-${userId}@example.test`,
      name: "Checkout Diagnosis Test User",
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

interface Seeded {
  userId: number;
  novelId: number;
  episodeId: number;
  episodePrice: string;
  cartId: number;
}

async function seedUserNovelEpisodeCart(price = "150.00"): Promise<Seeded> {
  const user = await createTestUser();
  const novel = await createTestNovel();
  const episode = await createTestEpisode(novel.id, { price });
  const cart = await db.getOrCreateCart(user.id);
  await db.addToCart(cart!.id as number, episode.id, novel.id, price);
  return { userId: user.id, novelId: novel.id, episodeId: episode.id, episodePrice: price, cartId: cart!.id as number };
}

async function seedDailyCheckinRewardCoupon(userId: number): Promise<{ couponId: number; code: string }> {
  const testDb = getTestDb();
  const coupon = await createTestCoupon({
    discountType: "percentage",
    discountValue: "5.00",
    maxDiscountAmount: "10.00",
  });
  const tag = uniqueTestTag("checkin");
  await testDb.insert(dailyCheckins).values({
    userId,
    checkinDate: `2026-07-${tag.slice(-2).replace(/\D/g, "1").padStart(2, "0")}`,
    campaignKey: `diag-${tag}`,
    couponId: coupon.id,
    status: "issued",
  });
  return { couponId: coupon.id, code: coupon.code };
}

async function counts(orderId: number) {
  const testDb = getTestDb();
  const orderRows = await testDb.select().from(orders).where(eq(orders.id, orderId));
  const orderItemRows = await testDb.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const paymentRows = await testDb.select().from(payments).where(eq(payments.orderId, orderId));
  return {
    order: orderRows[0],
    orderItemCount: orderItemRows.length,
    payment: paymentRows[0],
  };
}

async function cartItemCount(cartId: number): Promise<number> {
  const testDb = getTestDb();
  const rows = await testDb.select().from(cartItems).where(eq(cartItems.cartId, cartId));
  return rows.length;
}

async function purchaseCount(userId: number): Promise<number> {
  const testDb = getTestDb();
  const rows = await testDb.select().from(purchases).where(eq(purchases.userId, userId));
  return rows.length;
}

async function couponUsageCount(couponId: number): Promise<number> {
  const testDb = getTestDb();
  const rows = await testDb.select().from(couponUsages).where(eq(couponUsages.couponId, couponId));
  return rows.length;
}

async function ordersForUser(userId: number) {
  const testDb = getTestDb();
  return testDb.select().from(orders).where(eq(orders.userId, userId));
}

async function cleanupOrder(orderId: number, seeded: Seeded, extraCouponIds: number[] = []) {
  const testDb = getTestDb();
  const orderItemIds = (await testDb.select().from(orderItems).where(eq(orderItems.orderId, orderId))).map((r) => r.id);
  const paymentRows = await testDb.select().from(payments).where(eq(payments.orderId, orderId));
  await deleteFixtures({
    orderItemIds,
    paymentIds: paymentRows.map((p) => p.id),
    orderIds: [orderId],
    episodeIds: [seeded.episodeId],
    novelIds: [seeded.novelId],
    couponIds: extraCouponIds,
    userIds: [seeded.userId],
  });
}

describe.sequential("Checkout-after-slip-upload diagnosis (real disposable test database)", () => {
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) return;
    expect(process.env.OCR_ENABLED).toBe("false");
  });

  it("Case A - checkout without coupon, with synthetic slip URL, succeeds end to end", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    const result = await caller.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL });

    expect(result).toBeDefined();
    expect(result.slipResult?.success).toBe(true);
    const state = await counts(result.id);
    expect(state.order?.status).toBe("pending");
    expect(state.order?.paymentStatus).toBe("submitted");
    expect(state.orderItemCount).toBe(1);
    expect(state.payment?.slipImageUrl).toBe(SYNTHETIC_SLIP_URL);
    expect(await cartItemCount(seeded.cartId)).toBe(0);

    await cleanupOrder(result.id, seeded);
  }, 30000);

  it("Case B - checkout with an ordinary (non-reward) coupon, with synthetic slip URL, succeeds", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart("200.00");
    const coupon = await createTestCoupon({ discountType: "percentage", discountValue: "10.00" });
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    const result = await caller.checkout.create({ couponCode: coupon.code, slipImageUrl: SYNTHETIC_SLIP_URL });

    expect(result.slipResult?.success).toBe(true);
    const state = await counts(result.id);
    expect(Number(state.order?.discountAmount)).toBeCloseTo(20.0, 2);
    expect(Number(state.order?.totalAmount)).toBeCloseTo(180.0, 2);

    await cleanupOrder(result.id, seeded, [coupon.id]);
  }, 30000);

  it("Case C - checkout with a Daily Check-in-style reward coupon (percentage + maxDiscountAmount, owned, issued), with synthetic slip URL, succeeds", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart("500.00");
    const reward = await seedDailyCheckinRewardCoupon(seeded.userId);
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    const result = await caller.checkout.create({ couponCode: reward.code, slipImageUrl: SYNTHETIC_SLIP_URL });

    expect(result.slipResult?.success).toBe(true);
    const state = await counts(result.id);
    // 5% of 500 = 25, capped at maxDiscountAmount 10.00
    expect(Number(state.order?.discountAmount)).toBeCloseTo(10.0, 2);
    expect(Number(state.order?.totalAmount)).toBeCloseTo(490.0, 2);

    await cleanupOrder(result.id, seeded, [reward.couponId]);
  }, 30000);

  it("Case D - a mocked payment.uploadSlipFile result fed into the exact same client follow-up payload (checkout.create) succeeds", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    // Step 1: exactly what the client does - call payment.uploadSlipFile
    // (mocked storagePut underneath, so no real S3/R2 call happens).
    const uploadResult = await caller.payment.uploadSlipFile({
      fileName: "slip.png",
      mimeType: "image/png",
      // 1x1 PNG magic bytes so validateMagicBytes passes.
      fileBase64:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      context: "checkout",
      orderTotal: Number(seeded.episodePrice),
    });
    expect(uploadResult.slipImageUrl).toMatch(/^https:\/\/local\.invalid\//);

    // Step 2: the exact client follow-up payload.
    const result = await caller.checkout.create({ slipImageUrl: uploadResult.slipImageUrl });

    expect(result.slipResult?.success).toBe(true);
    const state = await counts(result.id);
    expect(state.payment?.slipImageUrl).toBe(uploadResult.slipImageUrl);

    await cleanupOrder(result.id, seeded);
  }, 30000);

  it("Case E - post-commit slip/OCR processing failure returns a successful, pending-processing checkout response with no partial data", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    // Forces the ONLY thing that runs after the Phase 1 transaction commits
    // (Phase 2 - submitPaymentSlip's manual-review path, since OCR is
    // disabled) to throw. recordOrderHistory is called deep inside
    // submitPaymentSlip, well after the Order/OrderItems/Payment have
    // already committed and the cart has already been cleared.
    const recordOrderHistorySpy = vi
      .spyOn(db, "recordOrderHistory")
      .mockRejectedValueOnce(new Error("Simulated post-commit OCR/processing failure - Case E"));

    const result = await caller.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL });
    recordOrderHistorySpy.mockRestore();

    // checkout.create must report SUCCESS, not throw, even though Phase 2 failed.
    expect(result).toBeDefined();
    expect(result.slipResult?.success).toBe(true);
    expect(result.slipResult?.processingDeferred).toBe(true);
    expect(result.slipResult?.status).toBe("pending_review");

    // Exactly one Order, one Payment, one set of OrderItems - no partial data.
    const allOrders = await ordersForUser(seeded.userId);
    expect(allOrders).toHaveLength(1);
    const state = await counts(result.id);
    expect(state.orderItemCount).toBe(1);
    expect(state.payment).toBeDefined();
    expect(state.payment?.slipImageUrl).toBe(SYNTHETIC_SLIP_URL);
    expect(state.order?.paymentStatus).toBe("submitted");

    // Cart already cleared (Phase 1 committed) - not left dangling because
    // of the Phase 2 failure.
    expect(await cartItemCount(seeded.cartId)).toBe(0);

    // Finalization (purchases, coupon usage) never ran - manual review is
    // still pending, exactly as if OCR itself had sent this to review.
    expect(await purchaseCount(seeded.userId)).toBe(0);

    await cleanupOrder(result.id, seeded);
  }, 30000);

  it("Case F - two concurrent checkout.create calls for the same cart: exactly one succeeds, the other gets a controlled conflict response, no duplicate Order", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart("300.00");
    const coupon = await createTestCoupon({ discountType: "percentage", discountValue: "10.00" });
    const callerA = appRouter.createCaller(makeUserContext(seeded.userId));
    const callerB = appRouter.createCaller(makeUserContext(seeded.userId));

    const results = await Promise.allSettled([
      callerA.checkout.create({ couponCode: coupon.code, slipImageUrl: SYNTHETIC_SLIP_URL }),
      callerB.checkout.create({ couponCode: coupon.code, slipImageUrl: SYNTHETIC_SLIP_URL }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one request succeeds, the other is a controlled BAD_REQUEST/CONFLICT.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(["BAD_REQUEST", "CONFLICT"]).toContain(rejection.reason?.code);

    const allOrders = await ordersForUser(seeded.userId);
    expect(allOrders).toHaveLength(1);
    const successfulOrder = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(successfulOrder.id).toBe(allOrders[0].id);

    const state = await counts(successfulOrder.id);
    expect(state.orderItemCount).toBe(1);
    expect(state.payment).toBeDefined();
    expect(await cartItemCount(seeded.cartId)).toBe(0);

    // Coupon usage is only ever recorded at finalization (approval), which
    // never ran here (payment still pending review) - so it must be 0, not
    // double-recorded once per racing request.
    expect(await couponUsageCount(coupon.id)).toBe(0);

    await cleanupOrder(successfulOrder.id, seeded, [coupon.id]);
  }, 30000);

  it("Retry after success - calling checkout.create again after the cart was already cleared creates no new Order", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    const first = await caller.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL });
    expect(first.slipResult?.success).toBe(true);
    expect(await cartItemCount(seeded.cartId)).toBe(0);

    let retryError: any;
    try {
      await caller.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL });
    } catch (error: any) {
      retryError = error;
    }

    expect(retryError).toBeDefined();
    expect(["BAD_REQUEST", "CONFLICT"]).toContain(retryError.code);

    const allOrders = await ordersForUser(seeded.userId);
    expect(allOrders).toHaveLength(1);
    expect(allOrders[0].id).toBe(first.id);

    await cleanupOrder(first.id, seeded);
  }, 30000);
});
