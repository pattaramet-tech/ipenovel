import { eq } from "drizzle-orm";
import { settings } from "../../drizzle/schema";
import { getDb } from "../db";
import { ENV } from "./env";

/**
 * OCR Settings stored in database
 * Represents the full set of admin-configurable OCR parameters
 */
export interface AdminOCRSettings {
  enabled: boolean;
  autoApproveEnabled: boolean;
  shadowModeEnabled: boolean;
  minConfidence: number; // 0-100
  maxTimeWindowMinutes: number; // 1-1440
}

/**
 * Effective OCR Config - the actual runtime configuration
 * Combines environment overrides, database settings, and safe defaults
 */
export interface EffectiveOCRConfig extends AdminOCRSettings {
  source: "environment" | "database" | "default";
  environmentOverride: string | null;
}

/**
 * Safe defaults for OCR settings
 */
const DEFAULT_OCR_SETTINGS: AdminOCRSettings = {
  enabled: true,
  autoApproveEnabled: true,
  shadowModeEnabled: false,
  minConfidence: 80,
  maxTimeWindowMinutes: 120,
};

/**
 * Database settings key
 */
const OCR_SETTINGS_DB_KEY = "ocr_settings";

/**
 * Validate admin OCR settings
 */
export function validateAdminOCRSettings(
  settings: Partial<AdminOCRSettings>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof settings.enabled !== "undefined" && typeof settings.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }

  if (
    typeof settings.autoApproveEnabled !== "undefined" &&
    typeof settings.autoApproveEnabled !== "boolean"
  ) {
    errors.push("autoApproveEnabled must be a boolean");
  }

  if (
    typeof settings.shadowModeEnabled !== "undefined" &&
    typeof settings.shadowModeEnabled !== "boolean"
  ) {
    errors.push("shadowModeEnabled must be a boolean");
  }

  if (typeof settings.minConfidence !== "undefined") {
    const val = settings.minConfidence;
    if (!Number.isInteger(val) || val < 0 || val > 100) {
      errors.push("minConfidence must be an integer between 0 and 100");
    }
  }

  if (typeof settings.maxTimeWindowMinutes !== "undefined") {
    const val = settings.maxTimeWindowMinutes;
    if (!Number.isInteger(val) || val < 1 || val > 1440) {
      errors.push("maxTimeWindowMinutes must be an integer between 1 and 1440");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get OCR settings from database
 * Returns null if not found or on error
 */
async function getOCRSettingsFromDatabase(): Promise<AdminOCRSettings | null> {
  try {
    const db = await getDb();
    if (!db) {
      console.warn("[OCR Effective Config] Database not available");
      return null;
    }

    const result = await db
      .select()
      .from(settings)
      .where(eq(settings.key, OCR_SETTINGS_DB_KEY))
      .limit(1);

    if (result.length === 0 || !result[0].value) {
      return null;
    }

    const parsed = JSON.parse(result[0].value) as AdminOCRSettings;
    return parsed;
  } catch (error) {
    console.error("[OCR Effective Config] Error reading database settings:", error);
    return null;
  }
}

/**
 * Save OCR settings to database
 */
export async function saveOCRSettingsToDatabase(
  newSettings: Partial<AdminOCRSettings>
): Promise<boolean> {
  try {
    // Validate first
    const validation = validateAdminOCRSettings(newSettings);
    if (!validation.valid) {
      console.error("[OCR Effective Config] Validation failed:", validation.errors);
      return false;
    }

    // Get current settings and merge
    const current = await getOCRSettingsFromDatabase();
    const merged = {
      ...DEFAULT_OCR_SETTINGS,
      ...current,
      ...newSettings,
    };

    const db = await getDb();
    if (!db) {
      console.error("[OCR Effective Config] Database not available");
      return false;
    }

    // Check if exists
    const existing = await db
      .select()
      .from(settings)
      .where(eq(settings.key, OCR_SETTINGS_DB_KEY))
      .limit(1);

    const value = JSON.stringify(merged);

    if (existing.length > 0) {
      // Update
      await db
        .update(settings)
        .set({ value })
        .where(eq(settings.key, OCR_SETTINGS_DB_KEY));
    } else {
      // Insert
      await db.insert(settings).values({
        key: OCR_SETTINGS_DB_KEY,
        value,
        description: "OCR payment slip verification settings (admin-configurable)",
      });
    }

    console.log("[OCR Effective Config] Settings saved:", merged);
    return true;
  } catch (error) {
    console.error("[OCR Effective Config] Error saving settings:", error);
    return false;
  }
}

/**
 * Get effective OCR configuration
 *
 * Resolution order:
 * 1. Environment OCR_ENABLED=false is a hard override (forces OCR off)
 * 2. Database admin settings (if available and valid)
 * 3. Safe defaults
 *
 * Returns the effective config along with source information
 */
export async function getEffectiveOCRConfig(): Promise<EffectiveOCRConfig> {
  // Check environment hard-off override
  if (ENV.ocrEnabled === false) {
    return {
      ...DEFAULT_OCR_SETTINGS,
      enabled: false,
      source: "environment",
      environmentOverride: "OCR_ENABLED=false",
    };
  }

  // Try to get from database
  const dbSettings = await getOCRSettingsFromDatabase();

  if (dbSettings) {
    return {
      ...dbSettings,
      source: "database",
      environmentOverride: null,
    };
  }

  // Fall back to defaults
  return {
    ...DEFAULT_OCR_SETTINGS,
    source: "default",
    environmentOverride: null,
  };
}

/**
 * Get OCR settings for admin display
 * Includes current values and source information
 */
export async function getOCRSettingsForAdmin() {
  const effective = await getEffectiveOCRConfig();
  return {
    settings: {
      enabled: effective.enabled,
      autoApproveEnabled: effective.autoApproveEnabled,
      shadowModeEnabled: effective.shadowModeEnabled,
      minConfidence: effective.minConfidence,
      maxTimeWindowMinutes: effective.maxTimeWindowMinutes,
    },
    source: effective.source,
    environmentOverride: effective.environmentOverride,
    canEdit: effective.environmentOverride === null, // Can only edit if no hard override
  };
}
