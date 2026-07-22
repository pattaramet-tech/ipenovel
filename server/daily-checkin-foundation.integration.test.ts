import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestCoupon, uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";
import { dailyCheckins, coupons, couponUsages, walletAccounts, pointsTransactions, orders } from "../drizzle/schema";

/**
 * Stage 0 foundation coverage: the duplicate-key recovery paths and the
 * points-balance ordering that the 1-point Daily Check-in reward will be
 * built on top of.
 *
 * The bug being locked out: every duplicate-key recovery branch used to
 * read only the top-level error's errno/code, but drizzle-orm wraps the
 * mysql2 error and the real 1062/ER_DUP_ENTRY lives on `error.cause`. Those
 * branches were therefore dead code - a user who double-clicked "check in"
 * got an INTERNAL_SERVER_ERROR even though their check-in had genuinely
 * succeeded and their coupon had been issued. Data was always correct; the
 * response lied. See server/helpers/databaseErrorClassifier.ts.
 *
 * These tests deliberately do NOT use the `if (!db) return` escape hatch
 * some legacy files use: this file lives in the integration project, whose
 * globalSetup (vitest.integration.globalsetup.ts) already refuses to run
 * without a verified disposable `ipenovel_test` database. Silently
 * no-op'ing here would hide exactly the regression this file exists to
 * catch.
 */

function ctxFor(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `stage0-${userId}`,
      email: `stage0-${userId}@example.test`,
      name: "Stage0 Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

/** Fails loudly (never silently skips) if the integration DB is missing. */
function requireIntegrationDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "daily-checkin-foundation.integration.test.ts requires a prepared disposable test database " +
        "(TEST_DATABASE_URL pointing at ipenovel_test). Run `pnpm test:db:prepare` first."
    );
  }
  return getTestDb();
}

async function checkinRowsFor(userId: number) {
  return requireIntegrationDb().select().from(dailyCheckins).where(eq(dailyCheckins.userId, userId));
}

/** Every coupon whose code belongs to this user's daily check-in namespace. */
async function checkinCouponsFor(userId: number) {
  const all = await requireIntegrationDb().select().from(coupons);
  return all.filter((c: any) => String(c.code).includes(`U${userId}`));
}

describe.sequential("Stage 0 - Daily Check-in concurrency foundation (real disposable test database)", () => {
  it("five CONCURRENT dailyCheckin.claim calls all resolve successfully - exactly one claimed, the rest alreadyClaimed, no INTERNAL_SERVER_ERROR", async () => {
    requireIntegrationDb();
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));

    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => caller.dailyCheckin.claim()));

    // 1. Nothing may reject at all - and specifically never with the
    //    generic INTERNAL_SERVER_ERROR the dead guard used to produce.
    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(
      rejected.map((r) => `${r.reason?.code}: ${r.reason?.message}`),
      "no concurrent claim may fail merely because another request won the race"
    ).toEqual([]);

    const values = settled.map((r) => (r as PromiseFulfilledResult<any>).value);

    // 2. Exactly one winner.
    expect(values.filter((v) => v.claimed === true)).toHaveLength(1);

    // 3. Every loser reports a successful already-claimed response.
    const losers = values.filter((v) => v.claimed === false);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      expect(loser.alreadyClaimed).toBe(true);
      expect(loser.campaignActive).toBe(true);
      // The loser must describe the WINNER's reward, not null.
      expect(loser.reward).toBeTruthy();
      expect(loser.reward.couponCode).toBeTruthy();
    }

    // 4. Every caller agrees on the same reward.
    const codes = new Set(values.map((v) => v.reward?.couponCode));
    expect(codes.size).toBe(1);

    // 5. Exactly one check-in row, one linked coupon, zero orphan coupons.
    const rows = await checkinRowsFor(user.id);
    expect(rows).toHaveLength(1);

    const issuedCoupons = await checkinCouponsFor(user.id);
    expect(issuedCoupons, "losing transactions must roll back their coupon insert (no orphans)").toHaveLength(1);
    expect(issuedCoupons[0].id).toBe(rows[0].couponId);

    await deleteFixtures({ userIds: [user.id] });
    const t = getTestDb();
    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await t.delete(coupons).where(eq(coupons.id, rows[0].couponId!));
  }, 30000);

  it("a repeated NON-concurrent claim also returns alreadyClaimed=true (no error, same reward)", async () => {
    requireIntegrationDb();
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));

    const first = await caller.dailyCheckin.claim();
    expect(first.claimed).toBe(true);

    const second = await caller.dailyCheckin.claim();
    expect(second.claimed).toBe(false);
    expect(second.alreadyClaimed).toBe(true);
    expect(second.reward?.couponCode).toBe(first.reward?.couponCode);

    const rows = await checkinRowsFor(user.id);
    expect(rows).toHaveLength(1);

    const t = getTestDb();
    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await t.delete(coupons).where(eq(coupons.id, rows[0].couponId!));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("getStatus after a concurrent claim burst reports the single winning reward", async () => {
    requireIntegrationDb();
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));

    await Promise.allSettled(Array.from({ length: 5 }, () => caller.dailyCheckin.claim()));
    const status = await caller.dailyCheckin.getStatus();

    expect((status as any).authenticated).toBe(true);
    expect((status as any).checkedInToday).toBe(true);
    expect((status as any).reward).toBeTruthy();

    const rows = await checkinRowsFor(user.id);
    expect(rows).toHaveLength(1);

    const t = getTestDb();
    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await t.delete(coupons).where(eq(coupons.id, rows[0].couponId!));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);
});

describe.sequential("Stage 0 - wallet account concurrency (real disposable test database)", () => {
  it("concurrent getOrCreateWalletAccount calls create exactly one account and all callers get it", async () => {
    requireIntegrationDb();
    const user = await createTestUser();

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => db.getOrCreateWalletAccount(user.id))
    );

    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(
      rejected.map((r) => String(r.reason?.message).slice(0, 80)),
      "a concurrent wallet-account insert must be recovered, never surfaced to the caller"
    ).toEqual([]);

    const accounts = settled.map((r) => (r as PromiseFulfilledResult<any>).value);
    for (const account of accounts) {
      expect(account).toBeTruthy();
      expect(account.userId).toBe(user.id);
    }
    // All callers resolved to the same row.
    expect(new Set(accounts.map((a) => a.id)).size).toBe(1);

    const rows = await getTestDb().select().from(walletAccounts).where(eq(walletAccounts.userId, user.id));
    expect(rows).toHaveLength(1);

    await getTestDb().delete(walletAccounts).where(eq(walletAccounts.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);
});

describe.sequential("Stage 0 - coupon usage duplicate handling (real disposable test database)", () => {
  it("concurrent recordCouponUsage calls record exactly one usage row and increment usageCount once", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    const coupon = await createTestCoupon({ discountType: "percentage", discountValue: "10.00" });
    const order = await db.createOrder({
      orderNumber: `STAGE0-${uniqueTestTag("ord")}`,
      userId: user.id,
      subtotal: "100.00",
      discountAmount: "10.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "90.00",
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => db.recordCouponUsage(coupon.id, user.id, order.id))
    );

    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(
      rejected.map((r) => String(r.reason?.message).slice(0, 80)),
      "a duplicate coupon-usage race must be absorbed by the recovery path, not thrown"
    ).toEqual([]);

    // Exactly one usage row for this (coupon, order).
    const usages = await t
      .select()
      .from(couponUsages)
      .where(and(eq(couponUsages.couponId, coupon.id), eq(couponUsages.orderId, order.id)));
    expect(usages).toHaveLength(1);

    // usageCount incremented exactly once, never per-racer.
    const couponRows = await t.select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(Number(couponRows[0].usageCount)).toBe(1);

    // Exactly one caller reported an actual insert.
    const values = settled.map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(values.filter((v) => v?.recorded === true)).toHaveLength(1);

    await t.delete(couponUsages).where(eq(couponUsages.couponId, coupon.id));
    await deleteFixtures({ orderIds: [order.id], couponIds: [coupon.id], userIds: [user.id] });
  }, 30000);
});

describe.sequential("Stage 0 - deterministic points balance ordering (real disposable test database)", () => {
  it("with several transactions sharing one createdAt second, the greatest id wins", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();

    // Identical createdAt on purpose: pointsTransactions.createdAt is a
    // second-precision MySQL timestamp, so this is not contrived - it is
    // what two writes in the same second actually look like. Without an
    // `id DESC` tiebreaker the engine may return ANY of these rows.
    const sharedCreatedAt = new Date("2026-07-22T10:00:00Z");
    const inserted: number[] = [];
    for (const [type, amount, balanceAfter] of [
      ["earn", "10.00", "10.00"],
      ["earn", "5.00", "15.00"],
      ["redeem", "3.00", "12.00"],
      ["earn", "1.00", "13.00"],
    ] as const) {
      const res: any = await t.insert(pointsTransactions).values({
        userId: user.id,
        type,
        amount: amount as any,
        balanceAfter: balanceAfter as any,
        referenceType: "stage0_test",
        referenceId: 1,
        createdAt: sharedCreatedAt,
      });
      inserted.push(res?.[0]?.insertId ?? res?.insertId);
    }

    const rows = await t.select().from(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    expect(rows).toHaveLength(4);
    // Prove the precondition: all four really do share one createdAt value.
    expect(new Set(rows.map((r: any) => new Date(r.createdAt).getTime())).size).toBe(1);

    const maxId = Math.max(...rows.map((r: any) => r.id));
    const expectedBalance = rows.find((r: any) => r.id === maxId)!.balanceAfter.toString();

    // Repeated reads must be stable AND must equal the greatest-id row.
    for (let i = 0; i < 3; i += 1) {
      const balance = await db.getUserPointsBalance(user.id);
      expect(balance).toBe(expectedBalance);
      expect(balance).toBe("13.00");
    }

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("an out-of-order insert with the same createdAt but a lower id does not rewind the balance", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    const sharedCreatedAt = new Date("2026-07-22T11:00:00Z");

    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "20.00", balanceAfter: "20.00",
      referenceType: "stage0_test", referenceId: 2, createdAt: sharedCreatedAt,
    });
    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "5.00", balanceAfter: "25.00",
      referenceType: "stage0_test", referenceId: 3, createdAt: sharedCreatedAt,
    });

    expect(await db.getUserPointsBalance(user.id)).toBe("25.00");

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);
});
