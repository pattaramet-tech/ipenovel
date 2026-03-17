import { describe, it, expect } from "vitest";
import * as db from "./db";
import * as orderService from "./services/orderService";

/**
 * Simplified status sync verification tests
 * These tests verify that the status synchronization implementation is correct
 * by checking the actual code logic without complex test isolation
 */
describe("Status Sync Implementation Verification", () => {
  it("approvePayment should update order.paymentStatus to 'approved'", async () => {
    // Create test user
    const openId = `test-verify-${Date.now()}`;
    await db.upsertUser({
      openId,
      name: `Test Verify ${Date.now()}`,
      email: `verify-${Date.now()}@example.com`,
      loginMethod: "test",
    });
    const user = await db.getUserByOpenId(openId);
    const userId = (user as any).id;

    // Create test order
    const orderResult = await db.createOrder({
      userId,
      orderNumber: orderService.generateOrderNumber(),
      subtotal: "100.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "100.00",
    });
    const orderId = (orderResult as any).id;

    // Create test payment
    const paymentResult = await db.createPayment(orderId);
    const paymentId = (paymentResult as any).id;

    // Verify initial state
    let order = await db.getOrderById(orderId);
    expect(order?.status).toBe("pending");
    expect(order?.paymentStatus).toBe("unpaid");

    // Approve payment
    await orderService.approvePayment(paymentId, "admin-test");

    // Verify all three status fields are synchronized
    order = await db.getOrderById(orderId);
    const payment = await db.getPaymentById(paymentId);

    expect(order?.status).toBe("approved");
    expect(order?.paymentStatus).toBe("approved"); // This is the fix
    expect(payment?.status).toBe("approved");
  });

  it("rejectPayment should update order.paymentStatus and order.notes", async () => {
    // Create test user
    const openId = `test-reject-${Date.now()}`;
    await db.upsertUser({
      openId,
      name: `Test Reject ${Date.now()}`,
      email: `reject-${Date.now()}@example.com`,
      loginMethod: "test",
    });
    const user = await db.getUserByOpenId(openId);
    const userId = (user as any).id;

    // Create test order
    const orderResult = await db.createOrder({
      userId,
      orderNumber: orderService.generateOrderNumber(),
      subtotal: "100.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "100.00",
    });
    const orderId = (orderResult as any).id;

    // Create test payment
    const paymentResult = await db.createPayment(orderId);
    const paymentId = (paymentResult as any).id;

    // Reject payment with reason
    const rejectionReason = "Invalid payment slip - unclear image";
    await orderService.rejectPayment(paymentId, "admin-test", rejectionReason);

    // Verify all status fields are synchronized and reason is stored
    const order = await db.getOrderById(orderId);
    const payment = await db.getPaymentById(paymentId);

    expect(order?.status).toBe("rejected");
    expect(order?.paymentStatus).toBe("rejected"); // This is the fix
    expect(order?.notes).toBe(rejectionReason); // This is the fix
    expect(payment?.status).toBe("rejected");
    expect(payment?.rejectionReason).toBe(rejectionReason);
  });
});
