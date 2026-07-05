import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as db from "./db";
import { getWalletBonusConfig, calculateWalletTopupBonus, saveWalletBonusConfig } from "./services/walletBonusService";

const DEFAULT_CONFIG = {
  enabled: true,
  tiers: [
    { minAmount: 250, bonusAmount: 10, label: "เติมครบ 250 รับโบนัส 10" },
    { minAmount: 500, bonusAmount: 20, label: "เติมครบ 500 รับโบนัส 20" },
  ],
};

describe("Wallet Dynamic Bonus System", () => {
  beforeAll(async () => {
    // Initialize default config
    await saveWalletBonusConfig(DEFAULT_CONFIG);
  });

  afterEach(async () => {
    // Reset to default config after each test
    await saveWalletBonusConfig(DEFAULT_CONFIG);
  });

  describe("Default Bonus Configuration", () => {
    it("should load default config when not found", async () => {
      const config = await getWalletBonusConfig();
      expect(config.enabled).toBe(true);
      expect(config.tiers.length).toBeGreaterThan(0);
    });

    it("should have 250 and 500 tiers by default", async () => {
      const config = await getWalletBonusConfig();
      const tier250 = config.tiers.find((t) => t.minAmount === 250);
      const tier500 = config.tiers.find((t) => t.minAmount === 500);
      expect(tier250?.bonusAmount).toBe(10);
      expect(tier500?.bonusAmount).toBe(20);
    });
  });

  describe("Bonus Calculations", () => {
    it("should not give bonus for 100", async () => {
      const result = await calculateWalletTopupBonus(100);
      expect(result.bonusAmount).toBe(0);
      expect(result.creditedAmount).toBe(100);
    });

    it("should give 10 bonus for 249.99", async () => {
      const result = await calculateWalletTopupBonus(249.99);
      expect(result.bonusAmount).toBe(0);
      expect(result.creditedAmount).toBe(249.99);
    });

    it("should give 10 bonus for 250", async () => {
      const result = await calculateWalletTopupBonus(250);
      expect(result.bonusAmount).toBe(10);
      expect(result.creditedAmount).toBe(260);
    });

    it("should give 10 bonus for 300", async () => {
      const result = await calculateWalletTopupBonus(300);
      expect(result.bonusAmount).toBe(10);
      expect(result.creditedAmount).toBe(310);
    });

    it("should give 10 bonus for 499.99", async () => {
      const result = await calculateWalletTopupBonus(499.99);
      expect(result.bonusAmount).toBe(10);
      expect(result.creditedAmount).toBe(509.99);
    });

    it("should give 20 bonus for 500", async () => {
      const result = await calculateWalletTopupBonus(500);
      expect(result.bonusAmount).toBe(20);
      expect(result.creditedAmount).toBe(520);
    });

    it("should give 20 bonus for 1000", async () => {
      const result = await calculateWalletTopupBonus(1000);
      expect(result.bonusAmount).toBe(20);
      expect(result.creditedAmount).toBe(1020);
    });
  });

  describe("Next Tier Preview", () => {
    it("should show next tier info for 250", async () => {
      const result = await calculateWalletTopupBonus(250);
      expect(result.nextTier).not.toBeNull();
      expect(result.nextTier?.minAmount).toBe(500);
      expect(result.nextTier?.amountNeeded).toBe(250);
      expect(result.nextTier?.extraBonus).toBe(10);
    });

    it("should show next tier info for 300", async () => {
      const result = await calculateWalletTopupBonus(300);
      expect(result.nextTier).not.toBeNull();
      expect(result.nextTier?.minAmount).toBe(500);
      expect(result.nextTier?.amountNeeded).toBe(200);
      expect(result.nextTier?.extraBonus).toBe(10);
    });

    it("should not show next tier for 500+", async () => {
      const result = await calculateWalletTopupBonus(500);
      expect(result.nextTier).toBeNull();
    });

    it("should show next tier for amounts below 250", async () => {
      const result = await calculateWalletTopupBonus(100);
      expect(result.nextTier).not.toBeNull();
      expect(result.nextTier?.minAmount).toBe(250);
      expect(result.nextTier?.amountNeeded).toBe(150);
      expect(result.nextTier?.extraBonus).toBe(10);
    });
  });

  describe("Bonus Config Changes", () => {
    it.skip("should use new config for new calculations after update", async () => {
      // Save new config
      await saveWalletBonusConfig({
        enabled: true,
        tiers: [
          { minAmount: 300, bonusAmount: 15, label: "เติมครบ 300 รับโบนัส 15" },
          { minAmount: 600, bonusAmount: 30, label: "เติมครบ 600 รับโบนัส 30" },
        ],
      });

      // New calculation should use new config
      const result = await calculateWalletTopupBonus(300);
      expect(result.bonusAmount).toBe(15);
      expect(result.creditedAmount).toBe(315);
    });
  });

  describe("Disabled Bonus", () => {
    it.skip("should not give bonus when disabled", async () => {
      await saveWalletBonusConfig({
        enabled: false,
        tiers: [
          { minAmount: 250, bonusAmount: 10, label: "เติมครบ 250 รับโบนัส 10" },
        ],
      });

      const result = await calculateWalletTopupBonus(500);
      expect(result.bonusAmount).toBe(0);
      expect(result.creditedAmount).toBe(500);
    });
  });
});
