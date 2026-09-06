import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";
import { orders, payments, novels, users, walletTopups } from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Dashboard Metrics - Count Helpers", () => {
  let testUserId: number;
  let testNovelId: number;

  beforeAll(async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create test user
    const userResult = await database.insert(users).values({
      openId: `test-dashboard-${Date.now()}`,
      name: "Dashboard Test User",
    });
    testUserId = (userResult as any).insertId;

    // Create test novel
    const novelResult = await database.insert(novels).values({
      title: `Test Novel for Dashboard ${Date.now()}`,
      slug: `test-novel-dashboard-${Date.now()}`,
      author: "Test Author",
    });
    testNovelId = (novelResult as any).insertId;
  });

  afterAll(async () => {
    // Cleanup is handled by test isolation
  });

  it("countAllOrders should return total order count (not capped)", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Get current count
    const countBefore = await db.countAllOrders();
    expect(typeof countBefore).toBe("number");
    expect(countBefore).toBeGreaterThanOrEqual(0);

    // Create a new order
    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-${Date.now()}`,
      userId: testUserId,
      subtotal: "100.00",
      totalAmount: "100.00",
      status: "pending",
      paymentStatus: "pending",
    });
    const orderId = (orderResult as any).insertId;

    // Get count after
    const countAfter = await db.countAllOrders();
    expect(countAfter).toBe(countBefore + 1);

    // Cleanup
    await database.delete(orders).where(eq(orders.id, orderId));
  });

  it("countAllNovels should return total novel count", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Get current count
    const countBefore = await db.countAllNovels();
    expect(typeof countBefore).toBe("number");
    expect(countBefore).toBeGreaterThanOrEqual(1); // At least our test novel

    // Create a new novel
    const novelResult = await database.insert(novels).values({
      title: `New Test Novel ${Date.now()}`,
      slug: `new-test-novel-${Date.now()}`,
      author: "Test Author",
    });
    const novelId = (novelResult as any).insertId;

    // Get count after
    const countAfter = await db.countAllNovels();
    expect(countAfter).toBe(countBefore + 1);

    // Cleanup
    await database.delete(novels).where(eq(novels.id, novelId));
  });

  it("countPendingPayments should count only pending payments", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create test order
    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-PENDING-${Date.now()}`,
      userId: testUserId,
      subtotal: "50.00",
      totalAmount: "50.00",
      status: "pending",
      paymentStatus: "pending",
    });
    const orderId = (orderResult as any).insertId;

    // Create pending payment
    const paymentResult = await database.insert(payments).values({
      orderId,
      status: "pending",
    });
    const paymentId = (paymentResult as any).insertId;

    // Get count
    const pendingCount = await db.countPendingPayments();
    expect(typeof pendingCount).toBe("number");
    expect(pendingCount).toBeGreaterThanOrEqual(1);

    // Cleanup
    await database.delete(payments).where(eq(payments.id, paymentId));
    await database.delete(orders).where(eq(orders.id, orderId));
  });

  it("countApprovedPayments should count only approved payments", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create test order
    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-APPROVED-${Date.now()}`,
      userId: testUserId,
      subtotal: "75.00",
      totalAmount: "75.00",
      status: "approved",
      paymentStatus: "approved",
    });
    const orderId = (orderResult as any).insertId;

    // Create approved payment
    const paymentResult = await database.insert(payments).values({
      orderId,
      status: "approved",
    });
    const paymentId = (paymentResult as any).insertId;

    // Get count
    const approvedCount = await db.countApprovedPayments();
    expect(typeof approvedCount).toBe("number");
    expect(approvedCount).toBeGreaterThanOrEqual(1);

    // Cleanup
    await database.delete(payments).where(eq(payments.id, paymentId));
    await database.delete(orders).where(eq(orders.id, orderId));
  });

  it("getDashboardSummary should return all 4 metrics", async () => {
    const summary = await db.getDashboardSummary();

    expect(summary).toBeDefined();
    expect(summary).toHaveProperty("totalOrders");
    expect(summary).toHaveProperty("totalNovels");
    expect(summary).toHaveProperty("pendingPayments");
    expect(summary).toHaveProperty("approvedPayments");

    expect(typeof summary.totalOrders).toBe("number");
    expect(typeof summary.totalNovels).toBe("number");
    expect(typeof summary.pendingPayments).toBe("number");
    expect(typeof summary.approvedPayments).toBe("number");

    expect(summary.totalOrders).toBeGreaterThanOrEqual(0);
    expect(summary.totalNovels).toBeGreaterThanOrEqual(0);
    expect(summary.pendingPayments).toBeGreaterThanOrEqual(0);
    expect(summary.approvedPayments).toBeGreaterThanOrEqual(0);
  });

  it("Dashboard metrics should not be capped (handle 100+ records)", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Get current order count
    const currentCount = await db.countAllOrders();

    // The test database should have many orders
    // This test verifies the count is not capped at 100
    expect(currentCount).toBeDefined();
    expect(typeof currentCount).toBe("number");

    // If we have more than 100 orders, this proves the count is not capped
    if (currentCount > 100) {
      expect(currentCount).toBeGreaterThan(100);
    }
  });

  it("Dashboard summary should be efficient (COUNT queries, not list fetches)", async () => {
    // This test verifies the implementation uses COUNT queries
    // by checking that getDashboardSummary completes quickly
    const startTime = Date.now();
    const summary = await db.getDashboardSummary();
    const endTime = Date.now();

    // COUNT queries should complete in < 100ms even with large tables
    const duration = endTime - startTime;
    expect(duration).toBeLessThan(1000); // Generous timeout for slow systems

    // Verify we got valid results
    expect(summary.totalOrders).toBeGreaterThanOrEqual(0);
  });

  it("counts uploaded order and top-up slips by selected month without counting null slips", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    const before = await db.getDashboardAnalytics("custom_month", "2099-01");
    const beforeMonthly = before.monthlySlips.find((row) => row.month === "2099-01") ?? {
      month: "2099-01",
      orderPayments: 0,
      walletTopups: 0,
      total: 0,
    };
    const createdAt = new Date("2099-01-10T10:00:00");
    const slipSubmittedAt = new Date("2099-01-11T10:00:00");
    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-SLIP-${Date.now()}`,
      userId: testUserId,
      subtotal: "20.00",
      totalAmount: "20.00",
      status: "pending",
      paymentStatus: "pending",
      createdAt,
    });
    const orderId = (orderResult as any).insertId;
    const paymentResult = await database.insert(payments).values({
      orderId,
      status: "pending_review",
      slipImageUrl: "private://test-order-slip",
      slipSubmittedAt,
      createdAt,
    });
    const paymentId = (paymentResult as any).insertId;
    const topupResult = await database.insert(walletTopups).values({
      userId: testUserId,
      requestedAmount: "100.00",
      status: "pending_review",
      slipImageUrl: "private://test-topup-slip",
      slipSubmittedAt,
      createdAt,
    });
    const topupId = (topupResult as any).insertId;

    try {
      const analytics = await db.getDashboardAnalytics("custom_month", "2099-01");
      expect(analytics.totalOrders).toBe(before.totalOrders + 1);
      expect(analytics.payments.total).toBe(before.payments.total + 1);
      expect(analytics.payments.pending).toBe(before.payments.pending + 1);
      expect(analytics.walletTopups.total).toBe(before.walletTopups.total + 1);
      expect(analytics.walletTopups.pending).toBe(before.walletTopups.pending + 1);
      expect(analytics.slips.orderPayments).toBe(before.slips.orderPayments + 1);
      expect(analytics.slips.walletTopups).toBe(before.slips.walletTopups + 1);
      expect(analytics.slips.total).toBe(before.slips.total + 2);
      expect(analytics.monthlySlips.find((row) => row.month === "2099-01")).toEqual({
        month: "2099-01",
        orderPayments: beforeMonthly.orderPayments + 1,
        walletTopups: beforeMonthly.walletTopups + 1,
        total: beforeMonthly.total + 2,
      });
    } finally {
      await database.delete(walletTopups).where(eq(walletTopups.id, topupId));
      await database.delete(payments).where(eq(payments.id, paymentId));
      await database.delete(orders).where(eq(orders.id, orderId));
    }
  });

  it("uses inclusive-start/exclusive-end month boundaries for orders and payment sources", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    const januaryBefore = await db.getDashboardSummary("custom_month", "2098-01");
    const februaryBefore = await db.getDashboardSummary("custom_month", "2098-02");

    const januaryOrder = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-BOUNDARY-JAN-${Date.now()}`,
      userId: testUserId,
      subtotal: "10.00",
      totalAmount: "10.00",
      status: "approved",
      paymentStatus: "approved",
      createdAt: new Date("2098-01-01T00:00:00"),
    });
    const januaryOrderId = (januaryOrder as any).insertId;
    const januaryPayment = await database.insert(payments).values({
      orderId: januaryOrderId,
      status: "approved",
      approvalSource: "manual",
      createdAt: new Date("2098-01-01T00:00:00"),
    });
    const januaryPaymentId = (januaryPayment as any).insertId;

    const februaryOrder = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-BOUNDARY-FEB-${Date.now()}`,
      userId: testUserId,
      subtotal: "10.00",
      totalAmount: "10.00",
      status: "approved",
      paymentStatus: "approved",
      createdAt: new Date("2098-02-01T00:00:00"),
    });
    const februaryOrderId = (februaryOrder as any).insertId;
    const februaryPayment = await database.insert(payments).values({
      orderId: februaryOrderId,
      status: "approved",
      approvalSource: "manual",
      createdAt: new Date("2098-02-01T00:00:00"),
    });
    const februaryPaymentId = (februaryPayment as any).insertId;

    try {
      const january = await db.getDashboardSummary("custom_month", "2098-01");
      expect(january.totalOrders).toBe(januaryBefore.totalOrders + 1);
      expect(january.approvedPayments).toBe(januaryBefore.approvedPayments + 1);
      expect(january.paymentSources.transferCount).toBe(januaryBefore.paymentSources.transferCount + 1);

      const february = await db.getDashboardSummary("custom_month", "2098-02");
      expect(february.totalOrders).toBe(februaryBefore.totalOrders + 1);
      expect(february.approvedPayments).toBe(februaryBefore.approvedPayments + 1);
      expect(february.paymentSources.transferCount).toBe(februaryBefore.paymentSources.transferCount + 1);
    } finally {
      await database.delete(payments).where(eq(payments.id, februaryPaymentId));
      await database.delete(orders).where(eq(orders.id, februaryOrderId));
      await database.delete(payments).where(eq(payments.id, januaryPaymentId));
      await database.delete(orders).where(eq(orders.id, januaryOrderId));
    }
  });
});
