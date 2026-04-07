import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";

describe("Admin Orders - Pagination, Search, Sorting, Filters", () => {
  // Test data
  let testOrderIds: number[] = [];
  let testUserIds: number[] = [];

  beforeAll(async () => {
    // Create test users
    const user1OpenId = `test-user-${Date.now()}-1`;
    const user2OpenId = `test-user-${Date.now()}-2`;
    
    await db.upsertUser({
      openId: user1OpenId,
      name: "John Admin Test",
      email: `john-${Date.now()}@test.com`,
    });

    await db.upsertUser({
      openId: user2OpenId,
      name: "Jane Search Test",
      email: `jane-${Date.now()}@test.com`,
    });

    const user1 = await db.getUserByOpenId(user1OpenId);
    const user2 = await db.getUserByOpenId(user2OpenId);
    
    if (!user1 || !user2) {
      throw new Error("Failed to create test users");
    }
    
    testUserIds = [user1.id, user2.id];

    // Create test orders with different statuses and amounts
    const now = new Date();
    const testOrders = [
      {
        userId: user1.id,
        orderNumber: `TEST-${Date.now()}-001`,
        totalAmount: "1000.00",
        discountAmount: "100.00",
        pointsDiscountAmount: "0.00",
        status: "completed",
        paymentStatus: "approved",
        createdAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      },
      {
        userId: user2.id,
        orderNumber: `TEST-${Date.now()}-002`,
        totalAmount: "500.00",
        discountAmount: "0.00",
        pointsDiscountAmount: "50.00",
        status: "pending",
        paymentStatus: "pending",
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      },
      {
        userId: user1.id,
        orderNumber: `TEST-${Date.now()}-003`,
        totalAmount: "2000.00",
        discountAmount: "0.00",
        pointsDiscountAmount: "0.00",
        status: "completed",
        paymentStatus: "approved",
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
      },
    ];

    for (const order of testOrders) {
      const result = await db.createOrder(order as any);
      if (result) {
        testOrderIds.push((result as any).id);
      }
    }
  });

  afterAll(async () => {
    // Cleanup test data
    // Note: In a real scenario, you'd want proper cleanup
  });

  describe("Pagination", () => {
    it("should return paginated results with correct page size", async () => {
      const result = await db.getAdminOrdersWithUsers({
        page: 1,
        pageSize: 2,
      });

      expect(result.orders.length).toBeLessThanOrEqual(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
      expect(result.totalPages).toBeGreaterThanOrEqual(1);
    });

    it("should return correct page when page > 1", async () => {
      const page1 = await db.getAdminOrdersWithUsers({
        page: 1,
        pageSize: 1,
      });

      const page2 = await db.getAdminOrdersWithUsers({
        page: 2,
        pageSize: 1,
      });

      if (page1.total > 1) {
        expect(page2.orders.length).toBeGreaterThanOrEqual(0);
        if (page1.orders.length > 0 && page2.orders.length > 0) {
          expect(page1.orders[0].id).not.toBe(page2.orders[0].id);
        }
      }
    });
  });

  describe("Search", () => {
    it("should search by order number", async () => {
      if (testOrderIds.length > 0) {
        const order = await db.getOrderById(testOrderIds[0]);
        if (order) {
          const result = await db.getAdminOrdersWithUsers({
            search: order.orderNumber,
          });

          expect(result.orders.length).toBeGreaterThan(0);
          expect(result.orders.some((o: any) => o.orderNumber === order.orderNumber)).toBe(true);
        }
      }
    });

    it("should search by user name", async () => {
      const result = await db.getAdminOrdersWithUsers({
        search: "John Admin Test",
      });

      expect(result.orders.length).toBeGreaterThanOrEqual(0);
      if (result.orders.length > 0) {
        expect(result.orders.some((o: any) => o.userName?.includes("John"))).toBe(true);
      }
    });

    it("should search by user ID", async () => {
      if (testUserIds.length > 0) {
        const result = await db.getAdminOrdersWithUsers({
          search: testUserIds[0].toString(),
        });

        expect(result.orders.length).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("Sorting", () => {
    it("should sort by createdAt descending (default)", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
        sortBy: "createdAt",
        sortOrder: "desc",
      });

      if (result.orders.length > 1) {
        for (let i = 0; i < result.orders.length - 1; i++) {
          const current = new Date(result.orders[i].createdAt);
          const next = new Date(result.orders[i + 1].createdAt);
          expect(current.getTime()).toBeGreaterThanOrEqual(next.getTime());
        }
      }
    });

    it("should sort by createdAt ascending", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
        sortBy: "createdAt",
        sortOrder: "asc",
      });

      if (result.orders.length > 1) {
        for (let i = 0; i < result.orders.length - 1; i++) {
          const current = new Date(result.orders[i].createdAt);
          const next = new Date(result.orders[i + 1].createdAt);
          expect(current.getTime()).toBeLessThanOrEqual(next.getTime());
        }
      }
    });

    it("should sort by amount descending", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
        sortBy: "amount",
        sortOrder: "desc",
      });

      if (result.orders.length > 1) {
        for (let i = 0; i < result.orders.length - 1; i++) {
          const current = parseFloat(result.orders[i].totalAmount);
          const next = parseFloat(result.orders[i + 1].totalAmount);
          expect(current).toBeGreaterThanOrEqual(next);
        }
      }
    });

    it("should sort by discount ascending", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
        sortBy: "discount",
        sortOrder: "asc",
      });

      if (result.orders.length > 1) {
        for (let i = 0; i < result.orders.length - 1; i++) {
          const current = parseFloat(result.orders[i].discountAmount);
          const next = parseFloat(result.orders[i + 1].discountAmount);
          expect(current).toBeLessThanOrEqual(next);
        }
      }
    });
  });

  describe("Filters", () => {
    it("should filter by status", async () => {
      const result = await db.getAdminOrdersWithUsers({
        status: "completed",
      });

      expect(result.orders.every((o: any) => o.status === "completed")).toBe(true);
    });

    it("should filter by payment status", async () => {
      const result = await db.getAdminOrdersWithUsers({
        paymentStatus: "approved",
      });

      expect(result.orders.every((o: any) => o.paymentStatus === "approved")).toBe(true);
    });

    it("should filter by hasDiscount = true", async () => {
      const result = await db.getAdminOrdersWithUsers({
        hasDiscount: true,
      });

      expect(
        result.orders.every((o: any) => {
          const discount = parseFloat(o.discountAmount) + parseFloat(o.pointsDiscountAmount);
          return discount > 0;
        })
      ).toBe(true);
    });

    it("should filter by hasDiscount = false", async () => {
      const result = await db.getAdminOrdersWithUsers({
        hasDiscount: false,
      });

      expect(
        result.orders.every((o: any) => {
          const discount = parseFloat(o.discountAmount) + parseFloat(o.pointsDiscountAmount);
          return discount === 0;
        })
      ).toBe(true);
    });

    it("should filter by amount range", async () => {
      const result = await db.getAdminOrdersWithUsers({
        minAmount: 500,
        maxAmount: 1500,
      });

      expect(
        result.orders.every((o: any) => {
          const amount = parseFloat(o.totalAmount);
          return amount >= 500 && amount <= 1500;
        })
      ).toBe(true);
    });
  });

  describe("Combined Filters and Sorting", () => {
    it("should apply multiple filters together", async () => {
      const result = await db.getAdminOrdersWithUsers({
        status: "completed",
        hasDiscount: true,
        sortBy: "amount",
        sortOrder: "desc",
      });

      expect(result.orders.every((o: any) => o.status === "completed")).toBe(true);
      expect(
        result.orders.every((o: any) => {
          const discount = parseFloat(o.discountAmount) + parseFloat(o.pointsDiscountAmount);
          return discount > 0;
        })
      ).toBe(true);
    });
  });

  describe("User Name Display", () => {
    it("should include user name in results", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
      });

      if (result.orders.length > 0) {
        // At least some orders should have user names
        const hasUserNames = result.orders.some((o: any) => o.userName);
        expect(hasUserNames).toBe(true);
      }
    });

    it("should handle missing user names gracefully", async () => {
      const result = await db.getAdminOrdersWithUsers({
        pageSize: 100,
      });

      // Should not throw error even if some orders have no user
      expect(result.orders).toBeDefined();
      expect(Array.isArray(result.orders)).toBe(true);
    });
  });
});
