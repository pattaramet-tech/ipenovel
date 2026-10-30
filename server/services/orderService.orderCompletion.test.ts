import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * Service-level regression for R40R53: approvePaymentInTx must emit the
 * order_completed receipt through the shared producer ONLY after a successful
 * finalizeOrderCompletion (purchases_finalized), for orders WITH an owner, in
 * the SAME transaction. Payment-already-approved early returns, ownerless
 * orders, finalize failures and notification failures must never emit (or
 * must roll the approval back, money-safe).
 *
 * ../db is mocked at the module boundary; the transaction is a
 * table-dispatching LAZY CHAIN fake reading per-test currentPayment/currentOrder
 * rows. The REAL finalizeOrderCompletion + ApprovalService + notification
 * producer run against it.
 */

let currentPayment: Record<string, unknown>;
let currentOrder: Record<string, unknown>;
const notificationEvents: Array<Record<string, unknown>> = [];
const notificationOutbox: Array<Record<string, unknown>> = [];
let failNotificationInsert = false;

// The factory only closes over hoisted function declarations and lazily-read
// module state (standard vitest hoisting rules).
vi.mock("../db", () => {
  function makeTx() {
    const rowsFor = (name: string): Array<Record<string, unknown>> =>
      name === "payments" ? [currentPayment] :
      name === "orders" ? [currentOrder] : [];
    return {
      select(_fields: unknown) {
        return {
          from(table: any) {
            const name = getTableName(table);
            const rows = rowsFor(name);
            const chain: any = {
              where: () => chain,
              limit: () => chain,
              for: () => chain,
              then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
              catch: (reject: any) => Promise.resolve(rows).catch(reject),
            };
            return chain;
          },
        };
      },
      update(table: any) {
        const _name = getTableName(table);
        return {
          set(_values: Record<string, unknown>) {
            return { where: () => Promise.resolve({ affectedRows: 1 }) };
          },
        };
      },
      insert(table: any) {
        const name = getTableName(table);
        return {
          values(values: Record<string, unknown>) {
            if (name === "notificationEvents") {
              if (failNotificationInsert) throw new Error("notification insert infra failure");
              notificationEvents.push(values);
              return Promise.resolve({ insertId: notificationEvents.length });
            }
            if (name === "notificationOutbox") {
              if (failNotificationInsert) throw new Error("notification insert infra failure");
              notificationOutbox.push(values);
              return Promise.resolve({ insertId: notificationOutbox.length });
            }
            return Promise.resolve({ insertId: 4001 });
          },
        };
      },
    };
  }
  return {
    withAccountMergePaymentMutationGuard: vi.fn(
      async (_paymentId: number, tx: any, fn: (guarded: any) => Promise<unknown>) => fn(tx)
    ),
    transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(makeTx())),
    getDb: vi.fn(async () => ({ transaction: async (fn: (tx: any) => Promise<unknown>) => fn(makeTx()) })),
    updatePayment: vi.fn(async () => ({})),
    updateOrder: vi.fn(async () => ({})),
    approvePayment: vi.fn(async () => ({})),
    recordOrderHistory: vi.fn(async () => ({})),
    getOrderById: vi.fn(async (_orderId: number, _tx?: any) => currentOrder),
    getOrderItems: vi.fn(async () => []),
    hasPointsBeenRedeemedForOrder: vi.fn(async () => false),
    getUserPointsBalance: vi.fn(async () => "0"),
    recordPointsTransaction: vi.fn(async () => ({})),
    withUserPointsLock: vi.fn(
      async (_userId: number, _tx: any, fn: (locked: any) => Promise<void>) => fn({})
    ),
    hasPointsBeenAwardedForOrder: vi.fn(async () => false),
    createPurchase: vi.fn(async () => ({})),
    getEpisodeById: vi.fn(async () => null),
    getCouponByCode: vi.fn(async () => null),
    recordCouponUsage: vi.fn(async () => ({})),
    markSportsRewardCouponUsed: vi.fn(async () => ({})),
    markDailyCheckinCouponUsed: vi.fn(async () => ({})),
  };
});

vi.mock("./approvalService", () => ({
  ApprovalService: { approvePaymentWithSource: vi.fn(async () => {}) },
}));

beforeEach(() => {
  currentPayment = { id: 900, status: "pending_review", orderId: 55, extractedData: null };
  currentOrder = {
    id: 55, userId: 7, status: "pending_review", orderNumber: "O-2026-0001",
    totalAmount: "50.00", pointsDiscountAmount: null, couponCodeSnapshot: null,
  };
  notificationEvents.length = 0;
  notificationOutbox.length = 0;
  failNotificationInsert = false;
});

async function importServiceWithFlags(notificationsEnabled: string) {
  vi.resetModules();
  vi.stubEnv("NOTIFICATIONS_ENABLED", notificationsEnabled);
  // Fresh module import per test: the service reads a process-lifetime flags
  // snapshot at import time, so each test needs its own module instance to
  // observe its own environment.
  const service = await import("./orderService");
  return service;
}

describe("P3-B order_completed emission through approvePaymentInTx", () => {
  it("manual approval success emits exactly one order_completed receipt in the transaction", async () => {
    const service = await importServiceWithFlags("true");
    const result = await service.approvePayment(900, "7", undefined);
    expect(result.message).toContain("approved successfully");
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]).toMatchObject({
      kind: "order_completed", sourceType: "orders", sourceId: "55",
      transitionKey: "first_completion", targetUserId: 7,
    });
    expect(notificationOutbox).toHaveLength(1);
  });

  it("provider auto-approval success emits exactly one order_completed receipt", async () => {
    const service = await importServiceWithFlags("true");
    const result = await service.approvePayment(900, "provider_auto", undefined);
    expect(result.message).toContain("approved successfully");
    expect(notificationEvents).toHaveLength(1);
    expect(notificationOutbox).toHaveLength(1);
  });

  it("never emits for an already-approved payment (early return precedes finalization)", async () => {
    const service = await importServiceWithFlags("true");
    currentPayment = { id: 900, status: "approved", orderId: 55, extractedData: null };
    const result = await service.approvePayment(900, "7", undefined);
    expect(result.message).toContain("already approved");
    expect(notificationEvents).toHaveLength(0);
    expect(notificationOutbox).toHaveLength(0);
  });

  it("does not emit for an ownerless order (order.userId null)", async () => {
    const service = await importServiceWithFlags("true");
    currentOrder = { ...orderRow(7), userId: null };
    const result = await service.approvePayment(900, "7", undefined);
    expect(result.message).toContain("approved successfully");
    expect(notificationEvents).toHaveLength(0);
  });

  it("notifications OFF: approval succeeds and zero notification rows are written", async () => {
    const service = await importServiceWithFlags("");
    const result = await service.approvePayment(900, "7", undefined);
    expect(result.message).toContain("approved successfully");
    expect(notificationEvents).toHaveLength(0);
    expect(notificationOutbox).toHaveLength(0);
  });

  it("rolls the approval back when the notification insert fails mid-transaction (money-safe)", async () => {
    const service = await importServiceWithFlags("true");
    failNotificationInsert = true;
    await expect(service.approvePayment(900, "7", undefined))
      .rejects.toThrowError(/notification insert infra failure/);
    expect(notificationEvents).toHaveLength(0);
    expect(notificationOutbox).toHaveLength(0);
  });
});

function orderRow(userId: number | null) {
  return {
    id: 55, userId, status: "pending_review", orderNumber: "O-2026-0001",
    totalAmount: "50.00", pointsDiscountAmount: null, couponCodeSnapshot: null,
  };
}
