import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";
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
import {
  scheduleDailyCheckinPointRollout,
  cancelDailyCheckinPointRollout,
  getDailyCheckinRolloutStatus,
} from "./services/dailyCheckinRewardModeService";
import { getBangkokBusinessDate, getPreviousBangkokBusinessDate } from "./_core/timezone";
import { saveDailyCheckinCampaignConfig } from "./_core/dailyCheckinConfig";

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
  const t = requireIntegrationDb();
  await t.execute(sql`DELETE FROM dailyCheckinRewardGrants`);
  await t.execute(sql`DELETE FROM dailyCheckinRewardRules`);
  await t.execute(sql`DELETE FROM dailyCheckinCampaigns`);
  await t.execute(sql`DELETE FROM dailyCheckins`);
  await t.execute(sql`DELETE FROM pointsTransactions`);
  await saveDailyCheckinCampaignConfig({ isActive: true });
}

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
    expect(result.rewards[0].balanceAfter).toBe("1.00");

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

    expect(result.rewards[0].balanceAfter).toBe("6.00");
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
