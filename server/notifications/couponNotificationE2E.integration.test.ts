/**
 * R40R59 — Coupon × Order × Notification real-database qualification.
 *
 * ADDITIVE to server/couponOwnership.integration.test.ts (tests 10/12/14
 * already prove the concurrent coupon consumption and approval-finalization
 * financial invariants against the disposable database - this file re-uses
 * their exact flow through the REAL business services and adds the
 * NOTIFICATION half):
 *
 *   - two different orders racing to consume ONE single-use coupon through
 *     concurrent REAL admin approvals; the loser's approval rolls back;
 *   - the WINNING order carries exactly one order_completed event + one
 *     outbox row; the loser carries none;
 *   - NOTIFICATION FAILURE INJECTION: a poisoned pre-existing event with the
 *     exact eventKey of order 1 (mismatched identity) forces that approval's
 *     producer to throw INSIDE the business transaction - the approval must
 *     roll back completely (order/payment/coupon/entitlement/points);
 *   - a duplicate sequential approval creates no additional event;
 *   - with the notifications runtime DISABLED (fresh module registry,
 *     NOTIFICATIONS_ENABLED unset) the financial approval still succeeds and
 *     writes ZERO notification rows.
 *
 * Mock-free: real router callers, real services, real transactions on the
 * disposable ipenovel_test MySQL 8.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq, count } from "drizzle-orm";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import * as db from "../db";
import { getTestDb } from "../test-helpers/testDb";
import { createTestCoupon, createTestEpisode, createTestNovel, createTestUser, deleteFixtures } from "../test-helpers/fixtures";
import {
  couponUsages,
  coupons,
  notificationEvents,
  notificationOutbox,
  orders,
  payments,
  pointsTransactions,
  purchases,
} from "../../drizzle/schema";

function userContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `notif-coupon-${userId}`,
      email: `notif-coupon-${userId}@example.test`,
      name: "Coupon Notification Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as TrpcContext;
}
function adminContext(userId: number): TrpcContext {
  return { ...userContext(userId), user: { ...userContext(userId).user, role: "admin" } as TrpcContext["user"] };
}

async function scalarCount(promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

describe("R40R59 coupon race × notification integrity (real approvals)", () => {
  it("CR-1..CR-10: concurrent approvals of one single-use coupon - winner notifies once, loser rolls back with zero events, poisoned notification injection rolls its business transaction back", async () => {
    const t = getTestDb();
    const owner = await createTestUser();
    const admin = await createTestUser({ role: "admin" });
    const coupon = await createTestCoupon({ maxUsageCount: 1, discountType: "percentage", discountValue: "10.00" });
    const novel = await createTestNovel();
    const episode1 = await createTestEpisode(novel.id, { price: "150.00" });
    const episode2 = await createTestEpisode(novel.id, { price: "150.00" });
    const caller = appRouter.createCaller(userContext(owner.id));
    const adminCaller = appRouter.createCaller(adminContext(admin.id));

    const cart1 = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart1!.id as number, episode1.id, novel.id, "150.00");
    const order1 = await caller.checkout.create({ couponCode: coupon.code, slipImageUrl: "https://local.invalid/cn-1.png" });
    const cart2 = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart2!.id as number, episode2.id, novel.id, "150.00");
    const order2 = await caller.checkout.create({ couponCode: coupon.code, slipImageUrl: "https://local.invalid/cn-2.png" });

    // NOTIFICATION FAILURE INJECTION: a pre-existing event with the EXACT
    // eventKey order 1's approval will emit, but with a MISMATCHED identity
    // - the real event-outbox adapter must throw "identity collision"
    // inside order 1's approval transaction and roll the whole approval back.
    const poisonedKey = `notification:v1:order_completed:orders:${order1.id}:first_completion`;
    await t.insert(notificationEvents).values({
      eventKey: poisonedKey,
      kind: "wallet_topup_approved",
      sourceType: "wallet_topups",
      sourceId: String(order1.id),
      transitionKey: "first_completion",
      targetUserId: owner.id,
      eligibleAfter: new Date(Date.now() - 60_000),
      occurredAt: new Date(Date.now() - 60_000),
    });

    const payment1Id = (await db.getPaymentByOrderId(order1.id))!.id;
    const payment2Id = (await db.getPaymentByOrderId(order2.id))!.id;

    const results = await Promise.allSettled([
      adminCaller.admin.payments.approve({ paymentId: payment1Id }),
      adminCaller.admin.payments.approve({ paymentId: payment2Id }),
    ]);
    const fulfilled = results.filter(r => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    // order 1 is deterministically the loser: its approval either loses the
    // coupon race or hits the poisoned notification - either way it must
    // roll back completely, and it must NEVER emit an order_completed event
    const order1Events = await scalarCount(
      t.select({ c: count() }).from(notificationEvents).where(
        and(eq(notificationEvents.kind, "order_completed"), eq(notificationEvents.sourceId, String(order1.id)))
      )
    );
    expect(order1Events).toBe(0);
    const [order1Row] = await t.select().from(orders).where(eq(orders.id, order1.id));
    expect(order1Row.status).toBe("pending");
    const [order1Payment] = await t.select().from(payments).where(eq(payments.id, payment1Id));
    expect(order1Payment.status).not.toBe("approved");
    expect(await scalarCount(t.select({ c: count() }).from(purchases).where(and(eq(purchases.userId, owner.id), eq(purchases.episodeId, episode1.id))))).toBe(0);
    expect(await scalarCount(t.select({ c: count() }).from(pointsTransactions).where(and(eq(pointsTransactions.userId, owner.id), eq(pointsTransactions.referenceId, String(order1.id)))))).toBe(0);

    // order 2 deterministically wins the coupon (order 1's transaction always
    // aborts) - full settlement + exactly one notification event and outbox
    const [order2Row] = await t.select().from(orders).where(eq(orders.id, order2.id));
    expect(order2Row.status).toBe("approved");
    const order2Events = await t
      .select()
      .from(notificationEvents)
      .where(and(eq(notificationEvents.kind, "order_completed"), eq(notificationEvents.sourceId, String(order2.id))));
    expect(order2Events).toHaveLength(1);
    const outboxRows = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, order2Events[0].id));
    expect(outboxRows).toHaveLength(1);

    // coupon invariants: exactly one consumption, recorded for the winner
    const usages = await t.select().from(couponUsages).where(eq(couponUsages.couponId, coupon.id));
    expect(usages).toHaveLength(1);
    expect(usages[0].orderId).toBe(order2.id);
    const [couponRow] = await t.select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(couponRow.usageCount).toBe(1);
    const winningEpisodeId = usages[0].orderId === order1.id ? episode1.id : episode2.id;
    expect(await scalarCount(t.select({ c: count() }).from(purchases).where(and(eq(purchases.userId, owner.id), eq(purchases.episodeId, winningEpisodeId))))).toBe(1);

    // duplicate sequential approval of the winning payment emits nothing new
    const eventsAfterDuplicate = await scalarCount(
      t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.kind, "order_completed"))
    );
    await adminCaller.admin.payments.approve({ paymentId: payment2Id }).catch(() => undefined);
    expect(await scalarCount(
      t.select({ c: count() }).from(notificationEvents).where(eq(notificationEvents.kind, "order_completed"))
    )).toBe(eventsAfterDuplicate);

    // cleanup
    const allEvents = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.targetUserId, owner.id));
    for (const row of allEvents) {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, row.id));
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.targetUserId, owner.id));
    await t.delete(notificationEvents).where(eq(notificationEvents.eventKey, poisonedKey));
    await t.delete(couponUsages).where(eq(couponUsages.couponId, coupon.id));
    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, owner.id));
    await t.delete(purchases).where(eq(purchases.userId, owner.id));
    await deleteFixtures({
      paymentIds: [payment1Id, payment2Id],
      orderIds: [order1.id, order2.id],
      episodeIds: [episode1.id, episode2.id],
      novelIds: [novel.id],
      couponIds: [coupon.id],
      userIds: [owner.id, admin.id],
    }).catch(() => undefined);
  }, 60_000);

  it("CR-11: NOTIFICATIONS_ENABLED=false (fresh module registry) - the financial approval still succeeds and writes ZERO notification rows", async () => {
    const t = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { price: "100.00" });
    // build order + payment through the REAL checkout path (the fresh
    // module registry below is only needed for the APPROVAL)
    const { appRouter: freshRouterModule } = await import("../routers");
    const caller = freshRouterModule.createCaller(userContext(owner.id));
    const cart = await db.getOrCreateCart(owner.id);
    await db.addToCart(cart!.id as number, episode.id, novel.id, "100.00");
    const created = await caller.checkout.create({ slipImageUrl: "https://local.invalid/cn-3.png" });
    const paymentId = (await db.getPaymentByOrderId(created.id))!.id;

    const beforeEvents = await scalarCount(t.select({ c: count() }).from(notificationEvents));
    const beforeOutbox = await scalarCount(t.select({ c: count() }).from(notificationOutbox));

    // fresh module registry with NOTIFICATIONS_ENABLED absent - the db.ts
    // runtime flag snapshot must resolve disabled, and the approval must
    // still settle financially with zero notification writes. The fresh
    // db.ts has no test injection, so point its production getDb() at the
    // SAME disposable database via DATABASE_URL (identical target to
    // TEST_DATABASE_URL - never a production system).
    vi.resetModules();
    delete process.env.NOTIFICATIONS_ENABLED;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const freshOrderService = await import("../services/orderService");
    await freshOrderService.approvePayment(paymentId, "9001");

    const [orderRow] = await t.select().from(orders).where(eq(orders.id, created.id));
    expect(orderRow.status).toBe("approved");
    const [paymentRow] = await t.select().from(payments).where(eq(payments.id, paymentId));
    expect(paymentRow.status).toBe("approved");
    expect(await scalarCount(t.select({ c: count() }).from(notificationEvents))).toBe(beforeEvents);
    expect(await scalarCount(t.select({ c: count() }).from(notificationOutbox))).toBe(beforeOutbox);

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }, 60_000);
});
