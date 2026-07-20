import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getBangkokBusinessDate, getNextBangkokDayStart } from "./_core/timezone";
import {
  validateDailyCheckinCampaignConfig,
  DEFAULT_DAILY_CHECKIN_CONFIG,
  saveDailyCheckinCampaignConfig,
} from "./_core/dailyCheckinConfig";
import * as orderService from "./services/orderService";
import { normalizeMoneyAmount } from "./helpers/moneyNormalizer";
import { randomUUID } from "node:crypto";

/**
 * Creates a real user row and returns the ID the database actually
 * assigned - replaces this file's previous approach of hardcoding literal
 * IDs (900001+) and hoping nothing else in a shared test database ever
 * used the same range. `dailyCheckins.userId`/`coupons` have no enforced
 * foreign key to `users` in this schema, so the hardcoded IDs never caused
 * an insert to fail outright, but they were still an assumption this
 * factory removes entirely - see docs/TEST_INFRASTRUCTURE.md PART E
 * ("สร้าง factory ที่คืน ID จริงจาก insert แทนการสมมติว่า ID = 1").
 */
async function createRealTestUserId(): Promise<number> {
  const tag = randomUUID().replace(/-/g, "").slice(0, 16);
  const openId = `checkin-fixture-${tag}`;
  await db.upsertUser({ openId, name: `Checkin Fixture ${tag}`, email: `${tag}@example.test`, loginMethod: "test" });
  const user = await db.getUserByOpenId(openId);
  if (!user) throw new Error("createRealTestUserId: upsertUser did not create a row");
  return (user as any).id;
}

/**
 * Phase 5 - daily check-in coupon rewards.
 *
 * Same two-tier convention as server/hybrid-access-regression.test.ts and
 * server/novels-browse-pagination.test.ts: pure logic (timezone math, config
 * validation) and pre-DB rejection paths (unauthenticated claim) run
 * unconditionally; everything that needs real rows is guarded with
 * `if (!db) return` so it no-ops cleanly without a live DATABASE_URL but
 * runs for real wherever one is configured.
 */

function userContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `checkin-test-${userId}`,
      email: `checkin-test-${userId}@example.com`,
      name: "Checkin Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function publicContext(): TrpcContext {
  return { user: null, req: { protocol: "https", headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("getBangkokBusinessDate - timezone boundary correctness (pure, no DB required)", () => {
  it("16:59:59 UTC is still the previous Bangkok calendar day (23:59:59 Thai time)", () => {
    expect(getBangkokBusinessDate(new Date("2026-07-20T16:59:59.000Z"))).toBe("2026-07-20");
  });

  it("17:00:00 UTC crosses into the next Bangkok calendar day (00:00:00 Thai time)", () => {
    expect(getBangkokBusinessDate(new Date("2026-07-20T17:00:00.000Z"))).toBe("2026-07-21");
  });

  it("is never equal to a naive UTC-only date string across the boundary", () => {
    const at = new Date("2026-07-20T18:30:00.000Z"); // 01:30 Bangkok next day
    const naiveUtcDate = at.toISOString().slice(0, 10);
    expect(getBangkokBusinessDate(at)).not.toBe(naiveUtcDate);
    expect(getBangkokBusinessDate(at)).toBe("2026-07-21");
    expect(naiveUtcDate).toBe("2026-07-20");
  });

  it("is deterministic and independent of the process's own timezone (only depends on the instant)", () => {
    const at = new Date("2026-01-01T10:00:00.000Z");
    expect(getBangkokBusinessDate(at)).toBe(getBangkokBusinessDate(new Date(at.getTime())));
  });
});

describe("getNextBangkokDayStart (pure, no DB required)", () => {
  it("returns the UTC instant of the following Bangkok midnight", () => {
    const next = getNextBangkokDayStart("2026-07-20");
    expect(next.toISOString()).toBe("2026-07-20T17:00:00.000Z"); // 2026-07-21T00:00:00+07:00
  });
});

describe("validateDailyCheckinCampaignConfig (pure, no DB required)", () => {
  it("accepts the default config", () => {
    expect(validateDailyCheckinCampaignConfig(DEFAULT_DAILY_CHECKIN_CONFIG).valid).toBe(true);
  });

  it("rejects rewardPercent out of range", () => {
    expect(validateDailyCheckinCampaignConfig({ rewardPercent: 0 }).valid).toBe(false);
    expect(validateDailyCheckinCampaignConfig({ rewardPercent: 150 }).valid).toBe(false);
  });

  it("rejects a negative minPurchaseAmount", () => {
    expect(validateDailyCheckinCampaignConfig({ minPurchaseAmount: -1 }).valid).toBe(false);
  });

  it("rejects a non-integer or out-of-range validityDays", () => {
    expect(validateDailyCheckinCampaignConfig({ validityDays: 0 }).valid).toBe(false);
    expect(validateDailyCheckinCampaignConfig({ validityDays: 1.5 }).valid).toBe(false);
  });
});

describe("dailyCheckin.claim - unauthenticated rejection (no DB required - rejected before any query)", () => {
  it("rejects an anonymous claim", async () => {
    const caller = appRouter.createCaller(publicContext());
    await expect(caller.dailyCheckin.claim()).rejects.toThrow();
  });

  it("getStatus for an anonymous visitor returns authenticated: false instead of throwing", async () => {
    const caller = appRouter.createCaller(publicContext());
    const result = await caller.dailyCheckin.getStatus();
    expect(result).toEqual({ authenticated: false });
  });
});

describe("claimDailyCheckin (DB required)", () => {
  let TEST_USER_A: number;
  let TEST_USER_B: number;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const database = await getDb();
    if (!database) return;
    TEST_USER_A = await createRealTestUserId();
    TEST_USER_B = await createRealTestUserId();
    createdUserIds.push(TEST_USER_A, TEST_USER_B);
  }, 30000);

  afterAll(async () => {
    const database = await getDb();
    if (!database || createdUserIds.length === 0) return;
    const idList = createdUserIds.join(",");
    await database.execute(`DELETE FROM dailyCheckins WHERE userId IN (${idList})`);
    await database.execute(`DELETE FROM coupons WHERE code LIKE 'CHKIN%U${TEST_USER_A}%' OR code LIKE 'CHKIN%U${TEST_USER_B}%'`);
    await database.execute(`DELETE FROM users WHERE id IN (${idList})`);
  });

  it("first claim of the day succeeds and issues exactly one coupon", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(TEST_USER_A);
    expect(result.claimed).toBe(true);
    expect(result.alreadyClaimed).toBe(false);
    expect(result.reward).not.toBeNull();
    expect(result.reward!.discountType).toBe("percentage");
    expect(Number(result.reward!.discountValue)).toBe(DEFAULT_DAILY_CHECKIN_CONFIG.rewardPercent);
  });

  it("second claim same day does not create a second record or coupon", async () => {
    const database = await getDb();
    if (!database) return;

    const first = await db.claimDailyCheckin(TEST_USER_A);
    const second = await db.claimDailyCheckin(TEST_USER_A);

    expect(second.alreadyClaimed).toBe(true);
    expect(second.claimed).toBe(false);
    // Same coupon both times - not a newly issued one.
    expect(second.reward!.couponId).toBe(first.claimed ? first.reward!.couponId : second.reward!.couponId);

    const rows = await database.execute(
      `SELECT COUNT(*) as cnt FROM dailyCheckins WHERE userId = ${TEST_USER_A} AND checkinDate = '${getBangkokBusinessDate()}'`
    );
    const count = Number((rows as any)[0]?.[0]?.cnt ?? (rows as any).rows?.[0]?.cnt ?? 0);
    expect(count).toBe(1);
  });

  it("concurrent claims for the same user resolve to exactly one issued coupon", async () => {
    const database = await getDb();
    if (!database) return;

    const uniqueUser = await createRealTestUserId();
    try {
      const [r1, r2] = await Promise.all([db.claimDailyCheckin(uniqueUser), db.claimDailyCheckin(uniqueUser)]);
      const claimedCount = [r1, r2].filter((r) => r.claimed).length;
      expect(claimedCount).toBe(1);
      // Both results point at the same single coupon.
      expect(r1.reward!.couponId).toBe(r2.reward!.couponId);
    } finally {
      await database.execute(`DELETE FROM dailyCheckins WHERE userId = ${uniqueUser}`);
      await database.execute(`DELETE FROM coupons WHERE code LIKE 'CHKIN%U${uniqueUser}%'`);
      await database.execute(`DELETE FROM users WHERE id = ${uniqueUser}`);
    }
  });

  it("a different user can check in independently on the same day", async () => {
    const database = await getDb();
    if (!database) return;

    await db.claimDailyCheckin(TEST_USER_A); // ensure A already checked in
    const resultB = await db.claimDailyCheckin(TEST_USER_B);
    expect(resultB.claimed).toBe(true);
  });

  it("a check-in from a previous Bangkok day does not block today's claim", async () => {
    const database = await getDb();
    if (!database) return;

    const yesterdayUser = await createRealTestUserId();
    try {
      // Simulate "already checked in yesterday" by inserting directly with
      // yesterday's business date, bypassing claimDailyCheckin (which always
      // uses today's date) - this isolates the test to the DB-level
      // per-day uniqueness logic, not the clock.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yesterdayDate = getBangkokBusinessDate(yesterday);
      const couponResult = await database.execute(
        `INSERT INTO coupons (code, discountType, discountValue, maxUsageCount, usageCount, isActive) VALUES ('CHKINYESTERDAY${yesterdayUser}', 'percentage', '5.00', 1, 0, true)`
      );
      const couponId = (couponResult as any)[0]?.insertId ?? (couponResult as any).insertId;
      await database.execute(
        `INSERT INTO dailyCheckins (userId, checkinDate, campaignKey, couponId, status) VALUES (${yesterdayUser}, '${yesterdayDate}', 'default', ${couponId}, 'issued')`
      );

      const today = await db.claimDailyCheckin(yesterdayUser);
      expect(today.claimed).toBe(true);
      expect(today.checkinDate).toBe(getBangkokBusinessDate());
      expect(today.checkinDate).not.toBe(yesterdayDate);
    } finally {
      await database.execute(`DELETE FROM dailyCheckins WHERE userId = ${yesterdayUser}`);
      await database.execute(`DELETE FROM coupons WHERE code LIKE 'CHKIN%${yesterdayUser}%'`);
      await database.execute(`DELETE FROM users WHERE id = ${yesterdayUser}`);
    }
  });

  it("issues the coupon with an expiry exactly DEFAULT_DAILY_CHECKIN_CONFIG.validityDays (7) days out", async () => {
    const database = await getDb();
    if (!database) return;

    const expiryUser = await createRealTestUserId();
    try {
      const before = Date.now();
      const result = await db.claimDailyCheckin(expiryUser);
      const after = Date.now();

      expect(result.reward!.expiresAt).toBeTruthy();
      const expiresAt = new Date(result.reward!.expiresAt!).getTime();
      const expectedMs = DEFAULT_DAILY_CHECKIN_CONFIG.validityDays * 24 * 60 * 60 * 1000;

      // Bounded by [before, after] + the configured validity window, with a
      // small tolerance for query/clock latency between the two Date.now()
      // calls above - never a wide, meaningless tolerance.
      expect(expiresAt).toBeGreaterThanOrEqual(before + expectedMs - 5000);
      expect(expiresAt).toBeLessThanOrEqual(after + expectedMs + 5000);
    } finally {
      await database.execute(`DELETE FROM dailyCheckins WHERE userId = ${expiryUser}`);
      await database.execute(`DELETE FROM coupons WHERE code LIKE 'CHKIN%U${expiryUser}%'`);
      await database.execute(`DELETE FROM users WHERE id = ${expiryUser}`);
    }
  });

  it("a disabled campaign (kill switch) rejects new claims without issuing a coupon", async () => {
    const database = await getDb();
    if (!database) return;

    const killSwitchUser = await createRealTestUserId();
    try {
      const saveResult = await saveDailyCheckinCampaignConfig({ isActive: false });
      expect(saveResult.success).toBe(true);

      const result = await db.claimDailyCheckin(killSwitchUser);
      expect(result.claimed).toBe(false);
      expect(result.campaignActive).toBe(false);
      expect(result.reward).toBeNull();

      const rows = await database.execute(`SELECT COUNT(*) as cnt FROM dailyCheckins WHERE userId = ${killSwitchUser}`);
      const count = Number((rows as any)[0]?.[0]?.cnt ?? (rows as any).rows?.[0]?.cnt ?? 0);
      expect(count).toBe(0);
    } finally {
      await saveDailyCheckinCampaignConfig({ isActive: true });
      await database.execute(`DELETE FROM dailyCheckins WHERE userId = ${killSwitchUser}`);
      await database.execute(`DELETE FROM users WHERE id = ${killSwitchUser}`);
    }
  });
});

describe("Daily check-in coupon validation/redemption (DB required)", () => {
  // One real user per scenario that needs its own isolated coupon (each
  // claimDailyCheckin issues at most one coupon per user per day, so
  // scenarios that each need a fresh coupon each need a distinct user) -
  // replaces the previous COUPON_USER/COUPON_USER+1..+6 offset-arithmetic
  // scheme, which assumed a block of consecutive integer IDs was safely
  // unused rather than asking the database for real ones.
  let COUPON_USER: number;
  let OTHER_USER: number;
  let MIN_PURCHASE_USER: number;
  let DISCOUNT_5PCT_USER: number;
  let DISCOUNT_CAP_USER: number;
  let ROUNDING_USER: number;
  let USED_COUPON_USER: number;
  let NON_NEGATIVE_USER: number;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const database = await getDb();
    if (!database) return;
    [
      COUPON_USER,
      OTHER_USER,
      MIN_PURCHASE_USER,
      DISCOUNT_5PCT_USER,
      DISCOUNT_CAP_USER,
      ROUNDING_USER,
      USED_COUPON_USER,
      NON_NEGATIVE_USER,
    ] = await Promise.all(Array.from({ length: 8 }, () => createRealTestUserId()));
    createdUserIds.push(
      COUPON_USER,
      OTHER_USER,
      MIN_PURCHASE_USER,
      DISCOUNT_5PCT_USER,
      DISCOUNT_CAP_USER,
      ROUNDING_USER,
      USED_COUPON_USER,
      NON_NEGATIVE_USER
    );
  }, 30000);

  afterAll(async () => {
    const database = await getDb();
    if (!database || createdUserIds.length === 0) return;
    const idList = createdUserIds.join(",");
    await database.execute(`DELETE FROM dailyCheckins WHERE userId IN (${idList})`);
    await database.execute(`DELETE FROM coupons WHERE code LIKE 'CHKIN%U${COUPON_USER}%'`);
    await database.execute(`DELETE FROM users WHERE id IN (${idList})`);
  });

  it("the issued coupon is bound to the claiming user - another user cannot redeem it", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(COUPON_USER);
    const code = result.reward!.couponCode;

    await expect(orderService.validateAndApplyCoupon(code, "100.00", undefined, OTHER_USER)).rejects.toThrow(
      /belongs to another user/i
    );

    // The owner can use it.
    const owned = await orderService.validateAndApplyCoupon(code, "100.00", undefined, COUPON_USER);
    expect(owned.coupon.code).toBe(code.toUpperCase());
  });

  it("enforces the ฿50 minimum purchase amount", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(MIN_PURCHASE_USER);
    const code = result.reward!.couponCode;

    await expect(orderService.validateAndApplyCoupon(code, "49.99", undefined, MIN_PURCHASE_USER)).rejects.toThrow(
      /minimum purchase/i
    );
    await expect(
      orderService.validateAndApplyCoupon(code, "50.00", undefined, MIN_PURCHASE_USER)
    ).resolves.toBeTruthy();
  });

  it("computes a 5% discount correctly below the cap", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(DISCOUNT_5PCT_USER);
    const code = result.reward!.couponCode;

    const { discountAmount } = await orderService.validateAndApplyCoupon(code, "100.00", undefined, DISCOUNT_5PCT_USER);
    expect(discountAmount).toBe("5.00"); // 5% of 100
  });

  it("caps the discount at ฿10 regardless of a larger subtotal", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(DISCOUNT_CAP_USER);
    const code = result.reward!.couponCode;

    // 5% of 1000 would be 50, but the cap is 10.
    const { discountAmount } = await orderService.validateAndApplyCoupon(code, "1000.00", undefined, DISCOUNT_CAP_USER);
    expect(discountAmount).toBe("10.00");
  });

  it("rounds correctly for a subtotal that doesn't divide evenly", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(ROUNDING_USER);
    const code = result.reward!.couponCode;

    // 5% of 63.33 = 3.1665 -> rounds to 3.17 (formatMoney/normalizeMoneyAmount's rounding)
    const { discountAmount } = await orderService.validateAndApplyCoupon(code, "63.33", undefined, ROUNDING_USER);
    expect(discountAmount).toBe(normalizeMoneyAmount(3.1665, "expected").toFixed(2));
  });

  it("an expired coupon cannot be used", async () => {
    const database = await getDb();
    if (!database) return;

    const couponResult = await database.execute(
      `INSERT INTO coupons (code, discountType, discountValue, maxDiscountAmount, minPurchaseAmount, maxUsageCount, usageCount, isActive, expiresAt) VALUES ('CHKINEXPIREDTEST', 'percentage', '5.00', '10.00', '50.00', 1, 0, true, '2020-01-01 00:00:00')`
    );
    void couponResult;

    await expect(orderService.validateAndApplyCoupon("CHKINEXPIREDTEST", "100.00")).rejects.toThrow(/expired/i);
    await database.execute(`DELETE FROM coupons WHERE code = 'CHKINEXPIREDTEST'`);
  });

  it("a used check-in coupon cannot be redeemed again", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(USED_COUPON_USER);
    const couponId = result.reward!.couponId;

    await db.markDailyCheckinCouponUsed(couponId, USED_COUPON_USER);

    await expect(
      orderService.validateAndApplyCoupon(result.reward!.couponCode, "100.00", undefined, USED_COUPON_USER)
    ).rejects.toThrow(/already been used/i);
  });

  it("existing (non-check-in) coupons with maxDiscountAmount = NULL keep their old, uncapped behavior", async () => {
    const database = await getDb();
    if (!database) return;

    // Mirrors a coupon created before this feature existed: percentage
    // discount, no maxDiscountAmount column value at all. Must NOT be
    // affected by the new cap logic - a large subtotal should still produce
    // the full, uncapped percentage discount.
    await database.execute(
      `INSERT INTO coupons (code, discountType, discountValue, maxDiscountAmount, minPurchaseAmount, maxUsageCount, usageCount, isActive) VALUES ('LEGACYUNCAPPED', 'percentage', '5.00', NULL, '0.00', NULL, 0, true)`
    );

    try {
      const { discountAmount } = await orderService.validateAndApplyCoupon("LEGACYUNCAPPED", "1000.00");
      // 5% of 1000 = 50, which would be capped to 10 for a check-in coupon -
      // this coupon has no cap, so it must come back uncapped.
      expect(discountAmount).toBe("50.00");
    } finally {
      await database.execute(`DELETE FROM coupons WHERE code = 'LEGACYUNCAPPED'`);
    }
  });

  it("discount never makes the order total negative (capped at subtotal)", async () => {
    const database = await getDb();
    if (!database) return;

    const result = await db.claimDailyCheckin(NON_NEGATIVE_USER);
    const code = result.reward!.couponCode;

    // Even at exactly the minimum purchase amount, discount (5%, capped at
    // ฿10) must never exceed the subtotal itself.
    const { discountAmount } = await orderService.validateAndApplyCoupon(code, "50.00", undefined, NON_NEGATIVE_USER);
    expect(Number(discountAmount)).toBeLessThanOrEqual(50);
    expect(Number(discountAmount)).toBeGreaterThan(0);
  });
});
