import { eq } from "drizzle-orm";
import { settings } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * Daily check-in campaign settings, admin-configurable at runtime.
 * Mirrors server/_core/ocr-effective-config.ts's shape (typed interface +
 * one JSON blob under one settings key + safe defaults) - reuses the
 * existing generic settings table/admin.settings.* procedures instead of
 * inventing a new config storage mechanism. See
 * docs/DAILY_CHECKIN_COUPON.md PART H.
 */
export interface DailyCheckinCampaignConfig {
  /** Kill switch. false = claimDailyCheckin rejects all new claims;
   *  already-issued coupons are unaffected. */
  isActive: boolean;
  /** Percentage discount on the issued coupon, e.g. 5 = 5%. */
  rewardPercent: number;
  /** Max discount amount in currency units (the coupon's cap). */
  maxDiscountAmount: number;
  /** Minimum order subtotal required to use the coupon. */
  minPurchaseAmount: number;
  /** Days from issuance until the coupon expires. */
  validityDays: number;
}

export const DEFAULT_DAILY_CHECKIN_CONFIG: DailyCheckinCampaignConfig = {
  isActive: true,
  rewardPercent: 5,
  maxDiscountAmount: 10,
  minPurchaseAmount: 50,
  validityDays: 7,
};

const DAILY_CHECKIN_CONFIG_DB_KEY = "daily_checkin_campaign";

export function validateDailyCheckinCampaignConfig(
  config: Partial<DailyCheckinCampaignConfig>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.isActive !== undefined && typeof config.isActive !== "boolean") {
    errors.push("isActive must be a boolean");
  }
  if (config.rewardPercent !== undefined) {
    if (!Number.isFinite(config.rewardPercent) || config.rewardPercent <= 0 || config.rewardPercent > 100) {
      errors.push("rewardPercent must be a number between 0 (exclusive) and 100");
    }
  }
  if (config.maxDiscountAmount !== undefined) {
    if (!Number.isFinite(config.maxDiscountAmount) || config.maxDiscountAmount <= 0) {
      errors.push("maxDiscountAmount must be a positive number");
    }
  }
  if (config.minPurchaseAmount !== undefined) {
    if (!Number.isFinite(config.minPurchaseAmount) || config.minPurchaseAmount < 0) {
      errors.push("minPurchaseAmount must be a non-negative number");
    }
  }
  if (config.validityDays !== undefined) {
    if (!Number.isInteger(config.validityDays) || config.validityDays <= 0 || config.validityDays > 365) {
      errors.push("validityDays must be an integer between 1 and 365");
    }
  }

  return { valid: errors.length === 0, errors };
}

async function getDailyCheckinConfigFromDatabase(): Promise<Partial<DailyCheckinCampaignConfig> | null> {
  try {
    const db = await getDb();
    if (!db) return null;

    const result = await db.select().from(settings).where(eq(settings.key, DAILY_CHECKIN_CONFIG_DB_KEY)).limit(1);
    if (result.length === 0 || !result[0].value) return null;

    return JSON.parse(result[0].value) as Partial<DailyCheckinCampaignConfig>;
  } catch (error) {
    console.error("[DailyCheckinConfig] Failed to read database settings:", error);
    return null;
  }
}

export async function saveDailyCheckinCampaignConfig(
  newConfig: Partial<DailyCheckinCampaignConfig>
): Promise<{ success: boolean; errors?: string[] }> {
  const validation = validateDailyCheckinCampaignConfig(newConfig);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const current = (await getDailyCheckinConfigFromDatabase()) || {};
  const merged: DailyCheckinCampaignConfig = {
    ...DEFAULT_DAILY_CHECKIN_CONFIG,
    ...current,
    ...newConfig,
  };

  const db = await getDb();
  if (!db) return { success: false, errors: ["Database not available"] };

  const value = JSON.stringify(merged);
  const existing = await db.select().from(settings).where(eq(settings.key, DAILY_CHECKIN_CONFIG_DB_KEY)).limit(1);

  if (existing.length > 0) {
    await db.update(settings).set({ value }).where(eq(settings.key, DAILY_CHECKIN_CONFIG_DB_KEY));
  } else {
    await db.insert(settings).values({
      key: DAILY_CHECKIN_CONFIG_DB_KEY,
      value,
      description: "Daily check-in coupon campaign settings (admin-configurable)",
    });
  }

  return { success: true };
}

/**
 * The effective, runtime campaign config: database override merged over
 * safe defaults. This is the only function claimDailyCheckin/
 * getDailyCheckinStatus should call - never read DEFAULT_DAILY_CHECKIN_CONFIG
 * directly.
 */
export async function getEffectiveDailyCheckinConfig(): Promise<DailyCheckinCampaignConfig> {
  const dbConfig = await getDailyCheckinConfigFromDatabase();
  if (!dbConfig) return { ...DEFAULT_DAILY_CHECKIN_CONFIG };
  return { ...DEFAULT_DAILY_CHECKIN_CONFIG, ...dbConfig };
}
