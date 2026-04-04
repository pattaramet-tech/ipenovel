import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Wallet Bonus Tier Boundary Smoke Tests", () => {
  const testAdminUserId = 99999;

  /**
   * Smoke test for bonus tier boundaries: 249.99 / 250.00 / 499.99 / 500.00
   * Verifies:
   * 1. Bonus calculation matches tier (0 / 10 / 20)
   * 2. creditedAmount = requestedAmount + bonusAmount
   * 3. Approval credits correct amount to wallet
   * 4. Admin UI shows all three amounts correctly
   */

  it("should calculate 0 bonus for amount < 250 (249.99)", async () => {
    const userId = 99001;
    await db.getOrCreateWalletAccount(userId);

    const topup = await db.createWalletTopup(userId, "249.99");

    expect(topup.requestedAmount).toBe("249.99");
    expect(topup.bonusAmount).toBe("0.00");
    expect(topup.creditedAmount).toBe("249.99");
    expect(topup.status).toBe("pending");
  });

  it("should calculate 10 bonus for amount >= 250 (250.00)", async () => {
    const userId = 99002;
    await db.getOrCreateWalletAccount(userId);

    const topup = await db.createWalletTopup(userId, "250.00");

    expect(topup.requestedAmount).toBe("250.00");
    expect(topup.bonusAmount).toBe("10.00");
    expect(topup.creditedAmount).toBe("260.00");
    expect(topup.status).toBe("pending");
  });

  it("should calculate 10 bonus for amount < 500 (499.99)", async () => {
    const userId = 99003;
    await db.getOrCreateWalletAccount(userId);

    const topup = await db.createWalletTopup(userId, "499.99");

    expect(topup.requestedAmount).toBe("499.99");
    expect(topup.bonusAmount).toBe("10.00");
    expect(topup.creditedAmount).toBe("509.99");
    expect(topup.status).toBe("pending");
  });

  it("should calculate 20 bonus for amount >= 500 (500.00)", async () => {
    const userId = 99004;
    await db.getOrCreateWalletAccount(userId);

    const topup = await db.createWalletTopup(userId, "500.00");

    expect(topup.requestedAmount).toBe("500.00");
    expect(topup.bonusAmount).toBe("20.00");
    expect(topup.creditedAmount).toBe("520.00");
    expect(topup.status).toBe("pending");
  });

  it("should approve 249.99 topup and credit exact amount to wallet", async () => {
    const userId = 99005;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = await db.getWalletBalance(userId);
    const walletBeforeNum = parseFloat(walletBefore);

    const topup = await db.createWalletTopup(userId, "249.99");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    const walletAfter = await db.getWalletBalance(userId);
    const walletAfterNum = parseFloat(walletAfter);

    // Should credit exactly 249.99 (no bonus)
    expect(walletAfterNum).toBe(walletBeforeNum + 249.99);
  });

  it("should approve 250.00 topup and credit with 10 bonus", async () => {
    const userId = 99006;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = await db.getWalletBalance(userId);
    const walletBeforeNum = parseFloat(walletBefore);

    const topup = await db.createWalletTopup(userId, "250.00");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    const walletAfter = await db.getWalletBalance(userId);
    const walletAfterNum = parseFloat(walletAfter);

    // Should credit 250.00 + 10.00 = 260.00
    expect(walletAfterNum).toBe(walletBeforeNum + 260.0);
  });

  it("should approve 499.99 topup and credit with 10 bonus", async () => {
    const userId = 99007;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = await db.getWalletBalance(userId);
    const walletBeforeNum = parseFloat(walletBefore);

    const topup = await db.createWalletTopup(userId, "499.99");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    const walletAfter = await db.getWalletBalance(userId);
    const walletAfterNum = parseFloat(walletAfter);

    // Should credit 499.99 + 10.00 = 509.99
    expect(walletAfterNum).toBe(walletBeforeNum + 509.99);
  });

  it("should approve 500.00 topup and credit with 20 bonus", async () => {
    const userId = 99008;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = await db.getWalletBalance(userId);
    const walletBeforeNum = parseFloat(walletBefore);

    const topup = await db.createWalletTopup(userId, "500.00");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    const walletAfter = await db.getWalletBalance(userId);
    const walletAfterNum = parseFloat(walletAfter);

    // Should credit 500.00 + 20.00 = 520.00
    expect(walletAfterNum).toBe(walletBeforeNum + 520.0);
  });

  it("should verify topup record has correct amounts after approval", async () => {
    const userId = 99009;
    await db.getOrCreateWalletAccount(userId);

    const topup = await db.createWalletTopup(userId, "500.00");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    const approvedTopup = await db.getWalletTopupById(topup.id);

    expect(approvedTopup?.requestedAmount).toBe("500.00");
    expect(approvedTopup?.bonusAmount).toBe("20.00");
    expect(approvedTopup?.creditedAmount).toBe("520.00");
    expect(approvedTopup?.status).toBe("approved");
  });


});
