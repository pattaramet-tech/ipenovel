/**
 * FINAL VALIDATION TEST — 7 Critical Business Flows
 *
 * Tests run on completely fresh data (unique timestamp suffix per run).
 * All test data prefixed with "Test" per project convention.
 *
 * Production flow for payment:
 *   1. createOrderFromCart() → creates order + payment record (status=pending)
 *   2. User uploads slip → updatePayment(paymentId, { slipImageUrl, slipSubmittedAt, status:'pending' })
 *   3. Admin approves → approvePayment(paymentId, adminId)
 *      OR Admin rejects → rejectPayment(paymentId, adminId, reason)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import * as orderService from "./services/orderService";

// ─────────────────────────────────────────────────────────────────────────────
// Shared test fixtures (created once, unique per run)
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = Date.now();

let testUser: any;
let testAdmin: any;
let testNovel: any;
let testEpisode: any;
let testCoupon: any;
let testCart: any;

beforeAll(async () => {
  // ── User ──────────────────────────────────────────────────────────────────
  await db.upsertUser({
    openId: `test-fv-user-${RUN_ID}`,
    name: `Test FV User ${RUN_ID}`,
    email: `test-fv-user-${RUN_ID}@example.com`,
    role: "user",
  });
  testUser = await db.getUserByOpenId(`test-fv-user-${RUN_ID}`);
  if (!testUser) throw new Error("SETUP FAILED: test user not created");

  // ── Admin ─────────────────────────────────────────────────────────────────
  await db.upsertUser({
    openId: `test-fv-admin-${RUN_ID}`,
    name: `Test FV Admin ${RUN_ID}`,
    email: `test-fv-admin-${RUN_ID}@example.com`,
    role: "admin",
  });
  testAdmin = await db.getUserByOpenId(`test-fv-admin-${RUN_ID}`);
  if (!testAdmin) throw new Error("SETUP FAILED: test admin not created");

  // ── Novel ─────────────────────────────────────────────────────────────────
  testNovel = await db.createNovel({
    title: `Test FV Novel ${RUN_ID}`,
    author: "Test Author",
    description: "Final validation novel",
  });
  if (!testNovel?.id) throw new Error("SETUP FAILED: test novel not created");

  // ── Episode (paid, price = 100) ───────────────────────────────────────────
  testEpisode = await db.createEpisode({
    novelId: testNovel.id,
    episodeNumber: `fv-ep-${RUN_ID}`,
    title: `Test FV Episode ${RUN_ID}`,
    price: "100.00",
    isFree: false,
    fileUrl: "https://example.com/test-fv.pdf",
  });
  if (!testEpisode?.id) throw new Error("SETUP FAILED: test episode not created");

  // ── Coupon (20% off, no usage limit) ─────────────────────────────────────
  await db.createCoupon({
    code: `TESTFV${RUN_ID}`,
    discountType: "percentage",
    discountValue: "20",
    isActive: true,
  });
  testCoupon = await db.getCouponByCode(`TESTFV${RUN_ID}`);
  if (!testCoupon) throw new Error("SETUP FAILED: test coupon not created");

  // ── Cart ──────────────────────────────────────────────────────────────────
  testCart = await db.getOrCreateCart(testUser.id);
  if (!testCart) throw new Error("SETUP FAILED: test cart not created");
}, 30_000);

afterAll(async () => {
  // Best-effort cleanup — failures here don't affect test results
  try {
    if (testUser?.id) {
      const orders = await db.getOrdersByUserId(testUser.id);
      for (const order of orders) {
        await db.deleteOrderItems(order.id).catch(() => {});
        await db.deletePaymentsByOrderId(order.id).catch(() => {});
        await db.deleteOrder(order.id).catch(() => {});
      }
      await db.clearCart(testCart?.id).catch(() => {});
    }
    if (testEpisode?.id) await db.deleteEpisode(testEpisode.id).catch(() => {});
    if (testNovel?.id) await db.deleteNovel(testNovel.id).catch(() => {});
    if (testCoupon?.id) await db.deleteCoupon(testCoupon.id).catch(() => {});
    if (testUser?.id) await db.deleteUser(testUser.id).catch(() => {});
    if (testAdmin?.id) await db.deleteUser(testAdmin.id).catch(() => {});
  } catch (_) { /* ignore cleanup errors */ }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a fresh single-item cart and create an order from it.
// createOrderFromCart also creates the payment record automatically.
// ─────────────────────────────────────────────────────────────────────────────
async function buildFreshOrder(couponCode?: string, pointsToRedeem?: string) {
  await db.clearCart(testCart.id);
  await db.addToCart(testCart.id, testEpisode.id, testNovel.id, testEpisode.price ?? "100.00");
  const items = await db.getCartItems(testCart.id);
  if (!items.length) throw new Error("Cart is empty after addToCart");
  const order = await orderService.createOrderFromCart(
    String(testUser.id),
    items,
    couponCode,
    pointsToRedeem
  );
  if (!order?.id) throw new Error("createOrderFromCart returned no id");
  return order;
}

// Helper: simulate user uploading payment slip (step 2 of payment flow)
async function uploadSlip(orderId: number) {
  const payment = await db.getPaymentByOrderId(orderId);
  if (!payment) throw new Error(`No payment record found for order ${orderId}`);
  await db.updatePayment(payment.id, {
    slipImageUrl: "https://example.com/test-slip.jpg",
    slipSubmittedAt: new Date(),
    status: "pending",
  });
  return payment;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 1 — Checkout with coupon
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 1: Checkout with coupon", () => {
  it("Test: order total must reflect 20% coupon discount", async () => {
    const order = await buildFreshOrder(`TESTFV${RUN_ID}`);

    // Episode price = 100, 20% off = 20 discount, total = 80
    const discountNum = parseFloat(order.discountAmount?.toString() ?? "0");
    const totalNum = parseFloat(order.totalAmount?.toString() ?? "0");

    expect(discountNum).toBeGreaterThan(0);
    expect(totalNum).toBeLessThan(100);
    expect(totalNum).toBeCloseTo(80, 1);

    // couponCodeSnapshot must be saved (normalized uppercase)
    const savedOrder = await db.getOrderById(order.id);
    expect(savedOrder?.couponCodeSnapshot).toBe(`TESTFV${RUN_ID}`);
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 2 — Coupon usage recording after approval
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 2: Coupon usage recording", () => {
  it("Test: coupon usage must be recorded in DB after admin approval", async () => {
    const order = await buildFreshOrder(`TESTFV${RUN_ID}`);
    const payment = await uploadSlip(order.id);

    // Admin approves
    await orderService.approvePayment(payment.id, String(testAdmin.id));

    // Coupon usage must be recorded
    const usages = await db.getCouponUsageByOrderId(order.id);
    expect(usages.length).toBeGreaterThan(0);
    expect(usages[0].couponId).toBe(testCoupon.id);
    expect(usages[0].orderId).toBe(order.id);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 3 — Admin approve payment → purchase created, access granted
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 3: Admin approve payment", () => {
  it("Test: approved order must create purchase and grant access", async () => {
    // Use a fresh user to avoid inheriting purchases from Flow 2
    const runId4 = Date.now() + 3;
    await db.upsertUser({
      openId: `test-fv-user4-${runId4}`,
      name: `Test FV User4 ${runId4}`,
      email: `test-fv-user4-${runId4}@example.com`,
      role: "user",
    });
    const user4 = await db.getUserByOpenId(`test-fv-user4-${runId4}`);
    expect(user4).toBeDefined();

    const cart4 = await db.getOrCreateCart(user4!.id);
    await db.clearCart(cart4.id);
    await db.addToCart(cart4.id, testEpisode.id, testNovel.id, "100.00");
    const items4 = await db.getCartItems(cart4.id);

    const order = await orderService.createOrderFromCart(String(user4!.id), items4);
    const payment = await db.getPaymentByOrderId(order.id);
    expect(payment).toBeDefined();

    // Before approval — no access
    const accessBefore = await orderService.hasAccessToEpisode(user4!.id, testEpisode.id);
    expect(accessBefore).toBe(false);

    // Upload slip and approve
    await db.updatePayment(payment!.id, {
      slipImageUrl: "https://example.com/test-slip.jpg",
      slipSubmittedAt: new Date(),
      status: "pending",
    });
    await orderService.approvePayment(payment!.id, String(testAdmin.id));

    // After approval — access granted
    const accessAfter = await orderService.hasAccessToEpisode(user4!.id, testEpisode.id);
    expect(accessAfter).toBe(true);

    // Purchase record exists
    const purchase = await db.getPurchaseByUserAndEpisode(user4!.id, testEpisode.id);
    expect(purchase).toBeDefined();
    expect(purchase?.userId).toBe(user4!.id);
    expect(purchase?.episodeId).toBe(testEpisode.id);

    // Cleanup
    const orders4 = await db.getOrdersByUserId(user4!.id);
    for (const o of orders4) {
      await db.deleteOrderItems(o.id).catch(() => {});
      await db.deletePaymentsByOrderId(o.id).catch(() => {});
      await db.deleteOrder(o.id).catch(() => {});
    }
    await db.clearCart(cart4.id).catch(() => {});
    await db.deleteUser(user4!.id).catch(() => {});
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 4 — Admin reject payment → no purchase, no access
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 4: Admin reject payment", () => {
  it("Test: rejected order must not create purchase and must block access", async () => {
    // Use a fresh user so there's no leftover purchase from Flow 3
    const runId2 = Date.now() + 1;
    await db.upsertUser({
      openId: `test-fv-user2-${runId2}`,
      name: `Test FV User2 ${runId2}`,
      email: `test-fv-user2-${runId2}@example.com`,
      role: "user",
    });
    const user2 = await db.getUserByOpenId(`test-fv-user2-${runId2}`);
    expect(user2).toBeDefined();

    const cart2 = await db.getOrCreateCart(user2!.id);
    await db.clearCart(cart2.id);
    await db.addToCart(cart2.id, testEpisode.id, testNovel.id, "100.00");
    const items2 = await db.getCartItems(cart2.id);

    const order = await orderService.createOrderFromCart(String(user2!.id), items2);
    const payment = await db.getPaymentByOrderId(order.id);
    expect(payment).toBeDefined();

    // Upload slip
    await db.updatePayment(payment!.id, {
      slipImageUrl: "https://example.com/test-slip.jpg",
      slipSubmittedAt: new Date(),
      status: "pending",
    });

    // Reject
    await orderService.rejectPayment(payment!.id, String(testAdmin.id), "Test rejection reason");

    // No access
    const hasAccess = await orderService.hasAccessToEpisode(user2!.id, testEpisode.id);
    expect(hasAccess).toBe(false);

    // No purchase record
    const purchase = await db.getPurchaseByUserAndEpisode(user2!.id, testEpisode.id);
    expect(purchase).toBeUndefined();

    // Cleanup user2
    const orders2 = await db.getOrdersByUserId(user2!.id);
    for (const o of orders2) {
      await db.deleteOrderItems(o.id).catch(() => {});
      await db.deletePaymentsByOrderId(o.id).catch(() => {});
      await db.deleteOrder(o.id).catch(() => {});
    }
    await db.clearCart(cart2.id).catch(() => {});
    await db.deleteUser(user2!.id).catch(() => {});
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 5 — Approved vs rejected access control cross-check
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 5: Approved vs rejected access control", () => {
  it("Test: approved user has access, brand-new user does not", async () => {
    // testUser was approved in Flow 3 — must still have access
    const approvedAccess = await orderService.hasAccessToEpisode(testUser.id, testEpisode.id);
    expect(approvedAccess).toBe(true);

    // A brand-new user with no orders — no access
    const runId3 = Date.now() + 2;
    await db.upsertUser({
      openId: `test-fv-user3-${runId3}`,
      name: `Test FV User3 ${runId3}`,
      email: `test-fv-user3-${runId3}@example.com`,
      role: "user",
    });
    const user3 = await db.getUserByOpenId(`test-fv-user3-${runId3}`);
    const noAccess = await orderService.hasAccessToEpisode(user3!.id, testEpisode.id);
    expect(noAccess).toBe(false);

    // Cleanup
    await db.deleteUser(user3!.id).catch(() => {});
  }, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 6 — Order history records approval event
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 6: Order history — approval event", () => {
  it("Test: approval must appear in order history with toStatus=approved", async () => {
    const order = await buildFreshOrder();
    const payment = await uploadSlip(order.id);

    await orderService.approvePayment(payment.id, String(testAdmin.id));

    const history = await db.getOrderHistory(order.id);
    expect(history.length).toBeGreaterThan(0);

    const approvalRecord = history.find((h: any) => h.toStatus === "approved");
    expect(approvalRecord).toBeDefined();
    expect(approvalRecord?.action).toBeTruthy();
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// FLOW 7 — Order history records rejection event
// ─────────────────────────────────────────────────────────────────────────────
describe("Flow 7: Order history — rejection event", () => {
  it("Test: rejection must appear in order history with toStatus=rejected", async () => {
    const order = await buildFreshOrder();
    const payment = await uploadSlip(order.id);

    await orderService.rejectPayment(payment.id, String(testAdmin.id), "Test rejection for history");

    const history = await db.getOrderHistory(order.id);
    expect(history.length).toBeGreaterThan(0);

    const rejectionRecord = history.find((h: any) => h.toStatus === "rejected");
    expect(rejectionRecord).toBeDefined();
    expect(rejectionRecord?.note).toBeTruthy();
  }, 30_000);
});
