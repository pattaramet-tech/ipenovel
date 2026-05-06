import { eq } from "drizzle-orm";
import { settings } from "../../drizzle/schema";
import { getDb } from "../db";
import { ENV, OCR_SETTINGS_KEY } from "./env";

/**
 * Get OCR enabled status from database or environment fallback
 * Environment variable OCR_ENABLED is the source of truth
 * Database setting is used for admin UI display/override
 */
export async function getOCREnabled(): Promise<boolean> {
  try {
    // Check environment first (source of truth)
    if (ENV.ocrEnabled === false) {
      return false;
    }

    const db = await getDb();
    if (!db) {
      console.warn("[OCR Settings] Database not available, using environment value");
      return ENV.ocrEnabled;
    }

    // Try to get from database settings
    const setting = await db
      .select()
      .from(settings)
      .where(eq(settings.key, OCR_SETTINGS_KEY))
      .limit(1);

    if (setting.length > 0 && setting[0].value !== undefined) {
      return setting[0].value === "true";
    }

    // Default to true if not set
    return true;
  } catch (error) {
    console.error("[OCR Settings] Error reading OCR enabled status:", error);
    // Fallback to environment on error
    return ENV.ocrEnabled;
  }
}

/**
 * Update OCR enabled status in database
 * Only works if environment allows it (OCR_ENABLED not explicitly set to false)
 */
export async function setOCREnabled(enabled: boolean): Promise<boolean> {
  try {
    // Don't allow override if environment explicitly disables OCR
    if (ENV.ocrEnabled === false) {
      console.warn("[OCR Settings] Cannot override OCR_ENABLED=false from environment");
      return false;
    }

    const db = await getDb();
    if (!db) {
      console.error("[OCR Settings] Database not available, cannot update OCR setting");
      return false;
    }

    const value = enabled ? "true" : "false";

    // Check if exists
    const existing = await db
      .select()
      .from(settings)
      .where(eq(settings.key, OCR_SETTINGS_KEY))
      .limit(1);

    if (existing.length > 0) {
      // Update
      await db
        .update(settings)
        .set({ value })
        .where(eq(settings.key, OCR_SETTINGS_KEY));
    } else {
      // Insert
      await db.insert(settings).values({
        key: OCR_SETTINGS_KEY,
        value,
        description: "Enable/disable OCR auto-processing for slip payments",
      });
    }

    console.log(`[OCR Settings] OCR enabled set to: ${enabled}`);
    return true;
  } catch (error) {
    console.error("[OCR Settings] Error updating OCR enabled status:", error);
    return false;
  }
}

/**
 * Get OCR settings summary for admin dashboard
 */
export async function getOCRSettingsSummary() {
  const enabled = await getOCREnabled();
  return {
    ocrEnabled: enabled,
    source: ENV.ocrEnabled === false ? "environment (disabled)" : "database or default",
    environmentOverride: ENV.ocrEnabled === false ? "OCR_ENABLED=false" : "none",
  };
}
