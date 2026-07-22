// Decides which Daily Check-in reward the server will hand out RIGHT NOW:
// the legacy coupon, exactly 1.00 point, or nothing at all.
//
// Two separate configuration sources, deliberately kept apart:
//
//   settings["daily_checkin_campaign"] (legacy JSON)
//       -> the GLOBAL kill switch (isActive) plus the legacy coupon's
//          discount settings. It intentionally carries NO point
//          configuration - see resolveDailyCheckinRuntimeMode below.
//
//   dailyCheckinCampaigns + dailyCheckinRewardRules (relational)
//       -> the single source of truth for the point reward, including its
//          amount and the Bangkok date it starts on.
//
// Keeping the point amount out of the JSON blob is what makes "deployment
// alone must not activate the point reward mid-day" true: shipping this code
// changes nothing until a campaign row exists AND its Bangkok start date has
// arrived.
import { and, eq } from "drizzle-orm";
import { dailyCheckinCampaigns, dailyCheckinRewardRules, dailyCheckinRewardGrants } from "../../drizzle/schema";
import { getDb } from "../db";
import { getBangkokBusinessDate } from "../_core/timezone";
import { getEffectiveDailyCheckinConfig } from "../_core/dailyCheckinConfig";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";

/** The campaignKey every Daily Check-in row - legacy and point - uses. */
export const DAILY_CHECKIN_CAMPAIGN_KEY = "default";

/** The dedupeKey of the one daily point rule. Server-generated, never client input. */
export const DAILY_POINTS_DEDUPE_KEY = "daily:points";

/** The fixed reward for this rollout. Not configurable by admins or clients. */
export const DAILY_CHECKIN_POINTS_AMOUNT = "1.00";

/**
 * A deliberate, known-safe validation/business error from the rollout admin
 * flow (bad startDate, conflicting schedule, grants already exist, etc.).
 * Its `.message` was written by this module for an admin to read and is
 * always safe to return to the client verbatim.
 *
 * This is the allowlist half of defense-in-depth for admin errors: the
 * router (server/routers.ts admin.dailyCheckinRollout.*) only ever forwards
 * a caught error's `.message` to the client when it is an INSTANCE of this
 * class. Anything else - a raw driver exception, a programming error, an
 * unexpected null-dereference - is logged via safeErrorSummary() and
 * answered with the fixed generic message instead. This does not replace
 * the existing global tRPC formatter's blocklist-based detection
 * (sanitizeTrpcErrorShape/looksLikeRawDatabaseError in server/_core/trpc.ts)
 * - it is a second, independent, allowlist-based layer in front of it.
 */
export class DailyCheckinRolloutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyCheckinRolloutError";
  }
}

export interface DailyCheckinCampaignRow {
  id: number;
  campaignKey: string;
  name: string;
  timezone: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface DailyCheckinRewardRuleRow {
  id: number;
  campaignId: number;
  ruleType: string;
  rewardKind: string;
  pointsAmount: string | null;
  dedupeKey: string;
  isActive: boolean;
}

export type DailyCheckinRuntimeMode =
  | {
      mode: "legacy_coupon";
      reason: "no_relational_campaign" | "before_scheduled_start";
      businessDate: string;
      scheduledStartDate?: string;
    }
  | {
      mode: "points";
      businessDate: string;
      campaign: DailyCheckinCampaignRow;
      rule: DailyCheckinRewardRuleRow;
      pointsAmount: string;
    }
  | {
      mode: "disabled";
      reason: string;
      businessDate: string;
    };

/**
 * Plain "YYYY-MM-DD" lexicographic comparison. Safe precisely because both
 * sides are already Bangkok business dates in a zero-padded, fixed-width
 * format - no Date parsing, no process-local timezone, no DST math.
 */
function isOnOrAfter(date: string, boundary: string): boolean {
  return date >= boundary;
}

function isOnOrBefore(date: string, boundary: string): boolean {
  return date <= boundary;
}

/** A strict "YYYY-MM-DD" that is also a real calendar date (rejects 2026-02-30). */
export function isValidBangkokDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Round-trip through UTC (not local time) so the check is independent of
  // the server's own timezone.
  const asUtc = new Date(Date.UTC(y, m - 1, d));
  return (
    asUtc.getUTCFullYear() === y && asUtc.getUTCMonth() === m - 1 && asUtc.getUTCDate() === d
  );
}

/**
 * Loads the one campaign that owns the Daily Check-in campaignKey, if any.
 * Exactly one row can exist - dailyCheckinCampaigns.campaignKey is UNIQUE -
 * so "ambiguous configuration" is impossible at this level by construction.
 */
async function loadCampaign(database: any): Promise<DailyCheckinCampaignRow | null> {
  const rows = await database
    .select()
    .from(dailyCheckinCampaigns)
    .where(eq(dailyCheckinCampaigns.campaignKey, DAILY_CHECKIN_CAMPAIGN_KEY))
    .limit(1);
  return rows.length > 0 ? (rows[0] as DailyCheckinCampaignRow) : null;
}

/**
 * Loads the active daily point rule for a campaign. The
 * UNIQUE(campaignId, dedupeKey) index means at most one row can match, so
 * this cannot silently pick between competing rules.
 */
async function loadDailyPointsRule(
  database: any,
  campaignId: number
): Promise<DailyCheckinRewardRuleRow | null> {
  const rows = await database
    .select()
    .from(dailyCheckinRewardRules)
    .where(
      and(
        eq(dailyCheckinRewardRules.campaignId, campaignId),
        eq(dailyCheckinRewardRules.dedupeKey, DAILY_POINTS_DEDUPE_KEY)
      )
    )
    .limit(1);
  return rows.length > 0 ? (rows[0] as DailyCheckinRewardRuleRow) : null;
}

export async function loadDailyCheckinCampaign(tx?: any): Promise<DailyCheckinCampaignRow | null> {
  const database = tx || (await getDb());
  if (!database) return null;
  return loadCampaign(database);
}

export async function loadDailyCheckinPointsRule(
  campaignId: number,
  tx?: any
): Promise<DailyCheckinRewardRuleRow | null> {
  const database = tx || (await getDb());
  if (!database) return null;
  return loadDailyPointsRule(database, campaignId);
}

/**
 * Stable reason returned instead of "legacy_coupon" whenever the relational
 * configuration looks like it would otherwise fall back to coupon issuance,
 * but Daily Check-in point grants already exist somewhere in history. Used
 * uniformly across every drift scenario below so callers/logs/tests can
 * match on one constant rather than several ad hoc strings.
 */
export const POINT_HISTORY_SAFE_STOP_REASON = "point_history_requires_safe_stop";

/**
 * True if ANY Daily Check-in point grant has ever been issued, regardless of
 * which campaign (if any) currently exists. Deliberately not scoped to a
 * specific campaignId: this is the guard for the case where the campaign
 * row itself is unexpectedly missing, so there may be no campaign.id left to
 * scope by. countDailyCheckinPointGrants (below) is used instead whenever a
 * concrete campaign row IS available, since scoping to it is more precise.
 */
async function anyDailyCheckinPointGrantsExist(tx?: any): Promise<boolean> {
  const database = tx || (await getDb());
  if (!database) return false;
  const rows = await database
    .select({ id: dailyCheckinRewardGrants.id })
    .from(dailyCheckinRewardGrants)
    .where(eq(dailyCheckinRewardGrants.rewardKind, "points"))
    .limit(1);
  return rows.length > 0;
}

/**
 * The runtime decision. Resolution order, and why each branch exists:
 *
 *  1. Global kill switch off            -> "disabled". Covers BOTH modes; a
 *     disabled campaign never issues a coupon and never grants a point.
 *  2. No relational campaign row        -> "legacy_coupon", UNLESS point
 *     grants already exist somewhere (the campaign row went missing after
 *     the fact) - then "disabled". This is today's production state absent
 *     any grant history, so shipping this code alone changes nothing.
 *  3. Campaign exists, start date is in
 *     the future (Bangkok), or status
 *     is "draft"                        -> "legacy_coupon", UNLESS point
 *     grants already exist FOR THIS CAMPAIGN (its startDate was pushed back
 *     out, or its status was reverted to draft, after grants were already
 *     issued) - then "disabled". The rollout is scheduled but has not begun;
 *     coupons continue until midnight Bangkok on startDate, with no
 *     redeploy needed to flip over.
 *  4. Campaign ended / not active /
 *     missing or malformed rule         -> "disabled", NOT a silent fall
 *     back to coupons. Once point grants may exist, quietly resuming coupon
 *     issuance would be a second reward model running behind the operator's
 *     back; stopping is the safe failure.
 *  5. Otherwise                         -> "points".
 *
 * Every path that would otherwise return "legacy_coupon" is therefore
 * guarded by a grant-existence check first - a coupon is never minted once
 * any point has been granted, no matter how the relational configuration
 * drifted to look like the pre-rollout state again.
 *
 * `at` exists only so tests can pin an instant. It is never derived from
 * client input - the tRPC layer does not accept a date.
 */
export async function resolveDailyCheckinRuntimeMode(at: Date = new Date()): Promise<DailyCheckinRuntimeMode> {
  const businessDate = getBangkokBusinessDate(at);

  const config = await getEffectiveDailyCheckinConfig();
  if (!config.isActive) {
    return { mode: "disabled", reason: "kill_switch_off", businessDate };
  }

  const database = await getDb();
  if (!database) {
    // No database means no campaign - and no grant history - can be read;
    // the legacy path is the historical default and will fail loudly on its
    // own if it needs a DB.
    return { mode: "legacy_coupon", reason: "no_relational_campaign", businessDate };
  }

  const campaign = await loadCampaign(database);
  if (!campaign) {
    if (await anyDailyCheckinPointGrantsExist(database)) {
      console.error(
        "[dailyCheckinRewardMode] no relational campaign row found, but Daily Check-in point grants already exist - refusing to fall back to coupon issuance"
      );
      return { mode: "disabled", reason: POINT_HISTORY_SAFE_STOP_REASON, businessDate };
    }
    return { mode: "legacy_coupon", reason: "no_relational_campaign", businessDate };
  }

  if (campaign.status === "draft") {
    if ((await countDailyCheckinPointGrants(campaign.id, database)) > 0) {
      console.error(
        `[dailyCheckinRewardMode] campaign ${campaign.id} is draft but already has point grants - refusing to fall back to coupon issuance`
      );
      return { mode: "disabled", reason: POINT_HISTORY_SAFE_STOP_REASON, businessDate };
    }
    return { mode: "legacy_coupon", reason: "before_scheduled_start", businessDate, scheduledStartDate: campaign.startDate };
  }

  if (campaign.status !== "active") {
    // "ended" (or anything unexpected) - do not resume coupon issuance.
    return { mode: "disabled", reason: `campaign_status_${campaign.status}`, businessDate };
  }

  if (!isValidBangkokDateString(campaign.startDate) || !isValidBangkokDateString(campaign.endDate)) {
    return { mode: "disabled", reason: "campaign_date_range_malformed", businessDate };
  }

  if (!isOnOrAfter(businessDate, campaign.startDate)) {
    if ((await countDailyCheckinPointGrants(campaign.id, database)) > 0) {
      console.error(
        `[dailyCheckinRewardMode] campaign ${campaign.id} startDate moved into the future but already has point grants - refusing to fall back to coupon issuance`
      );
      return { mode: "disabled", reason: POINT_HISTORY_SAFE_STOP_REASON, businessDate };
    }
    return {
      mode: "legacy_coupon",
      reason: "before_scheduled_start",
      businessDate,
      scheduledStartDate: campaign.startDate,
    };
  }

  if (!isOnOrBefore(businessDate, campaign.endDate)) {
    return { mode: "disabled", reason: "campaign_window_ended", businessDate };
  }

  const rule = await loadDailyPointsRule(database, campaign.id);
  if (!rule) {
    console.error(
      `[dailyCheckinRewardMode] campaign ${campaign.id} is active but has no "${DAILY_POINTS_DEDUPE_KEY}" rule - disabling claims`
    );
    return { mode: "disabled", reason: "missing_daily_points_rule", businessDate };
  }

  if (!rule.isActive) {
    return { mode: "disabled", reason: "daily_points_rule_inactive", businessDate };
  }

  if (rule.ruleType !== "daily" || rule.rewardKind !== "points") {
    console.error(
      `[dailyCheckinRewardMode] rule ${rule.id} has unexpected ruleType/rewardKind - disabling claims`
    );
    return { mode: "disabled", reason: "daily_points_rule_malformed", businessDate };
  }

  // This rollout is fixed at exactly 1.00 point. A rule that says anything
  // else is a configuration error, not a licence to pay out a different
  // amount.
  if (String(rule.pointsAmount) !== DAILY_CHECKIN_POINTS_AMOUNT) {
    console.error(
      `[dailyCheckinRewardMode] rule ${rule.id} pointsAmount is not the fixed ${DAILY_CHECKIN_POINTS_AMOUNT} - disabling claims`
    );
    return { mode: "disabled", reason: "daily_points_rule_amount_unexpected", businessDate };
  }

  return {
    mode: "points",
    businessDate,
    campaign,
    rule,
    pointsAmount: DAILY_CHECKIN_POINTS_AMOUNT,
  };
}

// ---------------------------------------------------------------------------
// Rollout administration
//
// Deliberately minimal: schedule the fixed 1-point rollout for a future
// Bangkok date, read its status, or cancel it before it starts. This is NOT a
// campaign-management system - the point amount, ruleType, rewardKind,
// campaignKey and dedupeKey are all server-fixed constants and none of them
// can be supplied by a caller.
// ---------------------------------------------------------------------------

export interface DailyCheckinRolloutStatus {
  currentBangkokDate: string;
  runtimeMode: DailyCheckinRuntimeMode["mode"];
  runtimeReason: string | null;
  scheduledStartDate: string | null;
  campaignStatus: string | null;
  hasPointGrants: boolean;
  pointsAmount: string;
  killSwitchActive: boolean;
}

/** Number of point grants already issued for the Daily Check-in campaign. */
export async function countDailyCheckinPointGrants(campaignId: number, tx?: any): Promise<number> {
  const database = tx || (await getDb());
  if (!database) return 0;
  const rows = await database
    .select({ id: dailyCheckinRewardGrants.id })
    .from(dailyCheckinRewardGrants)
    .where(eq(dailyCheckinRewardGrants.campaignId, campaignId))
    .limit(1);
  return rows.length;
}

export async function getDailyCheckinRolloutStatus(): Promise<DailyCheckinRolloutStatus> {
  const runtime = await resolveDailyCheckinRuntimeMode();
  const config = await getEffectiveDailyCheckinConfig();
  const campaign = await loadDailyCheckinCampaign();

  return {
    currentBangkokDate: runtime.businessDate,
    runtimeMode: runtime.mode,
    runtimeReason: "reason" in runtime ? runtime.reason : null,
    scheduledStartDate: campaign?.startDate ?? null,
    campaignStatus: campaign?.status ?? null,
    hasPointGrants: campaign ? (await countDailyCheckinPointGrants(campaign.id)) > 0 : false,
    pointsAmount: DAILY_CHECKIN_POINTS_AMOUNT,
    killSwitchActive: config.isActive,
  };
}

/**
 * Schedules the fixed 1-point rollout to begin at Bangkok midnight on
 * `startDate`. Idempotent: re-scheduling the same date is a no-op success.
 *
 * Everything except the date is server-fixed. `startDate` must be strictly
 * later than the current Bangkok business date, which is what guarantees a
 * deploy can never flip the reward mid-day - the campaign only becomes
 * effective when Bangkok crosses midnight into it, with no further deploy.
 */
export async function scheduleDailyCheckinPointRollout(
  startDate: string,
  createdBy?: number
): Promise<{ scheduled: boolean; alreadyScheduled: boolean; startDate: string }> {
  if (!isValidBangkokDateString(startDate)) {
    throw new DailyCheckinRolloutError("startDate must be a real calendar date in YYYY-MM-DD form");
  }

  const today = getBangkokBusinessDate();
  if (startDate <= today) {
    throw new DailyCheckinRolloutError("startDate must be strictly later than the current Bangkok date");
  }

  const database = await getDb();
  if (!database) throw new Error("Database not available");

  try {
    return await database.transaction(async (tx: any) => {
      const existing = await loadCampaign(tx);

      if (existing) {
        const grants = await countDailyCheckinPointGrants(existing.id, tx);
        if (grants > 0) {
          throw new DailyCheckinRolloutError("Point rewards have already been granted - this rollout cannot be rescheduled");
        }
        if (existing.startDate === startDate) {
          // Idempotent re-run: make sure the rule exists, then report success.
          await ensureDailyPointsRule(existing.id, tx);
          return { scheduled: false, alreadyScheduled: true, startDate };
        }
        throw new DailyCheckinRolloutError(
          `A Daily Check-in campaign is already scheduled for ${existing.startDate}; cancel it before scheduling a different date`
        );
      }

      const inserted = await tx.insert(dailyCheckinCampaigns).values({
        campaignKey: DAILY_CHECKIN_CAMPAIGN_KEY,
        name: "Daily Check-in - 1 Point",
        description: "Grants exactly 1.00 point per successful Bangkok business-day check-in.",
        timezone: "Asia/Bangkok",
        startDate,
        endDate: "2099-12-31",
        status: "active",
        createdBy: createdBy ?? null,
      });
      const campaignId = extractInsertIdLocal(inserted);

      await ensureDailyPointsRule(campaignId, tx);
      return { scheduled: true, alreadyScheduled: false, startDate };
    });
  } catch (error) {
    if (error instanceof DailyCheckinRolloutError) throw error;

    // Concurrent schedule race: two callers can both see "no campaign yet"
    // and both attempt the insert - dailyCheckinCampaigns.campaignKey is
    // UNIQUE, so exactly one wins and the other lands here. Recovered the
    // same way the Daily Check-in claim race is: never surface the raw
    // driver error, re-read the winner (on a fresh connection - the failed
    // transaction above has already rolled back), and answer
    // deterministically from ITS row rather than throwing.
    if (isDuplicateKeyError(error)) {
      const winner = await loadDailyCheckinCampaign();
      if (winner) {
        if (winner.startDate === startDate) {
          await ensureDailyPointsRule(winner.id);
          return { scheduled: false, alreadyScheduled: true, startDate };
        }
        throw new DailyCheckinRolloutError(
          `A Daily Check-in campaign is already scheduled for ${winner.startDate}; cancel it before scheduling a different date`
        );
      }
    }
    throw error;
  }
}

async function ensureDailyPointsRule(campaignId: number, tx?: any): Promise<void> {
  const database = tx || (await getDb());
  if (!database) throw new Error("Database not available");
  const existing = await loadDailyPointsRule(database, campaignId);
  if (existing) return;
  try {
    await database.insert(dailyCheckinRewardRules).values({
      campaignId,
      ruleType: "daily",
      rewardKind: "points",
      milestoneDay: null,
      repeatEvery: null,
      pointsAmount: DAILY_CHECKIN_POINTS_AMOUNT,
      couponTemplateId: null,
      // Server-generated, never accepted from input.
      dedupeKey: DAILY_POINTS_DEDUPE_KEY,
      isActive: true,
      sortOrder: 0,
    });
  } catch (error) {
    // UNIQUE(campaignId, dedupeKey) race: another concurrent caller already
    // created this exact rule between the read above and this insert - that
    // is success, not a failure, so swallow only a genuine duplicate-key
    // error and let anything else propagate.
    if (!isDuplicateKeyError(error)) throw error;
  }
}

/**
 * Cancels a scheduled-but-not-started rollout. Refuses once the start date
 * has arrived or any grant exists - historical rewards and ledger rows are
 * never deleted. After the rollout has started, stopping new claims is the
 * global kill switch's job, not this function's.
 */
export async function cancelDailyCheckinPointRollout(): Promise<{ cancelled: boolean; reason?: string }> {
  const database = await getDb();
  if (!database) throw new Error("Database not available");

  const today = getBangkokBusinessDate();

  return database.transaction(async (tx: any) => {
    const campaign = await loadCampaign(tx);
    if (!campaign) return { cancelled: false, reason: "no_scheduled_campaign" };

    const grants = await countDailyCheckinPointGrants(campaign.id, tx);
    if (grants > 0) {
      throw new DailyCheckinRolloutError("Point rewards have already been granted - use the kill switch instead of cancelling");
    }
    if (today >= campaign.startDate) {
      throw new DailyCheckinRolloutError("The rollout has already started - use the kill switch instead of cancelling");
    }

    // Safe: no grants exist, so nothing historical is being destroyed.
    await tx.delete(dailyCheckinRewardRules).where(eq(dailyCheckinRewardRules.campaignId, campaign.id));
    await tx.delete(dailyCheckinCampaigns).where(eq(dailyCheckinCampaigns.id, campaign.id));
    return { cancelled: true };
  });
}

function extractInsertIdLocal(result: any): number {
  let id: number | undefined;
  if (typeof result === "object" && result !== null) {
    id = result.insertId;
    if (!id && Array.isArray(result) && result[0]) id = result[0].insertId;
    if (!id && result.meta) id = result.meta.insertId;
  }
  if (!id) throw new Error("Failed to extract inserted campaign ID");
  return id;
}
