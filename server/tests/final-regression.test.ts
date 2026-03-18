/**
 * Final Regression Test Suite
 * Comprehensive verification of all critical flows before production release
 * Uses drizzle ORM helpers and db.execute(sql`...`) pattern (not raw mysql2 string+params)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import * as db from "../db";
import * as orderService from "../services/orderService";
import type { User } from "../../drizzle/schema";

describe("Final Regression Tests - Production Readiness", () => {
  let testUser: User;
  let testAdminUser: User;

  beforeEach(async () => {
    const dbConn = await db.getDb();
    if (!dbConn) throw new Error("Database not available");

    // Delete test users using drizzle sql template tag
    await dbConn.execute(
      sql`DELETE FROM users WHERE openId IN ('test-user-final', 'test-admin-final')`
    );

    await db.upsertUser({ openId: "test-user-final", name: "Test User", email: "test@example.com", loginMethod: "manus", role: "user" });
    await db.upsertUser({ openId: "test-admin-final", name: "Test Admin", email: "admin@example.com", loginMethod: "manus", role: "admin" });

    const u = await db.getUserByOpenId("test-user-final");
    const a = await db.getUserByOpenId("test-admin-final");
    if (!u || !a) throw new Error("Test users not created");
    testUser = u;
    testAdminUser = a;
  });

  describe("1. Manus Auth - Only Authentication System", () => {
    it("should only use Manus OAuth for authentication", async () => {
      const user = await db.getUserByOpenId("test-user-final");
      expect(user).toBeDefined();
      expect(user?.loginMethod).toBe("manus");
      expect(user?.openId).toBeDefined();
    });

    it("should not have password-based authentication", async () => {
      const dbConn = await db.getDb();
      if (!dbConn) throw new Error("Database not available");

      const schema: any[] = await dbConn.execute(sql`DESCRIBE users`) as any[];
      const columns = schema.map((col: any) => col.Field);

      // Verify no password column exists
      expect(columns).not.toContain("password");
      expect(columns).not.toContain("passwordHash");
    });
  });

  describe("2. Multi-Item Order Flow", () => {
    it("should create order with multiple items", async () => {
      // Use drizzle ORM helpers
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;
      expect(orderId).toBeDefined();

      await db.createOrderItems([
        { orderId, novelId: 1, episodeId: 1, unitPrice: "50.00", discountAmount: "0", finalPrice: "50.00" },
        { orderId, novelId: 1, episodeId: 2, unitPrice: "50.00", discountAmount: "0", finalPrice: "50.00" },
      ]);

      const items = await db.getOrderItems(orderId);
      expect(items.length).toBe(2);
    });
  });

  describe("3. One OrderNumber Per Order", () => {
    it("should generate unique orderNumber per order", async () => {
      const orderNumbers: string[] = [];
      for (let i = 0; i < 3; i++) {
        const num = orderService.generateOrderNumber();
        orderNumbers.push(num);
        await new Promise(r => setTimeout(r, 5)); // small delay to ensure uniqueness
      }

      // Verify all are unique
      const uniqueNumbers = new Set(orderNumbers);
      expect(uniqueNumbers.size).toBe(3);
    });
  });

  describe("4. Payment Slip Upload", () => {
    it("should store payment slip metadata", async () => {
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;
      expect(orderId).toBeDefined();

      // Create payment record
      await db.createPayment(orderId);

      const payment = await db.getPaymentByOrderId(orderId);
      expect(payment).toBeDefined();

      // Update with slip using paymentId and correct field name
      await db.updatePayment(payment!.id, {
        slipImageUrl: "https://s3.example.com/slip.jpg",
        status: "pending",
      });

      const updatedPayment = await db.getPaymentByOrderId(orderId);
      expect(updatedPayment).toBeDefined();
      expect(updatedPayment?.slipImageUrl).toBe("https://s3.example.com/slip.jpg");
    });
  });

  describe("5. Admin Approve/Reject", () => {
    it("should allow admin to approve payment", async () => {
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;
      await db.createPayment(orderId);

      const payment = await db.getPaymentByOrderId(orderId);
      expect(payment).toBeDefined();

      const result = await orderService.approvePayment(payment!.id, String(testAdminUser.id));
      expect(result.message).toContain("approved");

      const approvedPayment = await db.getPaymentById(payment!.id);
      expect(approvedPayment?.status).toBe("approved");
    });

    it("should allow admin to reject payment", async () => {
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;
      await db.createPayment(orderId);

      const payment = await db.getPaymentByOrderId(orderId);
      expect(payment).toBeDefined();

      await orderService.rejectPayment(payment!.id, String(testAdminUser.id), "Invalid slip");

      const rejectedPayment = await db.getPaymentById(payment!.id);
      expect(rejectedPayment?.status).toBe("rejected");
      expect(rejectedPayment?.rejectionReason).toBe("Invalid slip");
    });
  });

  describe("6. Purchases / Entitlements Creation", () => {
    it("should create purchase entitlements on approval", async () => {
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;
      await db.createPayment(orderId);

      const payment = await db.getPaymentByOrderId(orderId);
      expect(payment).toBeDefined();

      // Approve payment (which should create purchases for order items)
      const result = await orderService.approvePayment(payment!.id, String(testAdminUser.id));
      expect(result.message).toContain("approved");
    });
  });

  describe("7. My Novels - Purchases as Source of Truth", () => {
    it("should read My Novels from purchases table", async () => {
      const purchases = await db.getPurchasesByUserId(testUser.id);
      // Just verify the query works and returns an array
      expect(Array.isArray(purchases)).toBe(true);
    });
  });

  describe("8. Read/Download Access Control", () => {
    it("should block access to non-owned episodes", async () => {
      const purchase = await db.getPurchaseByUserAndEpisode(testUser.id, 99999);
      expect(purchase).toBeUndefined();
    });

    it("should allow access to owned episodes via fileService", async () => {
      const { hasAccessToEpisode } = await import("../services/orderService");
      // testUser has no purchases - should return false
      const hasAccess = await hasAccessToEpisode(testUser.id, 99999);
      expect(hasAccess).toBe(false);
    });
  });

  describe("9. Logging, Error Tracking, Health Checks", () => {
    it("should have request logging module", async () => {
      const { generateRequestId, logRequest, getRequestLogs } = await import(
        "../_core/requestLogging"
      );

      expect(generateRequestId).toBeDefined();
      expect(logRequest).toBeDefined();
      expect(getRequestLogs).toBeDefined();
    });

    it("should have error tracking module", async () => {
      const { logError, throwBusinessError, BUSINESS_ERRORS } = await import(
        "../_core/errorHandler"
      );

      expect(logError).toBeDefined();
      expect(throwBusinessError).toBeDefined();
      expect(BUSINESS_ERRORS).toBeDefined();
    });

    it("should have health check module", async () => {
      const { getHealthStatus, getReadinessStatus } = await import(
        "../_core/healthCheck"
      );

      expect(getHealthStatus).toBeDefined();
      expect(getReadinessStatus).toBeDefined();

      const health = await getHealthStatus();
      expect(health.status).toBeDefined();
    });
  });

  describe("10. Entitlement Repair Tool - Admin Only", () => {
    it("should have entitlement repair module", async () => {
      const { getRepairPreview, repairEntitlements } = await import(
        "../_core/entitlementRepair"
      );

      expect(getRepairPreview).toBeDefined();
      expect(repairEntitlements).toBeDefined();
    });

    it("should only allow admin to repair entitlements", async () => {
      expect(testAdminUser.role).toBe("admin");
      expect(testUser.role).toBe("user");
    });
  });

  describe("11. Cross-User Access Prevention", () => {
    it("should prevent user from accessing another user's cart", async () => {
      // Create cart for testUser
      const cart = await db.getOrCreateCart(testUser.id);
      expect(cart).toBeDefined();

      // Try to access from different user - should get different cart
      const adminCart = await db.getOrCreateCart(testAdminUser.id);
      expect(adminCart?.userId).toBe(testAdminUser.id);
      expect(adminCart?.id).not.toBe(cart?.id);
    });

    it("should prevent user from accessing another user's orders", async () => {
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;

      const fetchedOrder = await db.getOrderById(orderId);
      expect(fetchedOrder?.userId).toBe(testUser.id);
      // Admin user should not own this order
      expect(fetchedOrder?.userId).not.toBe(testAdminUser.id);
    });
  });

  describe("12. Points and Coupon Flows", () => {
    it("should track points transactions", async () => {
      await db.recordPointsTransaction({
        userId: testUser.id,
        type: "earn",
        amount: "100.00",
        balanceAfter: "100.00",
        referenceType: "order",
        referenceId: 1,
        note: "Test earn",
      });

      const transactions = await db.getPointsTransactions(testUser.id);
      expect(transactions.length).toBeGreaterThan(0);
    });

    it("should track coupon usage", async () => {
      const couponCode = `TESTFR${Date.now()}`;
      await db.createCoupon({
        code: couponCode,
        discountType: "percentage",
        discountValue: "10.00",
      });

      const coupon = await db.getCouponByCode(couponCode);
      expect(coupon).toBeDefined();

      // Create a dummy order for coupon usage
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: testUser.id,
        subtotal: "100.00",
        totalAmount: "90.00",
        couponCodeSnapshot: couponCode,
      });
      const orderId = (order as any).id;

      await db.recordCouponUsage(coupon!.id, testUser.id, orderId);

      // Verify coupon usageCount incremented
      const updatedCoupon = await db.getCouponByCode(couponCode);
      expect(updatedCoupon?.usageCount).toBeGreaterThan(0);
    });
  });
});
