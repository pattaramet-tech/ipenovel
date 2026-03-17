import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as db from "./db";
import * as orderService from "./services/orderService";

describe("Order/Payment Status Synchronization", () => {
  let testOrderId: number;
  let testPaymentId: number;
  let testUserId: number;

  beforeEach(async () => {
    // Create test user
    const userResult = await db.createUser({
      openId: `test-user-${Date.now()}`,
      name: `Test User ${Date.now()}`,
      email: `test-${Date.now()}@example.com`,
      loginMethod: "test",
    });
    testUserId = (userResult as any).id;

    // Create test order
    const orderResult = await db.createOrder({
      userId: testUserId,
      orderNumber: orderService.generateOrderNumber(),
      subtotal: "100.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "100.00",
    });
    testOrderId = (orderResult as any).id;

    // Create test payment
    const paymentResult = await db.createPayment(testOrderId);
    testPaymentId = (paymentResult as any).id;
  });

  describe("Payment Approval - Status Synchronization", () => {
    it("should sync order.status and order.paymentStatus when payment is approved", async () => {
      // Initial state: order.status = pending, order.paymentStatus = unpaid
      let order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");

      // Approve payment
      await orderService.approvePayment(testPaymentId, "admin-1");

      // Verify all status fields are synchronized
      order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("approved");
    });

    it("should create purchases after approval", async () => {
      // Add order item
      await db.createOrderItems([
        {
          orderId: testOrderId,
          novelId: 1,
          episodeId: 1,
          unitPrice: "100.00",
          discountAmount: "0.00",
          finalPrice: "100.00",
        },
      ]);

      // Approve payment
      await orderService.approvePayment(testPaymentId, "admin-1");

      // Verify purchase was created
      const purchase = await db.getPurchaseByUserAndEpisode(testUserId, 1);
      expect(purchase).toBeDefined();
      expect(purchase?.userId).toBe(testUserId);
      expect(purchase?.episodeId).toBe(1);
    });
  });

  describe("Payment Rejection - Status Synchronization", () => {
    it("should sync order.status and order.paymentStatus when payment is rejected", async () => {
      // Initial state
      let order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");

      // Reject payment
      const rejectionReason = "Test rejection reason";
      await orderService.rejectPayment(testPaymentId, "admin-1", rejectionReason);

      // Verify all status fields are synchronized
      order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("rejected");
      expect(order?.paymentStatus).toBe("rejected");
      expect(order?.notes).toBe(rejectionReason);

      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("rejected");
      expect(payment?.rejectionReason).toBe(rejectionReason);
    });

    it("should store rejection reason in both order.notes and payment.rejectionReason", async () => {
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
      // Upload payment slip
      await db.updatePayment(testPaymentId, {
        slipImageUrl: "https://example.com/slip.jpg",
        slipSubmittedAt: new Date(),
        status: "pending",
      });

      await db.updateOrder(testOrderId, {
        paymentStatus: "submitted",
        status: "pending",
      });

      // Verify status
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
      const order = await db.getOrderById(testOrderId);
      expect(order?.status).toBe("pending");
      expect(order?.paymentStatus).toBe("unpaid");
    });

    it("should have correct initial status values for new payment", async () => {
      const payment = await db.getPaymentById(testPaymentId);
      expect(payment?.status).toBe("pending");
      expect(payment?.rejectionReason).toBeNull();
    });
  });

  describe("Status Consistency Across Multiple Operations", () => {
    it("should maintain consistency through full approval flow", async () => {
      // Step 1: Upload slip
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

      // Step 2: Approve payment
      await orderService.approvePayment(testPaymentId, "admin-1");

      order = await db.getOrderById(testOrderId);
      payment = await db.getPaymentById(testPaymentId);
      expect(order?.status).toBe("approved");
      expect(order?.paymentStatus).toBe("approved");
      expect(payment?.status).toBe("approved");
    });

    it("should maintain consistency through rejection flow", async () => {
      // Step 1: Upload slip
      await db.updatePayment(testPaymentId, {
        slipImageUrl: "https://example.com/slip.jpg",
        slipSubmittedAt: new Date(),
        status: "pending",
      });
      await db.updateOrder(testOrderId, {
        paymentStatus: "submitted",
        status: "pending",
      });

      // Step 2: Reject payment
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
      // First approval
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
