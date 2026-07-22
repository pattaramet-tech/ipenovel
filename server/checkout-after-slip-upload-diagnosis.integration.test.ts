import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq, count } from "drizzle-orm";
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
import { carts, cartItems, dailyCheckins, orders, orderItems, payments, couponUsages } from "../drizzle/schema";

/**
 * Diagnosis for the confirmed Production symptom: after payment.uploadSlipFile
 * succeeds, checkout.create returns/fails such that the client shows the
 * generic sanitized message "Unable to process this request at this time.
 * Please try again." (server/_core/trpc.ts GENERIC_INTERNAL_ERROR_MESSAGE).
 * That message only ever appears for an INTERNAL_SERVER_ERROR-coded error, or
 * a BAD_REQUEST-coded error whose message looks like a raw drizzle/mysql
 * exception (see looksLikeRawDatabaseError) - checkout.create's own catch
 * block always rethrows as BAD_REQUEST with the caught error's message, so
 * seeing the generic message implies either (a) an uncaught throw before
 * that try/catch, or (b) the caught error's message is itself a raw DB
 * exception string.
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
  const [orderRows] = [await testDb.select().from(orders).where(eq(orders.id, orderId))];
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

    await deleteFixtures({
      orderItemIds: (await getTestDb().select().from(orderItems).where(eq(orderItems.orderId, result.id))).map((r) => r.id),
      paymentIds: state.payment ? [state.payment.id] : [],
      orderIds: [result.id],
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      userIds: [seeded.userId],
    });
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

    await deleteFixtures({
      orderItemIds: (await getTestDb().select().from(orderItems).where(eq(orderItems.orderId, result.id))).map((r) => r.id),
      paymentIds: state.payment ? [state.payment.id] : [],
      orderIds: [result.id],
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      couponIds: [coupon.id],
      userIds: [seeded.userId],
    });
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

    await deleteFixtures({
      orderItemIds: (await getTestDb().select().from(orderItems).where(eq(orderItems.orderId, result.id))).map((r) => r.id),
      paymentIds: state.payment ? [state.payment.id] : [],
      orderIds: [result.id],
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      couponIds: [reward.couponId],
      userIds: [seeded.userId],
    });
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

    await deleteFixtures({
      orderItemIds: (await getTestDb().select().from(orderItems).where(eq(orderItems.orderId, result.id))).map((r) => r.id),
      paymentIds: state.payment ? [state.payment.id] : [],
      orderIds: [result.id],
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      userIds: [seeded.userId],
    });
  }, 30000);

  it("Case E - forcing submitPaymentSlip to fail AFTER Order/Payment creation reveals whether partial data is left behind", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const caller = appRouter.createCaller(makeUserContext(seeded.userId));

    const recordOrderHistorySpy = vi
      .spyOn(db, "recordOrderHistory")
      .mockRejectedValueOnce(new Error("Simulated DB failure - Case E diagnostic"));

    let caughtError: any;
    try {
      await caller.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL });
    } catch (error: any) {
      caughtError = error;
    }
    recordOrderHistorySpy.mockRestore();

    expect(caughtError).toBeDefined();
    expect(caughtError.code).toBe("BAD_REQUEST");

    // Find whatever order got created for this user (there is no other way
    // to get its id back - checkout.create threw before returning anything).
    const testDb = getTestDb();
    const createdOrders = await testDb.select().from(orders).where(eq(orders.userId, seeded.userId));
    expect(createdOrders).toHaveLength(1);
    const orphanOrder = createdOrders[0];
    const state = await counts(orphanOrder.id);

    // This assertion documents the actual (not hypothetical) behavior: does
    // checkout.create leave the Order/Payment committed when a later step
    // throws? (checkout.create's own orderService.createOrderFromCart call
    // is NOT given a transaction - see server/routers.ts checkout.create.)
    console.log(
      "[Case E result] order status:",
      orphanOrder.status,
      "paymentStatus:",
      orphanOrder.paymentStatus,
      "payment exists:",
      !!state.payment,
      "cart item count still present:",
      await cartItemCount(seeded.cartId)
    );

    await deleteFixtures({
      orderItemIds: (await testDb.select().from(orderItems).where(eq(orderItems.orderId, orphanOrder.id))).map((r) => r.id),
      paymentIds: state.payment ? [state.payment.id] : [],
      orderIds: [orphanOrder.id],
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      userIds: [seeded.userId],
    });
  }, 30000);

  it("Case F - the same checkout run twice in immediate succession (double-click simulation) reveals whether duplicate Orders are created", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const seeded = await seedUserNovelEpisodeCart();
    const callerA = appRouter.createCaller(makeUserContext(seeded.userId));
    const callerB = appRouter.createCaller(makeUserContext(seeded.userId));

    const results = await Promise.allSettled([
      callerA.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL }),
      callerB.checkout.create({ slipImageUrl: SYNTHETIC_SLIP_URL }),
    ]);

    const testDb = getTestDb();
    const createdOrders = await testDb.select().from(orders).where(eq(orders.userId, seeded.userId));

    console.log(
      "[Case F result] settled statuses:",
      results.map((r) => r.status),
      "orders created:",
      createdOrders.length
    );

    const orderIds = createdOrders.map((o) => o.id);
    const paymentRows = orderIds.length
      ? await testDb.select().from(payments).where(eq(payments.orderId, orderIds[0]))
      : [];
    const allPayments = [];
    for (const oid of orderIds) {
      allPayments.push(...(await testDb.select().from(payments).where(eq(payments.orderId, oid))));
    }

    await deleteFixtures({
      orderItemIds: (
        await Promise.all(orderIds.map((oid) => testDb.select().from(orderItems).where(eq(orderItems.orderId, oid))))
      ).flat().map((r) => r.id),
      paymentIds: allPayments.map((p) => p.id),
      orderIds,
      episodeIds: [seeded.episodeId],
      novelIds: [seeded.novelId],
      userIds: [seeded.userId],
    });
  }, 30000);
});
