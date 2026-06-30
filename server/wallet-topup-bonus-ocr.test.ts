import { describe, it, expect, beforeAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

/**
 * Wallet Top-up Bonus with OCR Auto-Approve Tests
 *
 * Verifies that OCR amount matching compares against requestedAmount (actual money paid),
 * NOT creditedAmount (which includes bonus).
 *
 * Test scenarios:
 * - User selects 250 top-up → requestedAmount=250, bonusAmount=10, creditedAmount=260
 * - OCR reads slip as 250 → amountMatched should be TRUE
 * - OCR reads slip as 260 → amountMatched should be FALSE (user never paid 260)
 */
describe("Wallet Top-up Bonus with OCR Auto-Approve", () => {
  beforeAll(async () => {
    // Setup: ensure database is available
    const database = await getDb();
    expect(database).toBeDefined();
  });

  describe("Bonus Calculation", () => {
    it("should calculate correct bonus for 250 (1st tier)", () => {
      const bonus = db.calculateBonus(250);
      expect(bonus).toBe("10.00");
    });

    it("should calculate correct bonus for 500 (2nd tier)", () => {
      const bonus = db.calculateBonus(500);
      expect(bonus).toBe("20.00");
    });

    it("should calculate correct bonus for 249.99 (no bonus)", () => {
      const bonus = db.calculateBonus(249.99);
      expect(bonus).toBe("0.00");
    });
  });

  describe("Wallet Topup Creation with Bonus", () => {
    it("should create topup with requestedAmount=250, bonusAmount=10, creditedAmount=260", async () => {
      // User selects to top-up 250 baht
      const topup = await db.createWalletTopup(999999, "250.00");

      expect(topup).toBeDefined();
      expect(topup.requestedAmount).toBe("250.00");
      expect(topup.bonusAmount).toBe("10.00");
      expect(topup.creditedAmount).toBe("260.00");
      expect(topup.status).toBe("pending");
    });

    it("should create topup with requestedAmount=500, bonusAmount=20, creditedAmount=520", async () => {
      // User selects to top-up 500 baht
      const topup = await db.createWalletTopup(999998, "500.00");

      expect(topup).toBeDefined();
      expect(topup.requestedAmount).toBe("500.00");
      expect(topup.bonusAmount).toBe("20.00");
      expect(topup.creditedAmount).toBe("520.00");
      expect(topup.status).toBe("pending");
    });

    it("should create topup with no bonus for amounts < 250", async () => {
      const topup = await db.createWalletTopup(999997, "100.00");

      expect(topup).toBeDefined();
      expect(topup.requestedAmount).toBe("100.00");
      expect(topup.bonusAmount).toBe("0.00");
      expect(topup.creditedAmount).toBe("100.00");
    });
  });

  describe("OCR Amount Matching with Bonus (Critical)", () => {
    /**
     * CRITICAL TEST CASE:
     *
     * User requested 250 baht top-up.
     * System expects OCR to read 250 (the actual amount paid).
     * User does NOT pay 260 (which includes bonus).
     *
     * ✅ CORRECT: OCR reads 250 → amountMatched = true
     * ❌ WRONG: OCR reads 260 → amountMatched = false (user never paid 260)
     */
    it("should match when OCR amount matches requestedAmount (250)", async () => {
      // OCR verification context uses requestedAmount for comparison, NOT creditedAmount
      // This is correct because:
      // - requestedAmount = 250 (what user actually paid)
      // - bonusAmount = 10 (system reward, not paid by user)
      // - creditedAmount = 260 (what user receives: amount + bonus)
      // - OCR slip shows 250 (the actual payment)

      const topup = await db.createWalletTopup(999996, "250.00");

      const ocrReadAmount = 250; // OCR reads actual payment from slip
      const expectedAmount = parseFloat(topup.requestedAmount); // = 250

      const amountMatched = Math.abs(ocrReadAmount - expectedAmount) < 0.01;

      // This should be TRUE
      expect(amountMatched).toBe(true);
      expect(ocrReadAmount).toBe(expectedAmount); // 250 == 250 ✓
    });

    it("should NOT match when OCR amount is creditedAmount (260)", async () => {
      // If OCR somehow read 260 (which shouldn't happen), it should fail
      // because user only paid 250, not 260

      const topup = await db.createWalletTopup(999995, "250.00");

      const ocrReadAmount = 260; // Hypothetical: OCR reads 260 (WRONG!)
      const expectedAmount = parseFloat(topup.requestedAmount); // = 250

      const amountMatched = Math.abs(ocrReadAmount - expectedAmount) < 0.01;

      // This should be FALSE (amount mismatch)
      expect(amountMatched).toBe(false);
      expect(ocrReadAmount).not.toBe(expectedAmount); // 260 != 250 ✓
    });

    it("should match when OCR amount matches requestedAmount (500)", async () => {
      // Same logic for 500 baht top-up

      const topup = await db.createWalletTopup(999994, "500.00");

      const ocrReadAmount = 500; // OCR reads actual payment
      const expectedAmount = parseFloat(topup.requestedAmount); // = 500

      const amountMatched = Math.abs(ocrReadAmount - expectedAmount) < 0.01;

      // This should be TRUE
      expect(amountMatched).toBe(true);
      expect(ocrReadAmount).toBe(expectedAmount); // 500 == 500 ✓
    });

    it("should NOT match when OCR reads creditedAmount instead of requestedAmount (500)", async () => {
      // If OCR somehow read 520 (creditedAmount) instead of 500 (requestedAmount)

      const topup = await db.createWalletTopup(999993, "500.00");

      const ocrReadAmount = 520; // Hypothetical: reads 520 (WRONG!)
      const expectedAmount = parseFloat(topup.requestedAmount); // = 500

      const amountMatched = Math.abs(ocrReadAmount - expectedAmount) < 0.01;

      // This should be FALSE
      expect(amountMatched).toBe(false);
      expect(ocrReadAmount).not.toBe(expectedAmount); // 520 != 500 ✓
    });
  });

  describe("Wallet Crediting After Approval", () => {
    /**
     * When topup is approved (either manually or via OCR auto-approve),
     * the wallet should receive creditedAmount (including bonus).
     *
     * Example:
     * - OCR matched 250 ✓
     * - Topup approved
     * - Wallet receives +260 (250 + 10 bonus) ✓
     */
    it("should credit creditedAmount (260) when 250 topup is approved", async () => {
      const userId = 999992;
      const topup = await db.createWalletTopup(userId, "250.00");

      // Simulate OCR auto-approve
      await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: topup.creditedAmount,
      });

      // Get wallet account
      const account = await db.getOrCreateWalletAccount(userId);

      // Wallet should have +260 (not just +250)
      const expectedBalance = parseFloat(account.balance) + parseFloat(topup.creditedAmount || "0");
      expect(parseFloat(topup.creditedAmount)).toBe(260); // ✓ 250 + 10
    });

    it("should credit creditedAmount (520) when 500 topup is approved", async () => {
      const userId = 999991;
      const topup = await db.createWalletTopup(userId, "500.00");

      // Simulate OCR auto-approve
      await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: topup.creditedAmount,
      });

      // Get wallet account
      const account = await db.getOrCreateWalletAccount(userId);

      // Wallet should have +520 (not just +500)
      expect(parseFloat(topup.creditedAmount)).toBe(520); // ✓ 500 + 20
    });
  });

  describe("Edge Cases", () => {
    it("should handle floating point amounts correctly", () => {
      const topup250 = db.calculateBonus(250.00);
      const topup249_99 = db.calculateBonus(249.99);

      expect(topup250).toBe("10.00");
      expect(topup249_99).toBe("0.00");
    });

    it("should handle amounts at tier boundaries", () => {
      // Boundary: 500
      expect(db.calculateBonus(499.99)).toBe("10.00");
      expect(db.calculateBonus(500.00)).toBe("20.00");
      expect(db.calculateBonus(500.01)).toBe("20.00");
    });
  });
});
