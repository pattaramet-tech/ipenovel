/**
 * Tests for Wallet Bonus Settings Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getBonusRules,
  getEnabledBonusRules,
  calculateBonusFromSettings,
  addBonusRule,
  updateBonusRule,
  deleteBonusRule,
  toggleBonusRule,
  resetBonusRulesToDefaults,
  BonusRule,
} from "./wallet-bonus-settings";

describe("Wallet Bonus Settings", () => {
  beforeEach(async () => {
    // Reset to defaults before each test
    await resetBonusRulesToDefaults();
  });

  describe("getBonusRules", () => {
    it("should return default rules on first call", async () => {
      const rules = await getBonusRules();
      expect(rules).toHaveLength(2);
      expect(rules[0].threshold).toBe(250);
      expect(rules[0].bonus).toBe(10);
      expect(rules[1].threshold).toBe(500);
      expect(rules[1].bonus).toBe(20);
    });

    it("should return all rules including disabled ones", async () => {
      await addBonusRule(1000, 50, "VIP bonus");
      const rules = await getBonusRules();
      expect(rules.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("getEnabledBonusRules", () => {
    it("should return only enabled rules sorted by threshold", async () => {
      const rules = await getEnabledBonusRules();
      expect(rules.every((r) => r.enabled)).toBe(true);
      for (let i = 0; i < rules.length - 1; i++) {
        expect(rules[i].threshold).toBeLessThan(rules[i + 1].threshold);
      }
    });

    it("should exclude disabled rules", async () => {
      const rules = await getBonusRules();
      const firstRule = rules[0];
      await toggleBonusRule(firstRule.id, false);
      const enabledRules = await getEnabledBonusRules();
      expect(enabledRules.find((r) => r.id === firstRule.id)).toBeUndefined();
    });
  });

  describe("calculateBonusFromSettings", () => {
    it("should return 0 for amount below threshold", async () => {
      const bonus = await calculateBonusFromSettings(100);
      expect(bonus).toBe("0.00");
    });

    it("should return 10 for amount between 250-499", async () => {
      const bonus = await calculateBonusFromSettings(250);
      expect(bonus).toBe("10.00");
      const bonus2 = await calculateBonusFromSettings(499);
      expect(bonus2).toBe("10.00");
    });

    it("should return 20 for amount 500+", async () => {
      const bonus = await calculateBonusFromSettings(500);
      expect(bonus).toBe("20.00");
      const bonus2 = await calculateBonusFromSettings(1000);
      expect(bonus2).toBe("20.00");
    });

    it("should use highest matching rule", async () => {
      await addBonusRule(1000, 50, "Premium");
      const bonus = await calculateBonusFromSettings(1000);
      expect(bonus).toBe("50.00");
      const bonus2 = await calculateBonusFromSettings(999);
      expect(bonus2).toBe("20.00");
    });

    it("should handle string input", async () => {
      const bonus = await calculateBonusFromSettings("250");
      expect(bonus).toBe("10.00");
    });

    it("should throw error for invalid amount", async () => {
      await expect(calculateBonusFromSettings(0)).rejects.toThrow();
      await expect(calculateBonusFromSettings(-100)).rejects.toThrow();
      await expect(calculateBonusFromSettings(NaN)).rejects.toThrow();
    });

    it("should return 0 when no rules enabled", async () => {
      const rules = await getBonusRules();
      for (const rule of rules) {
        await toggleBonusRule(rule.id, false);
      }
      const bonus = await calculateBonusFromSettings(1000);
      expect(bonus).toBe("0.00");
    });
  });

  describe("addBonusRule", () => {
    it("should add a new bonus rule", async () => {
      await addBonusRule(1000, 50, "VIP");
      const rules = await getBonusRules();
      const newRule = rules.find((r) => r.threshold === 1000);
      expect(newRule).toBeDefined();
      expect(newRule?.bonus).toBe(50);
      expect(newRule?.label).toBe("VIP");
      expect(newRule?.enabled).toBe(true);
    });

    it("should reject duplicate threshold", async () => {
      await expect(addBonusRule(250, 15)).rejects.toThrow("already exists");
    });

    it("should sort rules by threshold after adding", async () => {
      await addBonusRule(100, 5);
      const rules = await getBonusRules();
      for (let i = 0; i < rules.length - 1; i++) {
        expect(rules[i].threshold).toBeLessThanOrEqual(rules[i + 1].threshold);
      }
    });
  });

  describe("updateBonusRule", () => {
    it("should update an existing rule", async () => {
      const rules = await getBonusRules();
      const ruleId = rules[0].id;
      await updateBonusRule(ruleId, { bonus: 15, label: "Updated" });
      const updated = await getBonusRules();
      const rule = updated.find((r) => r.id === ruleId);
      expect(rule?.bonus).toBe(15);
      expect(rule?.label).toBe("Updated");
    });

    it("should not allow changing rule ID", async () => {
      const rules = await getBonusRules();
      const originalId = rules[0].id;
      await updateBonusRule(originalId, { id: "new-id" } as any);
      const updated = await getBonusRules();
      const rule = updated.find((r) => r.threshold === rules[0].threshold);
      expect(rule?.id).toBe(originalId);
    });

    it("should reject duplicate threshold", async () => {
      const rules = await getBonusRules();
      await expect(
        updateBonusRule(rules[0].id, { threshold: rules[1].threshold })
      ).rejects.toThrow("already exists");
    });

    it("should throw error for non-existent rule", async () => {
      await expect(updateBonusRule("non-existent", { bonus: 100 })).rejects.toThrow(
        "not found"
      );
    });
  });

  describe("deleteBonusRule", () => {
    it("should delete a bonus rule", async () => {
      const rules = await getBonusRules();
      const ruleId = rules[0].id;
      await deleteBonusRule(ruleId);
      const updated = await getBonusRules();
      expect(updated.find((r) => r.id === ruleId)).toBeUndefined();
    });

    it("should throw error for non-existent rule", async () => {
      await expect(deleteBonusRule("non-existent")).rejects.toThrow("not found");
    });
  });

  describe("toggleBonusRule", () => {
    it("should enable a disabled rule", async () => {
      const rules = await getBonusRules();
      const ruleId = rules[0].id;
      await toggleBonusRule(ruleId, false);
      let updated = await getBonusRules();
      expect(updated.find((r) => r.id === ruleId)?.enabled).toBe(false);
      await toggleBonusRule(ruleId, true);
      updated = await getBonusRules();
      expect(updated.find((r) => r.id === ruleId)?.enabled).toBe(true);
    });

    it("should affect enabled rules list", async () => {
      const rules = await getBonusRules();
      const ruleId = rules[0].id;
      const enabledBefore = await getEnabledBonusRules();
      await toggleBonusRule(ruleId, false);
      const enabledAfter = await getEnabledBonusRules();
      expect(enabledAfter.length).toBe(enabledBefore.length - 1);
    });
  });

  describe("Integration scenarios", () => {
    it("should handle complex promotion setup", async () => {
      // Reset and create custom rules
      await resetBonusRulesToDefaults();
      
      // Add summer promotion
      await addBonusRule(100, 5, "Summer 5% bonus");
      await addBonusRule(1000, 100, "Summer VIP 100 bonus");
      
      // Verify calculations
      expect(await calculateBonusFromSettings(100)).toBe("5.00");
      expect(await calculateBonusFromSettings(250)).toBe("10.00");
      expect(await calculateBonusFromSettings(500)).toBe("20.00");
      expect(await calculateBonusFromSettings(1000)).toBe("100.00");
    });

    it("should handle rule updates during promotion", async () => {
      const rules = await getBonusRules();
      const premiumRule = rules.find((r) => r.threshold === 500);
      
      if (premiumRule) {
        // Boost bonus for promotion
        await updateBonusRule(premiumRule.id, { bonus: 50, label: "Flash Sale" });
        const bonus = await calculateBonusFromSettings(500);
        expect(bonus).toBe("50.00");
        
        // End promotion
        await updateBonusRule(premiumRule.id, { bonus: 20, label: undefined });
        const bonusAfter = await calculateBonusFromSettings(500);
        expect(bonusAfter).toBe("20.00");
      }
    });

    it("should maintain bonus calculations after rule modifications", async () => {
      // Add a new rule in the middle
      await addBonusRule(300, 12);
      
      // Verify all calculations still work
      const testCases = [
        { amount: 100, expected: "0.00" },
        { amount: 250, expected: "10.00" },
        { amount: 300, expected: "12.00" },
        { amount: 500, expected: "20.00" },
      ];
      
      for (const { amount, expected } of testCases) {
        const bonus = await calculateBonusFromSettings(amount);
        expect(bonus).toBe(expected);
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle decimal amounts", async () => {
      const bonus = await calculateBonusFromSettings(250.50);
      expect(bonus).toBe("10.00");
    });

    it("should handle very large amounts", async () => {
      const bonus = await calculateBonusFromSettings(999999);
      expect(bonus).toBe("20.00");
    });

    it("should handle rules with 0 bonus", async () => {
      await addBonusRule(100, 0, "No bonus tier");
      const bonus = await calculateBonusFromSettings(100);
      expect(bonus).toBe("0.00");
    });

    it("should return formatted bonus with 2 decimals", async () => {
      const bonus = await calculateBonusFromSettings(250);
      expect(bonus).toMatch(/^\d+\.\d{2}$/);
    });
  });
});
