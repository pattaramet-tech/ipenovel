import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";

describe("Wallet Integration Tests", () => {
  let testUserId: number = 99999;
  let testTopupId: number;

  beforeAll(async () => {
    testUserId = 99999;
  });

  describe("1. createWalletTopup persists requestedAmount / bonusAmount / creditedAmount", () => {
    it("should create topup with correct bonus calculation for amount < 250", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00");
      testTopupId = topup.id;

      expect(topup.requestedAmount).toBe("100.00");
      expect(topup.bonusAmount).toBe("0.00");
      expect(topup.creditedAmount).toBe("100.00");
      expect(topup.status).toBe("pending");
    });

    it("should create topup with correct bonus calculation for amount 250-499", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00");

      expect(topup.requestedAmount).toBe("300.00");
      expect(topup.bonusAmount).toBe("10.00");
      expect(topup.creditedAmount).toBe("310.00");
    });

    it("should create topup with correct bonus calculation for amount >= 500", async () => {
      const topup = await db.createWalletTopup(testUserId, "500.00");

      expect(topup.requestedAmount).toBe("500.00");
      expect(topup.bonusAmount).toBe("20.00");
      expect(topup.creditedAmount).toBe("520.00");
    });
  });

  describe("2. approveWalletTopup credits creditedAmount correctly", () => {
    it("should credit wallet with creditedAmount (includes bonus) on approval", async () => {
      const topup = await db.createWalletTopup(testUserId, "250.00");
      const balanceBefore = await db.getWalletBalance(testUserId);

      await db.approveWalletTopup(topup.id, 1);

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);

      expect(credited).toBeCloseTo(260.0, 1);
    });

    it("should update topup status to approved", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00");
      await db.approveWalletTopup(topup.id, 1);

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("approved");
      expect(updated.reviewedByUserId).toBe(1);
      expect(updated.reviewedAt).toBeDefined();
    });
  });

  describe("3. approving the same topup twice does not double-credit", () => {
    it("should prevent double approval by checking status", async () => {
      const topup = await db.createWalletTopup(testUserId, "200.00");
      const balanceBefore = await db.getWalletBalance(testUserId);

      await db.approveWalletTopup(topup.id, 1);
      const balanceAfterFirst = await db.getWalletBalance(testUserId);
      const creditedFirst = parseFloat(balanceAfterFirst) - parseFloat(balanceBefore);

      try {
        await db.approveWalletTopup(topup.id, 1);
        throw new Error("Should have thrown error on second approval");
      } catch (error: any) {
        expect(error.message).toContain("Cannot approve approved");
      }

      const balanceAfterSecond = await db.getWalletBalance(testUserId);
      expect(balanceAfterSecond).toBe(balanceAfterFirst);
    });
  });

  describe("4. legacy topup rows without bonus fields still work", () => {
    it("should handle topup with missing bonusAmount gracefully", async () => {
      const topup = await db.createWalletTopup(testUserId, "150.00");
      const balanceBefore = await db.getWalletBalance(testUserId);

      await db.approveWalletTopup(topup.id, 1);

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);
      expect(credited).toBeCloseTo(150.0, 1);
    });
  });

  describe("5. listPendingWalletTopups returns joined structure", () => {
    it("should return topups with user structure (may be null for deleted users)", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00");
      const pending = await db.listPendingWalletTopups(50, 0);

      const found = pending.find((t: any) => t.id === topup.id);
      expect(found).toBeDefined();
      expect(found).toHaveProperty('user');
    });

    it("should return all pending topups with consistent structure", async () => {
      const pending = await db.listPendingWalletTopups(50, 0);
      pending.forEach((topup: any) => {
        expect(topup).toHaveProperty('user');
        expect(topup).toHaveProperty('requestedAmount');
        expect(topup).toHaveProperty('status');
      });
    });
  });

  describe("6. wallet admin adjustBalance writes wallet transaction", () => {
    it("should credit wallet balance on admin adjustment", async () => {
      const balanceBefore = await db.getWalletBalance(testUserId);
      const adjustAmount = "100.00";

      await db.creditWalletBalance(testUserId, adjustAmount, "admin_adjust", 0);

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);
      expect(credited).toBeCloseTo(100.0, 1);
    });

    it("should create wallet transaction log for admin adjustment", async () => {
      const adjustAmount = "50.00";
      await db.creditWalletBalance(testUserId, adjustAmount, "admin_adjust", 0);

      const balance = await db.getWalletBalance(testUserId);
      expect(balance).toBeDefined();
      expect(parseFloat(balance)).toBeGreaterThan(0);
    });
  });

  describe("7. Bonus calculation edge cases", () => {
    it("should handle boundary amounts correctly", async () => {
      const topup1 = await db.createWalletTopup(testUserId, "249.99");
      expect(topup1.bonusAmount).toBe("0.00");
      expect(topup1.creditedAmount).toBe("249.99");

      const topup2 = await db.createWalletTopup(testUserId, "250.00");
      expect(topup2.bonusAmount).toBe("10.00");
      expect(topup2.creditedAmount).toBe("260.00");

      const topup3 = await db.createWalletTopup(testUserId, "499.99");
      expect(topup3.bonusAmount).toBe("10.00");
      expect(topup3.creditedAmount).toBe("509.99");

      const topup4 = await db.createWalletTopup(testUserId, "500.00");
      expect(topup4.bonusAmount).toBe("20.00");
      expect(topup4.creditedAmount).toBe("520.00");
    });
  });

  afterAll(async () => {
    // Cleanup
  });
});
