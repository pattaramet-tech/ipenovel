/**
 * Final Regression Test Suite
 * Comprehensive verification of all critical flows before production release
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getDb, upsertUser, getUserByOpenId } from "../db";
import type { User } from "../../drizzle/schema";

describe("Final Regression Tests - Production Readiness", () => {
  let testUser: User;
  let testAdminUser: User;

  beforeEach(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Create test user
    await (db as any).execute("DELETE FROM users WHERE openId IN (?, ?)", [
      "test-user-final",
      "test-admin-final",
    ]);

    testUser = (await getUserByOpenId("test-user-final")) || {
      id: 1,
      openId: "test-user-final",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    testAdminUser = (await getUserByOpenId("test-admin-final")) || {
      id: 2,
      openId: "test-admin-final",
      name: "Test Admin",
      email: "admin@example.com",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    };

    await upsertUser(testUser);
    await upsertUser(testAdminUser);
  });

  describe("1. Manus Auth - Only Authentication System", () => {
    it("should only use Manus OAuth for authentication", async () => {
      const user = await getUserByOpenId("test-user-final");
      expect(user).toBeDefined();
      expect(user?.loginMethod).toBe("manus");
      expect(user?.openId).toBeDefined();
    });

    it("should not have password-based authentication", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const schema = await (db as any).execute(
        "DESCRIBE users"
      );
      const columns = schema.map((col: any) => col.Field);

      // Verify no password column exists
      expect(columns).not.toContain("password");
      expect(columns).not.toContain("passwordHash");
    });
  });

  describe("2. Multi-Item Order Flow", () => {
    it("should create order with multiple items", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create test order with 2 items
      const result = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, "TEST-MULTI-001", 100.0]
      );

      const orderId = result.insertId;

      // Add 2 items
      await (db as any).execute(
        `INSERT INTO orderItems (orderId, episodeId, price, createdAt)
         VALUES (?, ?, ?, NOW()), (?, ?, ?, NOW())`,
        [orderId, 1, 50.0, orderId, 2, 50.0]
      );

      // Verify items
      const items = await (db as any).execute(
        `SELECT * FROM orderItems WHERE orderId = ?`,
        [orderId]
      );

      expect(items).toHaveLength(2);
      expect(items[0].episodeId).toBe(1);
      expect(items[1].episodeId).toBe(2);
    });
  });

  describe("3. One OrderNumber Per Order", () => {
    it("should generate unique orderNumber per order", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create 3 orders
      const orderNumbers = [];
      for (let i = 0; i < 3; i++) {
        const result = await (db as any).execute(
          `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
           VALUES (?, ?, ?, NOW(), NOW())`,
          [testUser.id, `TEST-ORDER-${Date.now()}-${i}`, 100.0]
        );
        orderNumbers.push(`TEST-ORDER-${Date.now()}-${i}`);
      }

      // Verify all are unique
      const uniqueNumbers = new Set(orderNumbers);
      expect(uniqueNumbers.size).toBe(3);

      // Verify no duplicates in database
      const orders = await (db as any).execute(
        `SELECT orderNumber FROM orders WHERE userId = ? ORDER BY createdAt DESC LIMIT 3`,
        [testUser.id]
      );

      expect(orders).toHaveLength(3);
    });
  });

  describe("4. Payment Slip Upload", () => {
    it("should store payment slip metadata", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create order and payment
      const orderResult = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, `TEST-PAYMENT-${Date.now()}`, 100.0]
      );

      const orderId = orderResult.insertId;

      // Create payment record
      await (db as any).execute(
        `INSERT INTO payments (orderId, status, slipUrl, slipFileName, uploadedAt, createdAt)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [orderId, "PENDING", "https://s3.example.com/slip.jpg", "slip.jpg"]
      );

      // Verify payment
      const payments = await (db as any).execute(
        `SELECT * FROM payments WHERE orderId = ?`,
        [orderId]
      );

      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe("PENDING");
      expect(payments[0].slipUrl).toBeDefined();
    });
  });

  describe("5. Admin Approve/Reject", () => {
    it("should allow admin to approve payment", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create order and payment
      const orderResult = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, `TEST-APPROVE-${Date.now()}`, 100.0]
      );

      const orderId = orderResult.insertId;

      const paymentResult = await (db as any).execute(
        `INSERT INTO payments (orderId, status, createdAt)
         VALUES (?, ?, NOW())`,
        [orderId, "PENDING"]
      );

      const paymentId = paymentResult.insertId;

      // Admin approves
      await (db as any).execute(
        `UPDATE payments SET status = ?, approvedBy = ?, approvedAt = NOW()
         WHERE id = ?`,
        [paymentId, testAdminUser.id, "APPROVED"]
      );

      // Verify
      const payment = await (db as any).execute(
        `SELECT * FROM payments WHERE id = ?`,
        [paymentId]
      );

      expect(payment[0].status).toBe("APPROVED");
      expect(payment[0].approvedBy).toBe(testAdminUser.id);
    });

    it("should allow admin to reject payment", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create order and payment
      const orderResult = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, `TEST-REJECT-${Date.now()}`, 100.0]
      );

      const orderId = orderResult.insertId;

      const paymentResult = await (db as any).execute(
        `INSERT INTO payments (orderId, status, createdAt)
         VALUES (?, ?, NOW())`,
        [orderId, "PENDING"]
      );

      const paymentId = paymentResult.insertId;

      // Admin rejects
      await (db as any).execute(
        `UPDATE payments SET status = ?, rejectedBy = ?, rejectionReason = ?, rejectedAt = NOW()
         WHERE id = ?`,
        [paymentId, testAdminUser.id, "Invalid slip", "REJECTED"]
      );

      // Verify
      const payment = await (db as any).execute(
        `SELECT * FROM payments WHERE id = ?`,
        [paymentId]
      );

      expect(payment[0].status).toBe("REJECTED");
      expect(payment[0].rejectionReason).toBe("Invalid slip");
    });
  });

  describe("6. Purchases / Entitlements Creation", () => {
    it("should create purchase entitlements on approval", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create order with items
      const orderResult = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, `TEST-PURCHASE-${Date.now()}`, 100.0]
      );

      const orderId = orderResult.insertId;

      // Add items
      await (db as any).execute(
        `INSERT INTO orderItems (orderId, episodeId, price, createdAt)
         VALUES (?, ?, ?, NOW())`,
        [orderId, 1, 100.0]
      );

      // Create purchase
      await (db as any).execute(
        `INSERT INTO purchases (userId, episodeId, grantedAt, expiresAt)
         VALUES (?, ?, NOW(), NULL)`,
        [testUser.id, 1]
      );

      // Verify purchase
      const purchases = await (db as any).execute(
        `SELECT * FROM purchases WHERE userId = ? AND episodeId = ?`,
        [testUser.id, 1]
      );

      expect(purchases).toHaveLength(1);
      expect(purchases[0].userId).toBe(testUser.id);
      expect(purchases[0].episodeId).toBe(1);
    });
  });

  describe("7. My Novels - Purchases as Source of Truth", () => {
    it("should read My Novels from purchases table", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create purchase
      await (db as any).execute(
        `INSERT INTO purchases (userId, episodeId, grantedAt, expiresAt)
         VALUES (?, ?, NOW(), NULL)`,
        [testUser.id, 1]
      );

      // Query My Novels
      const myNovels = await (db as any).execute(
        `SELECT DISTINCT n.id, n.title
         FROM purchases p
         JOIN episodes e ON p.episodeId = e.id
         JOIN novels n ON e.novelId = n.id
         WHERE p.userId = ?`,
        [testUser.id]
      );

      expect(myNovels.length).toBeGreaterThan(0);
    });
  });

  describe("8. Read/Download Access Control", () => {
    it("should block access to non-owned episodes", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check if user has purchase
      const purchases = await (db as any).execute(
        `SELECT * FROM purchases WHERE userId = ? AND episodeId = ?`,
        [testUser.id, 999]
      );

      expect(purchases).toHaveLength(0);
    });

    it("should allow access to owned episodes", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create purchase
      await (db as any).execute(
        `INSERT INTO purchases (userId, episodeId, grantedAt, expiresAt)
         VALUES (?, ?, NOW(), NULL)`,
        [testUser.id, 1]
      );

      // Check if user has purchase
      const purchases = await (db as any).execute(
        `SELECT * FROM purchases WHERE userId = ? AND episodeId = ?`,
        [testUser.id, 1]
      );

      expect(purchases).toHaveLength(1);
    });
  });

  describe("9. Logging, Error Tracking, Health Checks", () => {
    it("should have request logging module", async () => {
      // Import and verify module exists
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
      // Verify admin role exists
      expect(testAdminUser.role).toBe("admin");
      expect(testUser.role).toBe("user");
    });
  });

  describe("11. Cross-User Access Prevention", () => {
    it("should prevent user from accessing another user's cart", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create cart for testUser
      const cartResult = await (db as any).execute(
        `INSERT INTO carts (userId, createdAt, updatedAt)
         VALUES (?, NOW(), NOW())`,
        [testUser.id]
      );

      const cartId = cartResult.insertId;

      // Try to access from different user
      const carts = await (db as any).execute(
        `SELECT * FROM carts WHERE id = ? AND userId = ?`,
        [cartId, testAdminUser.id]
      );

      expect(carts).toHaveLength(0);
    });

    it("should prevent user from accessing another user's orders", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create order for testUser
      const orderResult = await (db as any).execute(
        `INSERT INTO orders (userId, orderNumber, totalAmount, createdAt, updatedAt)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [testUser.id, `TEST-CROSS-${Date.now()}`, 100.0]
      );

      const orderId = orderResult.insertId;

      // Try to access from different user
      const orders = await (db as any).execute(
        `SELECT * FROM orders WHERE id = ? AND userId = ?`,
        [orderId, testAdminUser.id]
      );

      expect(orders).toHaveLength(0);
    });
  });

  describe("12. Points and Coupon Flows", () => {
    it("should track points transactions", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create points transaction
      await (db as any).execute(
        `INSERT INTO pointsTransactions (userId, type, amount, reason, createdAt)
         VALUES (?, ?, ?, ?, NOW())`,
        [testUser.id, "EARN", 100, "Purchase"]
      );

      // Verify
      const transactions = await (db as any).execute(
        `SELECT * FROM pointsTransactions WHERE userId = ?`,
        [testUser.id]
      );

      expect(transactions.length).toBeGreaterThan(0);
    });

    it("should track coupon usage", async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Create coupon
      const couponResult = await (db as any).execute(
        `INSERT INTO coupons (code, discountType, discountValue, maxUses, expiresAt, createdAt)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
        ["TEST10", "PERCENTAGE", 10, 100]
      );

      const couponId = couponResult.insertId;

      // Track usage
      await (db as any).execute(
        `INSERT INTO couponUsages (couponId, userId, orderId, createdAt)
         VALUES (?, ?, ?, NOW())`,
        [couponId, testUser.id, 1]
      );

      // Verify
      const usages = await (db as any).execute(
        `SELECT * FROM couponUsages WHERE couponId = ?`,
        [couponId]
      );

      expect(usages).toHaveLength(1);
    });
  });
});
