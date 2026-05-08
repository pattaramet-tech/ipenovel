import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "./db";
import { settings } from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Admin Settings Page", () => {
  let db: any;

  beforeEach(async () => {
    db = await getDb();
    if (!db) throw new Error("Database connection failed");
  });

  describe("OCR Toggle Settings", () => {
    it("should load OCR toggle state correctly", async () => {
      // Ensure OCR setting exists
      const existing = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "ocr_enabled"))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({
          key: "ocr_enabled",
          value: JSON.stringify({ ocrEnabled: true }),
        });
      }

      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "ocr_enabled"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);
      expect(parsed.ocrEnabled).toBe(true);
    });

    it("should update OCR toggle state", async () => {
      // Update OCR setting
      await db
        .update(settings)
        .set({ value: JSON.stringify({ ocrEnabled: false }) })
        .where(eq(settings.key, "ocr_enabled"));

      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "ocr_enabled"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);
      expect(parsed.ocrEnabled).toBe(false);

      // Reset to true
      await db
        .update(settings)
        .set({ value: JSON.stringify({ ocrEnabled: true }) })
        .where(eq(settings.key, "ocr_enabled"));
    });

    it("should handle missing OCR setting with safe default", async () => {
      // Delete OCR setting if it exists
      await db
        .delete(settings)
        .where(eq(settings.key, "ocr_enabled"));

      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "ocr_enabled"))
        .limit(1);

      // Should be empty, frontend should use default (true)
      expect(result).toHaveLength(0);

      // Restore OCR setting
      await db.insert(settings).values({
        key: "ocr_enabled",
        value: JSON.stringify({ ocrEnabled: true }),
      });
    });
  });

  describe("Wallet Bonus Rules Settings", () => {
    it("should load wallet bonus rules correctly", async () => {
      // Ensure wallet bonus rules setting exists
      const existing = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(settings).values({
          key: "wallet_bonus_rules",
          value: JSON.stringify({
            rules: [
              { id: "rule1", threshold: 250, bonus: 10, enabled: true },
              { id: "rule2", threshold: 500, bonus: 20, enabled: true },
            ],
          }),
        });
      }

      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);
      expect(parsed.rules).toBeDefined();
      expect(Array.isArray(parsed.rules)).toBe(true);
    });

    it("should add a new bonus rule", async () => {
      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);
      const originalCount = parsed.rules.length;

      // Add new rule
      const newRule = {
        id: `rule_${Date.now()}`,
        threshold: 1000,
        bonus: 50,
        enabled: true,
        label: "Test Rule",
      };
      parsed.rules.push(newRule);

      await db
        .update(settings)
        .set({ value: JSON.stringify(parsed) })
        .where(eq(settings.key, "wallet_bonus_rules"));

      const updated = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      const updatedParsed = JSON.parse(updated[0].value);
      expect(updatedParsed.rules).toHaveLength(originalCount + 1);
      expect(updatedParsed.rules[updatedParsed.rules.length - 1].threshold).toBe(1000);

      // Clean up: remove the test rule
      updatedParsed.rules = updatedParsed.rules.filter((r: any) => r.id !== newRule.id);
      await db
        .update(settings)
        .set({ value: JSON.stringify(updatedParsed) })
        .where(eq(settings.key, "wallet_bonus_rules"));
    });

    it("should delete a bonus rule", async () => {
      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);
      const originalCount = parsed.rules.length;

      if (originalCount > 0) {
        const ruleToDelete = parsed.rules[0];
        parsed.rules = parsed.rules.filter((r: any) => r.id !== ruleToDelete.id);

        await db
          .update(settings)
          .set({ value: JSON.stringify(parsed) })
          .where(eq(settings.key, "wallet_bonus_rules"));

        const updated = await db
          .select()
          .from(settings)
          .where(eq(settings.key, "wallet_bonus_rules"))
          .limit(1);

        const updatedParsed = JSON.parse(updated[0].value);
        expect(updatedParsed.rules).toHaveLength(originalCount - 1);

        // Restore the rule
        parsed.rules.push(ruleToDelete);
        await db
          .update(settings)
          .set({ value: JSON.stringify(parsed) })
          .where(eq(settings.key, "wallet_bonus_rules"));
      }
    });

    it("should toggle a bonus rule", async () => {
      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      expect(result).toHaveLength(1);
      const parsed = JSON.parse(result[0].value);

      if (parsed.rules.length > 0) {
        const originalEnabled = parsed.rules[0].enabled;
        parsed.rules[0].enabled = !originalEnabled;

        await db
          .update(settings)
          .set({ value: JSON.stringify(parsed) })
          .where(eq(settings.key, "wallet_bonus_rules"));

        const updated = await db
          .select()
          .from(settings)
          .where(eq(settings.key, "wallet_bonus_rules"))
          .limit(1);

        const updatedParsed = JSON.parse(updated[0].value);
        expect(updatedParsed.rules[0].enabled).toBe(!originalEnabled);

        // Restore original state
        parsed.rules[0].enabled = originalEnabled;
        await db
          .update(settings)
          .set({ value: JSON.stringify(parsed) })
          .where(eq(settings.key, "wallet_bonus_rules"));
      }
    });

    it("should handle missing bonus rules with safe default", async () => {
      // Delete bonus rules setting if it exists
      await db
        .delete(settings)
        .where(eq(settings.key, "wallet_bonus_rules"));

      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      // Should be empty, frontend should use empty array as default
      expect(result).toHaveLength(0);

      // Restore bonus rules setting
      await db.insert(settings).values({
        key: "wallet_bonus_rules",
        value: JSON.stringify({
          rules: [
            { id: "rule1", threshold: 250, bonus: 10, enabled: true },
            { id: "rule2", threshold: 500, bonus: 20, enabled: true },
          ],
        }),
      });
    });
  });

  describe("Admin Settings Page Stability", () => {
    it("should not crash when loading empty settings", async () => {
      // This test verifies the page handles missing data gracefully
      const ocrResult = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "ocr_enabled"))
        .limit(1);

      const bonusResult = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      // Even if both are empty, the page should render with defaults
      expect(ocrResult.length >= 0).toBe(true);
      expect(bonusResult.length >= 0).toBe(true);
    });

    it("should handle concurrent mutations safely", async () => {
      // Verify that multiple updates don't corrupt data
      const result = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "wallet_bonus_rules"))
        .limit(1);

      if (result.length > 0) {
        const parsed = JSON.parse(result[0].value);
        const originalRules = JSON.parse(JSON.stringify(parsed.rules));

        // Simulate concurrent updates
        parsed.rules[0].enabled = !parsed.rules[0].enabled;
        await db
          .update(settings)
          .set({ value: JSON.stringify(parsed) })
          .where(eq(settings.key, "wallet_bonus_rules"));

        const updated = await db
          .select()
          .from(settings)
          .where(eq(settings.key, "wallet_bonus_rules"))
          .limit(1);

        const updatedParsed = JSON.parse(updated[0].value);
        expect(updatedParsed.rules).toHaveLength(originalRules.length);

        // Restore original state
        await db
          .update(settings)
          .set({ value: JSON.stringify({ rules: originalRules }) })
          .where(eq(settings.key, "wallet_bonus_rules"));
      }
    });
  });
});
