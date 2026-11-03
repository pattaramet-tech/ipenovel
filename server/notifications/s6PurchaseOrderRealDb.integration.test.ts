/**
 * R40R55 S6 — REAL-DATABASE episode purchase / order settlement idempotency.
 *
 * Real disposable MySQL, real pool connections, real unique constraint
 * (episodePurchases.unique_user_episode_purchase), real CAS debit. Mock
 * proofs for these paths live in episodePurchaseService.purchaseId.test.ts /
 * orderService.orderCompletion.test.ts; THIS file is the SQL-level half.
 *
 * Coupon redemption race note: coupon redemption already uses the same
 * conditional-UPDATE CAS mechanism (`maxUsageCount > usageCount` inside the
 * UPDATE WHERE clause, server/db.ts) whose driver-level semantics are proven
 * by S6-W9 in s6WalletTopupFinancialSafety.integration.test.ts; the checkout
 * path itself is covered by the existing checkout integration suites.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  episodePurchases,
  notificationEvents,
  notificationOutbox,
  payments,
  orders,
  walletAccounts,
  walletTransactions,
} from "../../drizzle/schema";
import * as db from "../db";
import { approvePayment } from "../services/orderService";
import { purchaseEpisodeWithWallet } from "../services/episodePurchaseService";
import { getTestDb } from "../test-helpers/testDb";
import {
  createTestEpisode,
  createTestNovel,
  createTestOrder,
  createTestOrderItem,
  createTestPayment,
  createTestUser,
  deleteFixtures,
  type TestUserFixture,
} from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("S6 integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

interface PurchaseFixture {
  user: TestUserFixture;
  novelId: number;
  episodeId: number;
  walletAccountId?: number;
}

interface OrderFixture {
  user: TestUserFixture;
  novelId: number;
  episodeId: number;
  orderId: number;
  orderItemId: number;
  paymentId: number;
}

const purchaseFixtures: PurchaseFixture[] = [];
const orderFixtures: OrderFixture[] = [];

async function newPurchaseFixture(balance: string): Promise<PurchaseFixture> {
  const user = await createTestUser();
  const novel = await createTestNovel();
  const episode = await createTestEpisode(novel.id, { price: "100.00", isFree: false, isPublished: true });
  const t = requireTestDb();
  const accountResult = await t.insert(walletAccounts).values({
    userId: user.id,
    balance,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const accountId = Number((accountResult as any)?.[0]?.insertId ?? (accountResult as any)?.insertId);
  const f: PurchaseFixture = { user, novelId: novel.id, episodeId: episode.id, walletAccountId: accountId };
  purchaseFixtures.push(f);
  return f;
}

async function newOrderFixture(): Promise<OrderFixture> {
  const user = await createTestUser();
  const novel = await createTestNovel();
  const episode = await createTestEpisode(novel.id, { price: "100.00", isFree: false, isPublished: true });
  const order = await createTestOrder(user.id, { subtotal: "100.00", totalAmount: "100.00" });
  const orderItem = await createTestOrderItem({ orderId: order.id, novelId: novel.id, episodeId: episode.id });
  const payment = await createTestPayment(order.id);
  const f: OrderFixture = {
    user,
    novelId: novel.id,
    episodeId: episode.id,
    orderId: order.id,
    orderItemId: orderItem.id,
    paymentId: payment.id,
  };
  orderFixtures.push(f);
  return f;
}

afterEach(async () => {
  const t = requireTestDb();
  while (purchaseFixtures.length > 0) {
    const f = purchaseFixtures.pop()!;
    const events = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.targetUserId, f.user.id));
    for (const e of events) {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, e.id));
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.targetUserId, f.user.id));
    await t.delete(episodePurchases).where(eq(episodePurchases.userId, f.user.id));
    await t.delete(walletTransactions).where(eq(walletTransactions.userId, f.user.id));
    if (f.walletAccountId) {
      await t.delete(walletAccounts).where(eq(walletAccounts.id, f.walletAccountId));
    }
    await deleteFixtures({ userIds: [f.user.id], novelIds: [f.novelId] }).catch(() => {});
  }
  while (orderFixtures.length > 0) {
    const f = orderFixtures.pop()!;
    const events = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.targetUserId, f.user.id));
    for (const e of events) {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, e.id));
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.targetUserId, f.user.id));
    await t.delete(payments).where(eq(payments.id, f.paymentId));
    await deleteFixtures({
      userIds: [f.user.id],
      novelIds: [f.novelId],
      orderItemIds: [f.orderItemId],
      orderIds: [f.orderId],
    }).catch(() => {});
  }
});

async function orderCompletedEventCount(orderId: number): Promise<number> {
  const t = requireTestDb();
  const rows = await t
    .select({ c: count() })
    .from(notificationEvents)
    .where(and(eq(notificationEvents.kind, "order_completed"), eq(notificationEvents.sourceId, String(orderId))));
  return Number(rows[0]?.c ?? 0);
}

describe("S6 episode purchase: real unique-constraint race", () => {
  it("S6-P1: two concurrent wallet purchases -> one debit, one purchase row, one event", async () => {
    const f = await newPurchaseFixture("1000.00");

    const outcomes = await Promise.allSettled([
      purchaseEpisodeWithWallet(f.user.id, f.episodeId),
      purchaseEpisodeWithWallet(f.user.id, f.episodeId),
    ]);

    // The service RESOLVES failures as {success:false} instead of throwing,
    // so count successes by result value - and let the SQL rows below be
    // the decisive exactly-once proof.
    const succeeded = outcomes
      .filter((o): o is PromiseFulfilledResult<{ success: boolean }> => o.status === "fulfilled")
      .filter((o) => o.value?.success === true);
    expect(
      succeeded.length,
      `raw outcomes: ${JSON.stringify(
        outcomes.map((o) => (o.status === "fulfilled" ? o.value : String((o as PromiseRejectedResult).reason)))
      )}`
    ).toBe(1);

    const t = requireTestDb();
    const purchaseRows = await t
      .select()
      .from(episodePurchases)
      .where(and(eq(episodePurchases.userId, f.user.id), eq(episodePurchases.episodeId, f.episodeId)));
    expect(purchaseRows.length).toBe(1);

    const account = (
      await t.select().from(walletAccounts).where(eq(walletAccounts.userId, f.user.id))
    )[0];
    expect(parseFloat(account.balance)).toBeCloseTo(900.0, 2);

    const debits = await scalarCount(
      t
        .select({ c: count() })
        .from(walletTransactions)
        .where(and(eq(walletTransactions.userId, f.user.id), eq(walletTransactions.type, "debit")))
    );
    expect(debits).toBe(1);

    const events = await t
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.kind, "episode_wallet_purchased"),
          eq(notificationEvents.sourceId, String(purchaseRows[0].id))
        )
      );
    expect(events.length).toBe(1);
    const outbox = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, events[0].id));
    expect(outbox.length).toBe(1);
  });

  it("S6-P2: failed purchase (insufficient balance) -> zero partial entitlement, zero debit, zero event", async () => {
    const f = await newPurchaseFixture("10.00");

    const result = await purchaseEpisodeWithWallet(f.user.id, f.episodeId);

    expect(result.success).toBe(false);
    const t = requireTestDb();
    const purchaseRows = await t
      .select()
      .from(episodePurchases)
      .where(and(eq(episodePurchases.userId, f.user.id), eq(episodePurchases.episodeId, f.episodeId)));
    expect(purchaseRows.length).toBe(0);
    const account = (await t.select().from(walletAccounts).where(eq(walletAccounts.userId, f.user.id)))[0];
    expect(parseFloat(account.balance)).toBeCloseTo(10.0, 2);
    const debits = await scalarCount(
      t
        .select({ c: count() })
        .from(walletTransactions)
        .where(eq(walletTransactions.userId, f.user.id))
    );
    expect(debits).toBe(0);
    const events = await scalarCount(
      t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.targetUserId, f.user.id))
    );
    expect(events).toBe(0);
  });
});

describe("S6 order settlement: duplicate approval finalizes once", () => {
  it("S6-P3: two concurrent payment approvals -> exactly one order_completed event, stable order state", async () => {
    const f = await newOrderFixture();

    await Promise.allSettled([
      approvePayment(f.paymentId, "9001"),
      approvePayment(f.paymentId, "9002"),
    ]);

    const t = requireTestDb();
    const paymentRow = (await t.select().from(payments).where(eq(payments.id, f.paymentId)))[0];
    expect(paymentRow.status).toBe("approved");

    const eventCount = await orderCompletedEventCount(f.orderId);
    expect(eventCount).toBe(1);

    // a sequential duplicate approval must not emit a second event either
    await approvePayment(f.paymentId, "9001");
    expect(await orderCompletedEventCount(f.orderId)).toBe(1);

    const orderRow = (await t.select().from(orders).where(eq(orders.id, f.orderId)))[0];
    expect(orderRow.status).toBe("approved");
  });
});

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}
