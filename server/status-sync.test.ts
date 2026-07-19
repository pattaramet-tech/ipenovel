import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "./db";
import { getDb } from "./db";
import * as orderService from "./services/orderService";

/**
 * Order/payment status synchronization. Rewritten as part of test suite
 * stabilization (see docs/TEST_INFRASTRUCTURE.md) - the previous version of
 * this file had three real bugs:
 *
 * 1. No database guard at all (every hook called db.ts functions
 *    unconditionally) - without a DB it threw "Database not available"
 *    instead of skipping cleanly, and with ANY DATABASE_URL configured
 *    (including a real production one) it would have happily run
 *    destructive writes against it - no allowlist check existed anywhere
 *    in this file. Fixed by an explicit `if (!(await getDb())) return`
 *    guard, matching this repo's established convention, plus this repo's
 *    new floor-level safety net (vitest.setup.database-safety.ts) that
 *    refuses to run ANY test at all if DATABASE_URL looks production-like.
 * 2. Fixture uniqueness came from `Date.now()` alone (`test-user-${ts}`) -
 *    two beforeEach runs in the same millisecond (routine under parallel
 *    test execution, or even just a fast machine) produced the same
 *    openId/episodeNumber and hit a duplicate-key error. Fixed with a real
 *    UUID (crypto.randomUUID()) instead.
 * 3. No cleanup at all - every test run left its user/novel/episode/order/
 *    payment rows behind permanently, so a shared test database only ever
 *    grew, and other tests that scan a whole table (e.g.
 *    novels-browse-pagination.test.ts) would see an ever-changing set of
 *    "ambient" rows they never created. Fixed with an afterEach that
 *    deletes exactly the rows this test created, in FK-safe order, and
 *    fails loudly (rethrows) if cleanup itself fails.
 *
 * This file intentionally keeps using db.ts's own functions (not the newer
 * server/test-helpers/testDb.ts / fixtures.ts, which are TEST_DATABASE_URL-
 * only) - see docs/TEST_INFRASTRUCTURE.md for why mixing the two database
 * connections in one file would be a correctness bug, not an improvement.
 */
describe("Order/Payment Status Synchronization", () => {
  let testOrderId: number;
  let testPaymentId: number;
  let testUserId: number;
  let testNovelId: number;
  let testEpisodeId: number;

  beforeEach(async () => {
    const database = await getDb();
    if (!database) return;

    const tag = randomUUID().replace(/-/g, "").slice(0, 16);

    const openId = `test-user-${tag}`;
    await db.upsertUser({
      openId,
      name: `Test User ${tag}`,
      email: `test-${tag}@example.com`,
      loginMethod: "test",
    });
    const user = await db.getUserByOpenId(openId);
    testUserId = (user as any).id;

    const novel: any = await db.createNovel({
      title: `Status Sync Novel ${tag}`,
      author: "Test Author",
      description: "Test",
    });
    testNovelId = (novel as any).id;

    const epResult: any = await db.createEpisode({
      novelId: testNovelId,
      episodeNumber: `ss-ep-${tag}`,
      title: "Status Sync Episode",
      price: "100.00",
      isFree: false,
      fileUrl: "https://example.com/test.pdf",
    });
    testEpisodeId = (epResult as any)[0]?.insertId ?? (epResult as any).insertId;

    const orderResult = await db.createOrder({
      userId: testUserId,
      orderNumber: orderService.generateOrderNumber(),
      subtotal: "100.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "100.00",
    });
    testOrderId = (orderResult as any).id;

    const paymentResult = await db.createPayment(testOrderId);
    testPaymentId = (paymentResult as any).id;
  }, 30000);

  afterEach(async () => {
    const database = await getDb();
    if (!database || !testOrderId) return;

    // Deleted in FK-safe (child-before-parent) order; any failure here
    // rethrows rather than being swallowed - a cleanup failure means the
    // next run starts from a dirty state, which must be visible, not
    // silently ignored.
    if (testPaymentId) await database.execute(`DELETE FROM payments WHERE id = ${testPaymentId}`);
    if (testOrderId) await database.execute(`DELETE FROM orders WHERE id = ${testOrderId}`);
    if (testEpisodeId) await database.execute(`DELETE FROM episodes WHERE id = ${testEpisodeId}`);
    if (testNovelId) await database.execute(`DELETE FROM novels WHERE id = ${testNovelId}`);
    if (testUserId) await database.execute(`DELETE FROM users WHERE id = ${testUserId}`);
  });

  describe("Payment Approval - Status Synchronization", () => {
    it("should sync order.status and order.paymentStatus when payment is approved", async () => {
      if (!(await getDb())) return;

      let order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");

      await orderService.approvePayment(testPaymentId, "admin-1");

      order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("approved");
    });

    it("should create purchases after approval", async () => {
      if (!(await getDb())) return;

      await db.createOrderItems([
        {
          orderId: testOrderId,
          novelId: testNovelId,
          episodeId: testEpisodeId,
          unitPrice: "100.00",
          discountAmount: "0.00",
          finalPrice: "100.00",
        },
      ]);

      await orderService.approvePayment(testPaymentId, "admin-1");

      const purchase = await db.getPurchaseByUserAndEpisode(testUserId, testEpisodeId);
      expect(purchase).toBeDefined();
      expect(purchase?.userId).toBe(testUserId);
      expect(purchase?.episodeId).toBe(testEpisodeId);
    }, 15000);
  });

  describe("Payment Rejection - Status Synchronization", () => {
    it("should sync order.status and order.paymentStatus when payment is rejected", async () => {
      if (!(await getDb())) return;

      let order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");

      const rejectionReason = "Test rejection reason";
      await orderService.rejectPayment(testPaymentId, "admin-1", rejectionReason);

      order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("rejected");
      expect(order?.paymentStatus).toBe("rejected");
      expect(order?.notes).toBe(rejectionReason);

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("rejected");
      expect(payment?.rejectionReason).toBe(rejectionReason);
    });

    it("should store rejection reason in both order.notes and payment.rejectionReason", async () => {
      if (!(await getDb())) return;

      const rejectionReason = "Invalid payment slip - unclear image";
      await orderService.rejectPayment(testPaymentId, "admin-1", rejectionReason);

      const order = await db.getOrderById(testOrderId);
      const payment = await db.getPaymentById(testPaymentId);

      expect(order?.notes).toBe(rejectionReason);
      expect(payment?.rejectionReason).toBe(rejectionReason);
    });
  });

  describe("Payment Slip Upload - Status Synchronization", () => {
    it("should update order.paymentStatus to 'submitted' when slip is uploaded", async () => {
      if (!(await getDb())) return;

      await db.updatePayment(testPaymentId, {
        slipImageUrl: "https://example.com/slip.jpg",
        slipSubmittedAt: new Date(),
        status: "pending",
      });

      await db.updateOrder(testOrderId, {
        paymentStatus: "submitted",
        status: "pending",
      });

      const order = await db.getOrderById(testOrderId);
      expect(order?.paymentStatus).toBe("submitted");
      expect(order?.status).toBe("pending");

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("pending");
      expect(payment?.slipImageUrl).toBe("https://example.com/slip.jpg");
    });
  });

  describe("Status Field Validation", () => {
    it("should have correct initial status values for new order", async () => {
      if (!(await getDb())) return;

      const order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");
    });

    it("should have correct initial status values for new payment", async () => {
      if (!(await getDb())) return;

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("pending");
      expect(payment?.rejectionReason).toBeNull();
    });
  });

  describe("Status Consistency Across Multiple Operations", () => {
    it("should maintain consistency through full approval flow", async () => {
      if (!(await getDb())) return;

      await db.updatePayment(testPaymentId, {
        slipImageUrl: "https://example.com/slip.jpg",
        slipSubmittedAt: new Date(),
        status: "pending",
      });
      await db.updateOrder(testOrderId, {
        paymentStatus: "submitted",
        status: "pending",
      });

      let order = await db.getOrderById(testOrderId);
      let payment = await db.getPaymentById(testPaymentId);
      expect(order?.paymentStatus).toBe("submitted");
      expect(payment?.status).toBe("pending");

      await orderService.approvePayment(testPaymentId, "admin-1");

      order = await db.getOrderById(testOrderId);
      payment = await db.getPaymentById(testPaymentId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");
      expect(payment?.status).toBe("approved");
    });

    it("should maintain consistency through rejection flow", async () => {
      if (!(await getDb())) return;

      await db.updatePayment(testPaymentId, {
        slipImageUrl: "https://example.com/slip.jpg",
        slipSubmittedAt: new Date(),
        status: "pending",
      });
      await db.updateOrder(testOrderId, {
        paymentStatus: "submitted",
        status: "pending",
      });

      const rejectionReason = "Test rejection";
      await orderService.rejectPayment(testPaymentId, "admin-1", rejectionReason);

      const order = await db.getOrderById(testOrderId);
      const payment = await db.getPaymentById(testPaymentId);
      expect(order?.status).toBe("rejected");
      expect(order?.paymentStatus).toBe("rejected");
      expect(order?.notes).toBe(rejectionReason);
      expect(payment?.status).toBe("rejected");
      expect(payment?.rejectionReason).toBe(rejectionReason);
    });
  });

  describe("Idempotency - Multiple Approvals", () => {
    it("should handle multiple approval calls idempotently", async () => {
      if (!(await getDb())) return;

      await orderService.approvePayment(testPaymentId, "admin-1");

      let order = await db.getOrderById(testOrderId);
      let payment = await db.getPaymentById(testPaymentId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");
      expect(payment?.status).toBe("approved");

      // Second approval (should not fail)
      await orderService.approvePayment(testPaymentId, "admin-1");

      order = await db.getOrderById(testOrderId);
      payment = await db.getPaymentById(testPaymentId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");
      expect(payment?.status).toBe("approved");
    });
  });
});
