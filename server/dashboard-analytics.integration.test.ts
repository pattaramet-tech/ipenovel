import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as db from "./db";
import { getDb } from "./db";
import { orders, payments, users, walletTopups } from "../drizzle/schema";

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

describe("Admin dashboard analytics integration", () => {
  let testUserId: number;

  beforeAll(async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");
    const userResult = await database.insert(users).values({
      openId: `dashboard-analytics-${Date.now()}`,
      name: "Dashboard Analytics Test User",
    });
    testUserId = insertId(userResult);
  });

  afterAll(async () => {
    const database = await getDb();
    if (database && testUserId) {
      await database.delete(users).where(eq(users.id, testUserId));
    }
  });

  it("counts actual order and top-up slip submissions for the selected month", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    const before = await db.getDashboardAnalytics("custom_month", "2037-01");
    const beforeMonthly = before.monthlySlips.find((row) => row.month === "2037-01") ?? {
      month: "2037-01",
      orderPayments: 0,
      walletTopups: 0,
      total: 0,
    };
    const createdAt = new Date("2037-01-10T10:00:00");
    const slipSubmittedAt = new Date("2037-01-11T10:00:00");

    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-SLIP-${Date.now()}`,
      userId: testUserId,
      subtotal: "20.00",
      totalAmount: "20.00",
      status: "pending",
      paymentStatus: "submitted",
      createdAt,
    });
    const orderId = insertId(orderResult);
    const paymentResult = await database.insert(payments).values({
      orderId,
      status: "pending_review",
      ocrConfidence: 0,
      ocrDecision: "needs_review",
      slipImageUrl: "private://test-order-slip",
      slipSubmittedAt,
      createdAt,
    });
    const paymentId = insertId(paymentResult);
    const topupResult = await database.insert(walletTopups).values({
      userId: testUserId,
      requestedAmount: "100.00",
      status: "pending_review",
      slipImageUrl: "private://test-topup-slip",
      slipSubmittedAt,
      createdAt,
    });
    const topupId = insertId(topupResult);

    try {
      const analytics = await db.getDashboardAnalytics("custom_month", "2037-01");
      expect(analytics.totalOrders).toBe(before.totalOrders + 1);
      expect(analytics.payments.total).toBe(before.payments.total + 1);
      expect(analytics.payments.pending).toBe(before.payments.pending + 1);
      expect(analytics.walletTopups.total).toBe(before.walletTopups.total + 1);
      expect(analytics.walletTopups.pending).toBe(before.walletTopups.pending + 1);
      expect(analytics.slips.orderPayments).toBe(before.slips.orderPayments + 1);
      expect(analytics.slips.walletTopups).toBe(before.slips.walletTopups + 1);
      expect(analytics.slips.total).toBe(before.slips.total + 2);
      expect(analytics.monthlySlips.find((row) => row.month === "2037-01")).toEqual({
        month: "2037-01",
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

  it("uses inclusive-start/exclusive-end month boundaries and filters payment sources", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    const januaryBefore = await db.getDashboardSummary("custom_month", "2036-01");
    const februaryBefore = await db.getDashboardSummary("custom_month", "2036-02");

    const januaryOrder = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-BOUNDARY-JAN-${Date.now()}`,
      userId: testUserId,
      subtotal: "10.00",
      totalAmount: "10.00",
      status: "approved",
      paymentStatus: "approved",
      createdAt: new Date("2036-01-01T00:00:00"),
    });
    const januaryOrderId = insertId(januaryOrder);
    const januaryPayment = await database.insert(payments).values({
      orderId: januaryOrderId,
      status: "approved",
      ocrConfidence: 0,
      ocrDecision: "needs_review",
      approvalSource: "manual",
      createdAt: new Date("2036-01-01T00:00:00"),
    });
    const januaryPaymentId = insertId(januaryPayment);

    const februaryOrder = await database.insert(orders).values({
      orderNumber: `TEST-DASHBOARD-BOUNDARY-FEB-${Date.now()}`,
      userId: testUserId,
      subtotal: "10.00",
      totalAmount: "10.00",
      status: "approved",
      paymentStatus: "approved",
      createdAt: new Date("2036-02-01T00:00:00"),
    });
    const februaryOrderId = insertId(februaryOrder);
    const februaryPayment = await database.insert(payments).values({
      orderId: februaryOrderId,
      status: "approved",
      ocrConfidence: 0,
      ocrDecision: "needs_review",
      approvalSource: "manual",
      createdAt: new Date("2036-02-01T00:00:00"),
    });
    const februaryPaymentId = insertId(februaryPayment);

    try {
      const january = await db.getDashboardSummary("custom_month", "2036-01");
      expect(january.totalOrders).toBe(januaryBefore.totalOrders + 1);
      expect(january.approvedPayments).toBe(januaryBefore.approvedPayments + 1);
      expect(january.paymentSources.transferCount).toBe(januaryBefore.paymentSources.transferCount + 1);

      const february = await db.getDashboardSummary("custom_month", "2036-02");
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
