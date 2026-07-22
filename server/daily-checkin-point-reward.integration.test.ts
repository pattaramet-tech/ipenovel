import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
import * as orderService from "./services/orderService";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, deleteFixtures } from "./test-helpers/fixtures";
import {
  dailyCheckins,
  dailyCheckinCampaigns,
  dailyCheckinRewardRules,
  dailyCheckinRewardGrants,
  pointsTransactions,
  coupons,
} from "../drizzle/schema";
import * as dailyCheckinRewardModeService from "./services/dailyCheckinRewardModeService";
import {
  scheduleDailyCheckinPointRollout,
  cancelDailyCheckinPointRollout,
  getDailyCheckinRolloutStatus,
} from "./services/dailyCheckinRewardModeService";
import { getBangkokBusinessDate, getPreviousBangkokBusinessDate } from "./_core/timezone";
import { saveDailyCheckinCampaignConfig } from "./_core/dailyCheckinConfig";
import { sanitizeTrpcErrorShape, GENERIC_INTERNAL_ERROR_MESSAGE } from "./_core/trpc";

/**
 * The Daily Check-in 1-point reward, against a real disposable database and
 * the real tRPC router.
 *
 * These tests never silently skip: this file lives in the integration
 * project, whose globalSetup already refuses to run without a verified
 * disposable `ipenovel_test` database. A quiet `if (!db) return` here would
 * hide exactly the regressions this file exists to catch.
 *
 * No external service is contacted - the point reward path touches only the
 * database (no Storage, no OCR, no Discord, no Wallet).
 */

function ctxFor(userId: number, role: "user" | "admin" = "user"): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `pt-${userId}`,
      email: `pt-${userId}@example.test`,
      name: "Point Reward Test User",
      loginMethod: "test",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function requireIntegrationDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "daily-checkin-point-reward.integration.test.ts requires a prepared disposable test database. Run `pnpm test:db:prepare` first."
    );
  }
  return getTestDb();
}

/** Wipes only Daily Check-in / points state so each test starts from a known mode. */
async function resetCheckinState() {
  if (!process.env.TEST_DATABASE_URL) return;
  const t = requireIntegrationDb();
  await t.execute(sql`DELETE FROM dailyCheckinRewardGrants`);
  await t.execute(sql`DELETE FROM dailyCheckinRewardRules`);
  await t.execute(sql`DELETE FROM dailyCheckinCampaigns`);
  await t.execute(sql`DELETE FROM dailyCheckins`);
  await t.execute(sql`DELETE FROM pointsTransactions`);
  await saveDailyCheckinCampaignConfig({ isActive: true });
}

// File-level cleanup: each describe block's own beforeEach only resets state
// BEFORE its own tests run, so nothing wipes the residue left behind by this
// file's very LAST test (e.g. "rollout status..." leaves a campaign, a
// grant, and a points transaction behind). Because vitest.integration.config
// runs every integration file sequentially against one shared database
// (fileParallelism: false), that residue would otherwise leak into whichever
// file runs next - and resolveDailyCheckinRuntimeMode's Blocker 4 safe-stop
// guard (server/services/dailyCheckinRewardModeService.ts) correctly, but
// unhelpfully, treats ANY leftover dailyCheckinRewardGrants row as "point
// history exists," switching a fresh test user in a DIFFERENT file straight
// to "disabled" instead of the "legacy_coupon" that file actually expects
// from an empty database. This afterAll is what makes that guard's
// correctness not depend on which other test files happened to run first.
afterAll(async () => {
  await resetCheckinState();
});

function addBangkokDays(date: string, days: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Schedules the rollout and back-dates it so point mode is live right now. */
async function activatePointModeNow(adminId: number) {
  const today = getBangkokBusinessDate();
  await scheduleDailyCheckinPointRollout(addBangkokDays(today, 1), adminId);
  await requireIntegrationDb().execute(
    sql`UPDATE dailyCheckinCampaigns SET startDate = ${getPreviousBangkokBusinessDate(today)}`
  );
}

async function rowsFor(userId: number) {
  const t = requireIntegrationDb();
  return {
    checkins: await t.select().from(dailyCheckins).where(eq(dailyCheckins.userId, userId)),
    points: await t.select().from(pointsTransactions).where(eq(pointsTransactions.userId, userId)),
    grants: await t.select().from(dailyCheckinRewardGrants).where(eq(dailyCheckinRewardGrants.userId, userId)),
  };
}

describe.sequential("Daily Check-in point reward - claim behavior", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("the first claim in point mode grants exactly 1.00 point with all three rows linked", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const caller = appRouter.createCaller(ctxFor(user.id));

    const result: any = await caller.dailyCheckin.claim();

    expect(result.claimed).toBe(true);
    expect(result.rewardMode).toBe("points");
    expect(result.pointsBalance).toBe("1.00");
    // The legacy coupon field is never repurposed for a point reward.
    expect(result.reward).toBeNull();
    expect(result.rewards).toHaveLength(1);
    expect(result.rewards[0].kind).toBe("points");
    expect(result.rewards[0].pointsAmount).toBe("1.00");
    expect(result.rewards[0].balanceAfterGrant).toBe("1.00");

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(checkins[0].couponId).toBeNull();
    expect(points).toHaveLength(1);
    expect(grants).toHaveLength(1);

    // Ledger row is traceable back to the exact check-in.
    expect(points[0].type).toBe("earn");
    expect(String(points[0].amount)).toBe("1.00");
    expect(String(points[0].balanceAfter)).toBe("1.00");
    expect(points[0].referenceType).toBe("daily_checkin");
    expect(points[0].referenceId).toBe(checkins[0].id);

    // Grant links check-in <-> ledger row, with an explicit streak.
    expect(grants[0].dailyCheckinId).toBe(checkins[0].id);
    expect(grants[0].pointsTransactionId).toBe(points[0].id);
    expect(grants[0].rewardKind).toBe("points");
    expect(grants[0].grantReason).toBe("daily");
    expect(String(grants[0].pointsAmount)).toBe("1.00");
    expect(grants[0].streakCountAtGrant).toBe(1);
    expect(grants[0].couponId).toBeNull();
    expect(grants[0].status).toBe("granted");

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("no coupon row is created in point mode", async () => {
    const t = requireIntegrationDb();
    const before = (await t.select().from(coupons)).length;
    const user = await createTestUser();
    await activatePointModeNow(user.id);

    await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();

    expect((await t.select().from(coupons)).length).toBe(before);
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("a repeated same-day claim grants zero additional points", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const caller = appRouter.createCaller(ctxFor(user.id));

    const first: any = await caller.dailyCheckin.claim();
    const second: any = await caller.dailyCheckin.claim();

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.alreadyClaimed).toBe(true);
    expect(second.rewards[0].kind).toBe("points");

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(points).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("FIVE CONCURRENT claims increase the balance by exactly 1.00 and all resolve successfully", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const caller = appRouter.createCaller(ctxFor(user.id));

    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => caller.dailyCheckin.claim()));

    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(
      rejected.map((r) => `${r.reason?.code}: ${r.reason?.message}`),
      "no concurrent claim may fail merely because another request won the race"
    ).toEqual([]);

    const values = settled.map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(values.filter((v) => v.claimed === true)).toHaveLength(1);
    expect(values.filter((v) => v.alreadyClaimed === true)).toHaveLength(4);

    // Every caller describes the same winning reward.
    const txIds = new Set(values.map((v) => v.rewards?.[0]?.pointsTransactionId));
    expect(txIds.size).toBe(1);

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(points).toHaveLength(1);
    expect(grants).toHaveLength(1);
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);
});

describe.sequential("Daily Check-in point reward - balance arithmetic", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("prior balance 0.00 becomes 1.00", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("prior balance 5.00 becomes 6.00", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    await db.recordPointsTransaction({
      userId: user.id, type: "earn", amount: "5.00", balanceAfter: "5.00",
      referenceType: "order", referenceId: 1,
    });

    const result: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();

    expect(result.rewards[0].balanceAfterGrant).toBe("6.00");
    expect(result.pointsBalance).toBe("6.00");
    expect(await db.getUserPointsBalance(user.id)).toBe("6.00");
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("an ordinary earn recorded in the same second as the check-in preserves both, deterministically", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);

    await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim(); // -> 1.00
    await db.recordPointsTransaction({
      userId: user.id, type: "earn", amount: "3.00", balanceAfter: "4.00",
      referenceType: "order", referenceId: 2,
    });

    // Same-second rows: the PR #7 (createdAt DESC, id DESC) ordering must
    // still return the newest row, not an arbitrary tie.
    for (let i = 0; i < 3; i += 1) {
      expect(await db.getUserPointsBalance(user.id)).toBe("4.00");
    }
    const { points } = await rowsFor(user.id);
    expect(points).toHaveLength(2);

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("a redemption after the check-in credit leaves the correct balance", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);

    await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim(); // 0 -> 1.00
    await db.recordPointsTransaction({
      userId: user.id, type: "redeem", amount: "1.00", balanceAfter: "0.00",
      referenceType: "order", referenceId: 3,
    });

    expect(await db.getUserPointsBalance(user.id)).toBe("0.00");
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);
});

describe.sequential("Daily Check-in point reward - atomic rollback", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("a failure while inserting the reward grant rolls back the check-in AND the points transaction", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    await activatePointModeNow(user.id);

    const balanceBefore = await db.getUserPointsBalance(user.id);
    expect((await t.select().from(dailyCheckinCampaigns))[0]).toBeDefined();
    expect((await t.select().from(dailyCheckinRewardRules))[0]).toBeDefined();

    // Reproduces the claim's exact transaction shape - user lock, check-in
    // insert, points-transaction insert - and then throws where the reward
    // grant insert would run. Driving the failure through the real
    // transaction (rather than mocking the module) is what actually proves
    // MySQL rolled all three writes back together, which is the guarantee
    // under test.
    let threw = false;
    try {
      await (await db.getDb())!.transaction(async (tx: any) => {
        await db.lockUserForPoints(user.id, tx);
        await tx.insert(dailyCheckins).values({
          userId: user.id,
          checkinDate: getBangkokBusinessDate(),
          campaignKey: "default",
          couponId: null,
          status: "issued",
          issuedAt: new Date(),
        });
        await db.recordPointsTransactionReturningId(
          {
            userId: user.id, type: "earn", amount: "1.00", balanceAfter: "1.00",
            referenceType: "daily_checkin", referenceId: 999999,
          },
          tx
        );
        throw new Error("Simulated failure before the grant insert commits");
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins, "check-in row must have rolled back").toHaveLength(0);
    expect(points, "points transaction must have rolled back").toHaveLength(0);
    expect(grants).toHaveLength(0);
    expect(await db.getUserPointsBalance(user.id)).toBe(balanceBefore);

    // And the real claim still works afterwards.
    const result: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();
    expect(result.claimed).toBe(true);
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);
});

describe.sequential("Daily Check-in point reward - Bangkok date behavior", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("a previous-day check-in does not block today's point claim, and the streak increments", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const today = getBangkokBusinessDate();

    // Yesterday's check-in, as a legacy coupon row (couponId stays NULL here
    // only because no coupon fixture is needed to prove date behavior).
    await t.insert(dailyCheckins).values({
      userId: user.id,
      checkinDate: getPreviousBangkokBusinessDate(today),
      campaignKey: "default",
      couponId: null,
      status: "issued",
    });

    const result: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();

    expect(result.claimed).toBe(true);
    const { grants } = await rowsFor(user.id);
    // Today + yesterday = a 2-day streak.
    expect(grants[0].streakCountAtGrant).toBe(2);

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("a gap in the middle breaks the streak", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const today = getBangkokBusinessDate();

    // Two days ago and three days ago, but NOT yesterday.
    await t.insert(dailyCheckins).values({
      userId: user.id, checkinDate: addBangkokDays(today, -2), campaignKey: "default", couponId: null, status: "issued",
    });
    await t.insert(dailyCheckins).values({
      userId: user.id, checkinDate: addBangkokDays(today, -3), campaignKey: "default", couponId: null, status: "issued",
    });

    await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();

    const { grants } = await rowsFor(user.id);
    expect(grants[0].streakCountAtGrant).toBe(1);
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("the same Bangkok date always blocks a second reward", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.dailyCheckin.claim();
    await caller.dailyCheckin.claim();
    await caller.dailyCheckin.claim();

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(points).toHaveLength(1);
    expect(grants).toHaveLength(1);
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);
});

describe.sequential("Daily Check-in - legacy transition", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("with no relational campaign the legacy coupon flow is used", async () => {
    const user = await createTestUser();
    const result: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();

    expect(result.rewardMode).toBe("legacy_coupon");
    expect(result.claimed).toBe(true);
    expect(result.reward).not.toBeNull();
    expect(result.rewards[0].kind).toBe("coupon");

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins[0].couponId).not.toBeNull();
    expect(points, "legacy mode must not touch the points ledger").toHaveLength(0);
    expect(grants).toHaveLength(0);

    const t = getTestDb();
    await t.delete(coupons).where(eq(coupons.id, checkins[0].couponId!));
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("a campaign scheduled for a FUTURE date keeps the legacy coupon flow (deployment alone does not flip the reward)", async () => {
    const user = await createTestUser();
    await scheduleDailyCheckinPointRollout(addBangkokDays(getBangkokBusinessDate(), 3), user.id);

    const status: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.getStatus();
    expect(status.rewardMode).toBe("legacy_coupon");

    const result: any = await appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim();
    expect(result.rewardMode).toBe("legacy_coupon");
    expect(result.rewards[0].kind).toBe("coupon");

    const { checkins, points } = await rowsFor(user.id);
    expect(points).toHaveLength(0);

    const t = getTestDb();
    await t.delete(coupons).where(eq(coupons.id, checkins[0].couponId!));
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("CUTOVER: a legacy coupon claimed earlier the same Bangkok date blocks a point reward that day", async () => {
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));

    // Morning: legacy coupon claim.
    const morning: any = await caller.dailyCheckin.claim();
    expect(morning.rewardMode).toBe("legacy_coupon");
    const couponId = (await rowsFor(user.id)).checkins[0].couponId;
    expect(couponId).not.toBeNull();

    // Cutover happens later the same day.
    await activatePointModeNow(user.id);

    const afternoon: any = await caller.dailyCheckin.claim();
    expect(afternoon.claimed).toBe(false);
    expect(afternoon.alreadyClaimed).toBe(true);
    // Still the coupon - the user did not receive a point.
    expect(afternoon.rewards[0].kind).toBe("coupon");
    expect(afternoon.reward).not.toBeNull();

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(points, "no point may be granted on top of the same-day coupon").toHaveLength(0);
    expect(grants).toHaveLength(0);
    expect(await db.getUserPointsBalance(user.id)).toBe("0.00");

    const t = getTestDb();
    await t.delete(coupons).where(eq(coupons.id, couponId!));
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("an existing coupon issued before cutover is not converted and remains usable after cutover", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.dailyCheckin.claim(); // legacy coupon
    const couponId = (await rowsFor(user.id)).checkins[0].couponId!;
    const before = (await t.select().from(coupons).where(eq(coupons.id, couponId)))[0];

    await activatePointModeNow(user.id);

    const after = (await t.select().from(coupons).where(eq(coupons.id, couponId)))[0];
    expect(after.code).toBe(before.code);
    expect(String(after.discountValue)).toBe(String(before.discountValue));
    expect(after.isActive).toBe(before.isActive);
    // No retroactive points for the historical check-in.
    expect(await db.getUserPointsBalance(user.id)).toBe("0.00");

    await t.delete(coupons).where(eq(coupons.id, couponId));
    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("the global kill switch stops BOTH modes without altering history", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const caller = appRouter.createCaller(ctxFor(user.id));

    await caller.dailyCheckin.claim();
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");

    await saveDailyCheckinCampaignConfig({ isActive: false });

    const user2 = await createTestUser();
    const blocked: any = await appRouter.createCaller(ctxFor(user2.id)).dailyCheckin.claim();
    expect(blocked.claimed).toBe(false);
    expect(blocked.campaignActive).toBe(false);
    expect(blocked.rewardMode).toBe("disabled");
    expect((await rowsFor(user2.id)).checkins).toHaveLength(0);

    // The already-granted point is untouched and still readable.
    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");
    const status: any = await caller.dailyCheckin.getStatus();
    expect(status.checkedInToday).toBe(true);
    expect(status.rewards[0].kind).toBe("points");

    await saveDailyCheckinCampaignConfig({ isActive: true });
    await deleteFixtures({ userIds: [user.id] });
    await deleteFixtures({ userIds: [user2.id] });
  }, 40000);
});

describe.sequential("Daily Check-in rollout administration", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("a non-admin cannot read or schedule the rollout", async () => {
    const user = await createTestUser();
    const caller = appRouter.createCaller(ctxFor(user.id, "user"));

    let statusCode: string | undefined;
    try { await caller.admin.dailyCheckinRollout.status(); } catch (e: any) { statusCode = e.code; }
    expect(statusCode).toBe("FORBIDDEN");

    let scheduleCode: string | undefined;
    try {
      await caller.admin.dailyCheckinRollout.schedule({ startDate: addBangkokDays(getBangkokBusinessDate(), 2) });
    } catch (e: any) { scheduleCode = e.code; }
    expect(scheduleCode).toBe("FORBIDDEN");

    await deleteFixtures({ userIds: [user.id] });
  }, 40000);

  it("scheduling requires a strictly future Bangkok date", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const today = getBangkokBusinessDate();

    for (const bad of [today, addBangkokDays(today, -1)]) {
      let code: string | undefined;
      try { await caller.admin.dailyCheckinRollout.schedule({ startDate: bad }); } catch (e: any) { code = e.code; }
      expect(code, `startDate ${bad} must be rejected`).toBe("BAD_REQUEST");
    }

    // A syntactically valid but non-existent calendar date is rejected too.
    let badDateCode: string | undefined;
    try { await caller.admin.dailyCheckinRollout.schedule({ startDate: "2026-02-30" }); }
    catch (e: any) { badDateCode = e.code; }
    expect(badDateCode).toBe("BAD_REQUEST");

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("scheduling creates exactly one campaign and one fixed 1.00-point daily rule, and is idempotent", async () => {
    const t = requireIntegrationDb();
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const start = addBangkokDays(getBangkokBusinessDate(), 2);

    const first: any = await caller.admin.dailyCheckinRollout.schedule({ startDate: start });
    expect(first.scheduled).toBe(true);

    const second: any = await caller.admin.dailyCheckinRollout.schedule({ startDate: start });
    expect(second.alreadyScheduled).toBe(true);

    const campaigns = await t.select().from(dailyCheckinCampaigns);
    const rules = await t.select().from(dailyCheckinRewardRules);
    expect(campaigns).toHaveLength(1);
    expect(rules).toHaveLength(1);
    expect(campaigns[0].campaignKey).toBe("default");
    expect(campaigns[0].timezone).toBe("Asia/Bangkok");
    expect(campaigns[0].startDate).toBe(start);
    expect(rules[0].ruleType).toBe("daily");
    expect(rules[0].rewardKind).toBe("points");
    expect(String(rules[0].pointsAmount)).toBe("1.00");
    expect(rules[0].dedupeKey).toBe("daily:points");
    expect(rules[0].isActive).toBe(true);

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("scheduling a DIFFERENT date while one is already scheduled is rejected", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const today = getBangkokBusinessDate();

    await caller.admin.dailyCheckinRollout.schedule({ startDate: addBangkokDays(today, 2) });

    let code: string | undefined;
    try { await caller.admin.dailyCheckinRollout.schedule({ startDate: addBangkokDays(today, 5) }); }
    catch (e: any) { code = e.code; }
    expect(code).toBe("BAD_REQUEST");

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("cancellation before the start date succeeds and removes only the unstarted campaign", async () => {
    const t = requireIntegrationDb();
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(ctxFor(admin.id, "admin"));

    await caller.admin.dailyCheckinRollout.schedule({ startDate: addBangkokDays(getBangkokBusinessDate(), 4) });
    const result: any = await caller.admin.dailyCheckinRollout.cancel();

    expect(result.cancelled).toBe(true);
    expect(await t.select().from(dailyCheckinCampaigns)).toHaveLength(0);
    expect(await t.select().from(dailyCheckinRewardRules)).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("cancellation is REJECTED once point grants exist, and deletes nothing", async () => {
    const t = requireIntegrationDb();
    const admin = await createTestUser({ role: "admin" });
    await activatePointModeNow(admin.id);
    await appRouter.createCaller(ctxFor(admin.id)).dailyCheckin.claim();

    let code: string | undefined;
    try { await appRouter.createCaller(ctxFor(admin.id, "admin")).admin.dailyCheckinRollout.cancel(); }
    catch (e: any) { code = e.code; }
    expect(code).toBe("BAD_REQUEST");

    // Nothing historical was destroyed.
    expect(await t.select().from(dailyCheckinCampaigns)).toHaveLength(1);
    expect((await rowsFor(admin.id)).grants).toHaveLength(1);
    expect((await rowsFor(admin.id)).points).toHaveLength(1);
    expect(await db.getUserPointsBalance(admin.id)).toBe("1.00");

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("rollout status reports the live mode, schedule and grant existence", async () => {
    const admin = await createTestUser({ role: "admin" });

    const before = await getDailyCheckinRolloutStatus();
    expect(before.runtimeMode).toBe("legacy_coupon");
    expect(before.scheduledStartDate).toBeNull();
    expect(before.hasPointGrants).toBe(false);
    expect(before.pointsAmount).toBe("1.00");
    expect(before.killSwitchActive).toBe(true);

    await activatePointModeNow(admin.id);
    await appRouter.createCaller(ctxFor(admin.id)).dailyCheckin.claim();

    const after = await getDailyCheckinRolloutStatus();
    expect(after.runtimeMode).toBe("points");
    expect(after.hasPointGrants).toBe(true);
    expect(after.currentBangkokDate).toBe(getBangkokBusinessDate());

    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);
});

describe.sequential("Daily Check-in point reward - TRUE concurrency against other real points writers", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("a real Daily Check-in claim running CONCURRENTLY with a real order points-earn: both succeed, no lost update, final balance is a valid serial order", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const t = requireIntegrationDb();

    // A real order whose totalAmount earns points through the actual
    // production award path (orderService.finalizeOrderCompletion ->
    // awardPointsForOrder, 100 currency units = 1 point). Deliberately no
    // pointsDiscountAmount, so this test's earn side is isolated from redemption.
    const order = await db.createOrder({
      orderNumber: `CONC-EARN-${uniqueSuffix()}`,
      userId: user.id,
      subtotal: "500.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "0.00",
      totalAmount: "500.00", // floor(500/100) = 5 points
    });

    // Two independent operations, started at the same time, each using the
    // ACTUAL production locking path (lockUserForPoints via
    // withUserPointsLock) - not two manually-opened transactions standing in
    // for them.
    const [checkinResult, earnResult] = await Promise.allSettled([
      appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim(),
      orderService.finalizeOrderCompletion(order.id, user.id),
    ]);

    expect(checkinResult.status, "the check-in claim must not fail merely because it raced the order earn").toBe("fulfilled");
    expect(earnResult.status, "the order earn must not fail merely because it raced the check-in claim").toBe("fulfilled");

    // Exactly one check-in, one grant (the Daily Check-in side never doubles).
    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(grants).toHaveLength(1);
    // Two points transactions: one "earn" from Daily Check-in (1.00), one
    // "earn" from the order (5.00) - no lost update means both are present.
    expect(points).toHaveLength(2);
    expect(points.filter((p: any) => p.referenceType === "daily_checkin")).toHaveLength(1);
    expect(points.filter((p: any) => p.referenceType === "order")).toHaveLength(1);

    // Final balance is the full sum - neither write clobbered the other.
    const finalBalance = await db.getUserPointsBalance(user.id);
    expect(finalBalance).toBe("6.00");

    // The lock serialized them: ordered by id (insertion order), each row's
    // balanceAfter is exactly the previous row's balanceAfter plus its own
    // amount - a valid serial chain, whichever writer actually went first.
    const ordered = [...points].sort((a: any, b: any) => a.id - b.id);
    let runningBalance = 0;
    for (const row of ordered) {
      runningBalance += Number(row.amount) * (row.type === "redeem" ? -1 : 1);
      expect(Number(row.balanceAfter)).toBeCloseTo(runningBalance, 2);
    }
    expect(runningBalance).toBeCloseTo(6.0, 2);

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ orderIds: [order.id], userIds: [user.id] });
  }, 40000);

  it("a real Daily Check-in claim running CONCURRENTLY with a real order points-REDEMPTION: no lost credit, no lost redemption, no negative balance", async () => {
    const user = await createTestUser();
    await activatePointModeNow(user.id);
    const t = requireIntegrationDb();

    // Seed an initial balance to redeem from - a plain ledger seed, not part
    // of the concurrent operation under test.
    await db.recordPointsTransaction({
      userId: user.id, type: "earn", amount: "10.00", balanceAfter: "10.00",
      referenceType: "order", referenceId: 0,
    });

    // totalAmount kept under 100 so this order's OWN award step contributes
    // exactly 0 extra points (floor(50/100) = 0) - isolates this test to the
    // redemption side only.
    const order = await db.createOrder({
      orderNumber: `CONC-REDEEM-${uniqueSuffix()}`,
      userId: user.id,
      subtotal: "53.00",
      discountAmount: "0.00",
      pointsDiscountAmount: "3.00",
      totalAmount: "50.00",
    });

    const [checkinResult, redeemResult] = await Promise.allSettled([
      appRouter.createCaller(ctxFor(user.id)).dailyCheckin.claim(),
      orderService.finalizeOrderCompletion(order.id, user.id),
    ]);

    expect(checkinResult.status).toBe("fulfilled");
    expect(redeemResult.status).toBe("fulfilled");

    const { checkins, points, grants } = await rowsFor(user.id);
    expect(checkins).toHaveLength(1);
    expect(grants).toHaveLength(1);

    const allPoints = await t.select().from(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    // Seed (1) + check-in earn (1) + order redeem (1) = 3 rows. No lost write.
    expect(allPoints).toHaveLength(3);
    expect(allPoints.filter((p: any) => p.referenceType === "daily_checkin")).toHaveLength(1);
    expect(allPoints.filter((p: any) => p.type === "redeem")).toHaveLength(1);

    // 10 (seed) + 1.00 (check-in) - 3.00 (redeem) = 8.00 - neither write lost.
    const finalBalance = await db.getUserPointsBalance(user.id);
    expect(finalBalance).toBe("8.00");
    expect(Number(finalBalance)).toBeGreaterThanOrEqual(0);

    // Valid serial chain, in insertion order.
    const ordered = [...allPoints].sort((a: any, b: any) => a.id - b.id);
    let runningBalance = 0;
    for (const row of ordered) {
      runningBalance += Number(row.amount) * (row.type === "redeem" ? -1 : 1);
      expect(Number(row.balanceAfter)).toBeCloseTo(runningBalance, 2);
    }
    expect(runningBalance).toBeCloseTo(8.0, 2);

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ orderIds: [order.id], userIds: [user.id] });
  }, 40000);
});

describe.sequential("Daily Check-in point reward - exact streak calculation (no arbitrary cap)", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  /** Bulk-inserts `count` synthetic consecutive-day check-ins strictly before `mostRecentDateExclusive`. */
  async function insertConsecutiveHistory(userId: number, mostRecentDateExclusive: string, count: number): Promise<void> {
    if (count === 0) return;
    const t = requireIntegrationDb();
    const rows: any[] = [];
    let cursor = getPreviousBangkokBusinessDate(mostRecentDateExclusive);
    for (let i = 0; i < count; i += 1) {
      rows.push({ userId, checkinDate: cursor, campaignKey: "default", couponId: null, status: "issued" as const });
      cursor = getPreviousBangkokBusinessDate(cursor);
    }
    // Chunked inserts - a single 800-row statement is fine on MariaDB/TiDB,
    // but chunking keeps this robust without depending on that.
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await t.insert(dailyCheckins).values(rows.slice(i, i + CHUNK));
    }
  }

  const REFERENCE_DATE = "2026-09-15"; // arbitrary fixed date, unrelated to the live Bangkok date

  it("a first-ever claim (no history) has a streak of 1", async () => {
    const user = await createTestUser();
    const streak = await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE);
    expect(streak).toBe(1);
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("399 prior consecutive days -> streak 400 (crosses the internal 400-row batch boundary from below)", async () => {
    const user = await createTestUser();
    await insertConsecutiveHistory(user.id, REFERENCE_DATE, 399);
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(400);
    await requireIntegrationDb().delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("400 prior consecutive days -> streak 401 (exactly one full batch, requires paging to a second batch)", async () => {
    const user = await createTestUser();
    await insertConsecutiveHistory(user.id, REFERENCE_DATE, 400);
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(401);
    await requireIntegrationDb().delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("401 prior consecutive days -> streak 402 (one full batch plus one row in a second batch)", async () => {
    const user = await createTestUser();
    await insertConsecutiveHistory(user.id, REFERENCE_DATE, 401);
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(402);
    await requireIntegrationDb().delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("800 prior consecutive days -> streak 801 (exactly two full batches, no arbitrary cap at 400)", async () => {
    const user = await createTestUser();
    await insertConsecutiveHistory(user.id, REFERENCE_DATE, 800);
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(801);
    await requireIntegrationDb().delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("a single missing date breaks the streak, even deep in otherwise-consecutive history", async () => {
    const user = await createTestUser();
    const t = requireIntegrationDb();
    // 5 consecutive days immediately before REFERENCE_DATE...
    await insertConsecutiveHistory(user.id, REFERENCE_DATE, 5);
    // ...then a GAP (skip one day)...
    // ...then 3 more days further back (irrelevant - must not be counted).
    const gapCursorStart = getPreviousBangkokBusinessDate(
      [1, 2, 3, 4, 5].reduce((d) => getPreviousBangkokBusinessDate(d), REFERENCE_DATE)
    );
    const beyondGapStart = getPreviousBangkokBusinessDate(gapCursorStart);
    await insertConsecutiveHistory(user.id, getPreviousBangkokBusinessDate(beyondGapStart), 3);

    // Today (REFERENCE_DATE) + the 5 consecutive days = streak of 6, NOT 9.
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(6);
    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("crosses a leap-day boundary correctly (2028-02-29 exists; 2027-02-29 would not)", async () => {
    const user = await createTestUser();
    const t = requireIntegrationDb();
    // 2028 is a leap year - Feb 29 is a real Bangkok business date.
    await t.insert(dailyCheckins).values([
      { userId: user.id, checkinDate: "2028-02-28", campaignKey: "default", couponId: null, status: "issued" as const },
      { userId: user.id, checkinDate: "2028-02-29", campaignKey: "default", couponId: null, status: "issued" as const },
    ]);
    // Claim on 2028-03-01: streak should be 3 (03-01, 02-29, 02-28), proving
    // getPreviousBangkokBusinessDate("2028-03-01") correctly lands on
    // "2028-02-29", not "2028-02-28" (which would silently skip the leap day).
    expect(await db.calculateDailyCheckinStreak(user.id, "2028-03-01")).toBe(3);
    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("counts BOTH legacy coupon check-ins and point check-ins toward the same streak", async () => {
    const user = await createTestUser();
    const t = requireIntegrationDb();
    const [couponResult]: any = await (await db.getDb())!.insert(coupons).values({
      code: `STREAKMIX${uniqueSuffix()}`,
      discountType: "percentage",
      discountValue: "5.00",
      minPurchaseAmount: "0.00",
      usageCount: 0,
      isActive: true,
    });
    const couponId = couponResult.insertId;

    await t.insert(dailyCheckins).values([
      // Yesterday: a LEGACY coupon check-in (couponId set).
      { userId: user.id, checkinDate: getPreviousBangkokBusinessDate(REFERENCE_DATE), campaignKey: "default", couponId, status: "issued" as const },
    ]);
    // Day before yesterday: a POINT check-in (couponId null).
    await insertConsecutiveHistory(user.id, getPreviousBangkokBusinessDate(REFERENCE_DATE), 1);

    // Today + legacy + point = streak of 3.
    expect(await db.calculateDailyCheckinStreak(user.id, REFERENCE_DATE)).toBe(3);

    await t.delete(dailyCheckins).where(eq(dailyCheckins.userId, user.id));
    await t.delete(coupons).where(eq(coupons.id, couponId));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);
});

describe.sequential("Daily Check-in point reward - safe-stop under configuration drift (never resumes coupons once grants exist)", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  /** Creates a real point grant for `admin`, returning the campaign row it was created under. */
  async function createRealPointGrant(adminId: number) {
    await activatePointModeNow(adminId);
    const result: any = await appRouter.createCaller(ctxFor(adminId)).dailyCheckin.claim();
    expect(result.claimed).toBe(true);
    const campaign = await dailyCheckinRewardModeService.loadDailyCheckinCampaign();
    expect(campaign).toBeTruthy();
    return campaign!;
  }

  /** Attempts a claim for a brand-new, unrelated user and returns the full picture of what happened. */
  async function attemptFreshClaim() {
    const before = await getTestDb().select().from(coupons);
    const freshUser = await createTestUser();
    let claimError: any;
    let result: any;
    try {
      result = await appRouter.createCaller(ctxFor(freshUser.id)).dailyCheckin.claim();
    } catch (error: any) {
      claimError = error;
    }
    const after = await getTestDb().select().from(coupons);
    return { freshUser, result, claimError, newCouponCount: after.length - before.length };
  }

  it("drift 1: the campaign row is unexpectedly missing after grants exist -> disabled, no coupon minted", async () => {
    const admin = await createTestUser({ role: "admin" });
    const campaign = await createRealPointGrant(admin.id);
    const t = requireIntegrationDb();

    // Simulate the campaign row vanishing (corruption/manual tampering) -
    // NOT via the app's own cancel path, which already refuses this while
    // grants exist. dailyCheckinRewardGrants.campaignId is left pointing at
    // a now-nonexistent row on purpose, to prove the guard does not depend
    // on the campaign row still being readable.
    await t.delete(dailyCheckinRewardRules).where(eq(dailyCheckinRewardRules.campaignId, campaign.id));
    await t.delete(dailyCheckinCampaigns).where(eq(dailyCheckinCampaigns.id, campaign.id));

    const { freshUser, result, claimError, newCouponCount } = await attemptFreshClaim();

    expect(claimError, "claim must not throw - it must return a controlled disabled response").toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(result.campaignActive).toBe(false);
    expect(result.rewardMode).toBe("disabled");
    expect(newCouponCount).toBe(0);

    const { checkins, points, grants } = await rowsFor(freshUser.id);
    expect(checkins).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect(grants).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id, freshUser.id] });
  }, 40000);

  it("drift 2: campaign startDate is moved into the future after grants exist -> disabled, no coupon minted", async () => {
    const admin = await createTestUser({ role: "admin" });
    const campaign = await createRealPointGrant(admin.id);
    const t = requireIntegrationDb();

    const futureDate = addBangkokDays(getBangkokBusinessDate(), 10);
    await t.update(dailyCheckinCampaigns).set({ startDate: futureDate }).where(eq(dailyCheckinCampaigns.id, campaign.id));

    const { freshUser, result, claimError, newCouponCount } = await attemptFreshClaim();

    expect(claimError).toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(result.rewardMode).toBe("disabled");
    expect(newCouponCount).toBe(0);
    const { checkins, points, grants } = await rowsFor(freshUser.id);
    expect(checkins).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect(grants).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id, freshUser.id] });
  }, 40000);

  it("drift 3: campaign status is reverted to draft after grants exist -> disabled, no coupon minted", async () => {
    const admin = await createTestUser({ role: "admin" });
    const campaign = await createRealPointGrant(admin.id);
    const t = requireIntegrationDb();

    await t.update(dailyCheckinCampaigns).set({ status: "draft" }).where(eq(dailyCheckinCampaigns.id, campaign.id));

    const { freshUser, result, claimError, newCouponCount } = await attemptFreshClaim();

    expect(claimError).toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(result.rewardMode).toBe("disabled");
    expect(newCouponCount).toBe(0);
    const { checkins, points, grants } = await rowsFor(freshUser.id);
    expect(checkins).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect(grants).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id, freshUser.id] });
  }, 40000);

  it("drift 4: the daily point rule is deleted after grants exist -> disabled, no coupon minted", async () => {
    const admin = await createTestUser({ role: "admin" });
    const campaign = await createRealPointGrant(admin.id);
    const t = requireIntegrationDb();

    await t.delete(dailyCheckinRewardRules).where(eq(dailyCheckinRewardRules.campaignId, campaign.id));

    const { freshUser, result, claimError, newCouponCount } = await attemptFreshClaim();

    expect(claimError).toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(result.rewardMode).toBe("disabled");
    expect(newCouponCount).toBe(0);
    const { checkins, points, grants } = await rowsFor(freshUser.id);
    expect(checkins).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect(grants).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id, freshUser.id] });
  }, 40000);

  it("drift 5: the daily point rule's pointsAmount is corrupted after grants exist -> disabled, no coupon minted", async () => {
    const admin = await createTestUser({ role: "admin" });
    const campaign = await createRealPointGrant(admin.id);
    const t = requireIntegrationDb();

    await t
      .update(dailyCheckinRewardRules)
      .set({ pointsAmount: "2.00" })
      .where(eq(dailyCheckinRewardRules.campaignId, campaign.id));

    const { freshUser, result, claimError, newCouponCount } = await attemptFreshClaim();

    expect(claimError).toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(result.rewardMode).toBe("disabled");
    expect(newCouponCount).toBe(0);
    const { checkins, points, grants } = await rowsFor(freshUser.id);
    expect(checkins).toHaveLength(0);
    expect(points).toHaveLength(0);
    expect(grants).toHaveLength(0);

    await deleteFixtures({ userIds: [admin.id, freshUser.id] });
  }, 40000);
});

describe.sequential("Admin rollout - error sanitization", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("an unexpected wrapped Drizzle/MySQL error is never forwarded to the client - only the fixed generic message survives", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const startDate = addBangkokDays(getBangkokBusinessDate(), 6);

    // A real campaign, so the schedule calls below reach the service's real
    // logic before hitting the simulated failure.
    await caller.admin.dailyCheckinRollout.schedule({ startDate });

    const rawDriverError = new Error(
      "Failed query: select `id` from `dailyCheckinRewardGrants` where `campaignId` = ? \nparams: 42"
    );
    // Mocking countDailyCheckinPointGrants directly would not work here:
    // scheduleDailyCheckinPointRollout calls it as a same-file sibling
    // function, and under this project's ESM/vite-node transform,
    // vi.spyOn() on an imported namespace only intercepts calls made FROM
    // OUTSIDE that module - a same-module self-reference bypasses the
    // exports object entirely (verified empirically). getDb() is imported
    // by dailyCheckinRewardModeService.ts from server/db.ts, a genuine
    // cross-module call, so spying on it here reliably intercepts and
    // simulates "some unexpected raw driver failure occurred deep inside
    // this service call" without caring exactly where in the chain it
    // surfaced - the router's job is to sanitize ANY non-DailyCheckinRolloutError,
    // not just ones from one specific query.
    const spy = vi.spyOn(db, "getDb").mockRejectedValueOnce(rawDriverError);

    let caught: any;
    try {
      await caller.admin.dailyCheckinRollout.schedule({ startDate });
    } catch (error: any) {
      caught = error;
    }
    spy.mockRestore();

    expect(caught).toBeDefined();
    expect(caught.code).toBe("INTERNAL_SERVER_ERROR");
    // The router itself must never forward the raw message in any form.
    expect(String(caught.message ?? "")).not.toMatch(/Failed query/i);
    expect(String(caught.message ?? "")).not.toMatch(/params\s*:/i);
    expect(String(caught.message ?? "")).not.toMatch(/dailyCheckinRewardGrants|campaignId/i);

    // errorFormatter only runs inside the real HTTP adapter, never for a
    // direct createCaller() invocation - simulate what it does to this exact
    // shape to prove the true client-visible result end-to-end.
    const shape = { message: caught.message, data: {} };
    const sanitized = sanitizeTrpcErrorShape(shape, { code: caught.code });
    expect(sanitized.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    expect(sanitized.message).not.toMatch(/Failed query|params\s*:|dailyCheckinRewardGrants|campaignId/i);

    await cancelDailyCheckinPointRollout();
    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);
});

describe.sequential("Admin rollout - schedule concurrency", () => {
  beforeEach(async () => {
    await resetCheckinState();
  });

  it("two SIMULTANEOUS schedule requests for the SAME future date: both resolve safely, exactly one campaign, exactly one rule, no raw duplicate-key error", async () => {
    const admin = await createTestUser({ role: "admin" });
    const t = requireIntegrationDb();
    const startDate = addBangkokDays(getBangkokBusinessDate(), 7);
    const callerA = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const callerB = appRouter.createCaller(ctxFor(admin.id, "admin"));

    const settled = await Promise.allSettled([
      callerA.admin.dailyCheckinRollout.schedule({ startDate }),
      callerB.admin.dailyCheckinRollout.schedule({ startDate }),
    ]);

    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(
      rejected.map((r) => `${r.reason?.code}: ${r.reason?.message}`),
      "same-date concurrent scheduling must never surface a raw duplicate-key error"
    ).toEqual([]);

    const campaigns = await t.select().from(dailyCheckinCampaigns);
    const rules = await t.select().from(dailyCheckinRewardRules);
    expect(campaigns).toHaveLength(1);
    expect(rules).toHaveLength(1);
    expect(campaigns[0].startDate).toBe(startDate);

    await cancelDailyCheckinPointRollout();
    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);

  it("two SIMULTANEOUS schedule requests for DIFFERENT future dates: one accepted, one controlled conflict, exactly one campaign and one rule", async () => {
    const admin = await createTestUser({ role: "admin" });
    const t = requireIntegrationDb();
    const today = getBangkokBusinessDate();
    const dateA = addBangkokDays(today, 8);
    const dateB = addBangkokDays(today, 9);
    const callerA = appRouter.createCaller(ctxFor(admin.id, "admin"));
    const callerB = appRouter.createCaller(ctxFor(admin.id, "admin"));

    const settled = await Promise.allSettled([
      callerA.admin.dailyCheckinRollout.schedule({ startDate: dateA }),
      callerB.admin.dailyCheckinRollout.schedule({ startDate: dateB }),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A controlled BAD_REQUEST conflict, never a raw driver error.
    expect(rejected[0].reason?.code).toBe("BAD_REQUEST");
    expect(String(rejected[0].reason?.message ?? "")).toMatch(/already scheduled/i);

    const campaigns = await t.select().from(dailyCheckinCampaigns);
    const rules = await t.select().from(dailyCheckinRewardRules);
    expect(campaigns).toHaveLength(1);
    expect(rules).toHaveLength(1);
    expect([dateA, dateB]).toContain(campaigns[0].startDate);

    await cancelDailyCheckinPointRollout();
    await deleteFixtures({ userIds: [admin.id] });
  }, 40000);
});

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
}
