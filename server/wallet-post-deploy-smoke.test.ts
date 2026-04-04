import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Wallet Post-Deploy Smoke Test: Bonus Tiers & Balance Verification", () => {
  const testAdminUserId = 88888;

  /**
   * MINIMAL POST-DEPLOY SMOKE TEST
   * 
   * Tests 3 critical bonus tier boundaries:
   * 1. 249.99฿ - No bonus (0฿)
   * 2. 250.00฿ - +10฿ bonus
   * 3. 500.00฿ - +20฿ bonus
   * 
   * Verifies for each:
   * - Bonus calculation correct
   * - creditedAmount = requestedAmount + bonusAmount
   * - Wallet balance increases by creditedAmount
   * - Topup logs record correct amounts
   * - UI consistency (all amounts available)
   */

  it("SMOKE: 249.99฿ top-up - No bonus, wallet increases by 249.99฿", async () => {
    const userId = 99001;
    await db.getOrCreateWalletAccount(userId);
    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Create and approve
    const topup = await db.createWalletTopup(userId, "249.99");
    expect(topup.bonusAmount).toBe("0.00");
    expect(topup.creditedAmount).toBe("249.99");

    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Verify wallet balance
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    expect(walletAfter).toBe(walletBefore + 249.99);

    // Verify logs
    const logs = await db.getTopupLogs(userId);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.total).toBe("249.99");

    console.log("✅ PASS: 249.99฿ → +0฿ = 249.99฿ credited");
  });

  it("SMOKE: 250.00฿ top-up - +10฿ bonus, wallet increases by 260.00฿", async () => {
    const userId = 99002;
    await db.getOrCreateWalletAccount(userId);
    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Create and approve
    const topup = await db.createWalletTopup(userId, "250.00");
    expect(topup.bonusAmount).toBe("10.00");
    expect(topup.creditedAmount).toBe("260.00");

    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Verify wallet balance
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    expect(walletAfter).toBe(walletBefore + 260.0);

    // Verify logs
    const logs = await db.getTopupLogs(userId);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.total).toBe("260.00");

    console.log("✅ PASS: 250.00฿ → +10฿ = 260.00฿ credited");
  });

  it("SMOKE: 500.00฿ top-up - +20฿ bonus, wallet increases by 520.00฿", async () => {
    const userId = 99003;
    await db.getOrCreateWalletAccount(userId);
    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Create and approve
    const topup = await db.createWalletTopup(userId, "500.00");
    expect(topup.bonusAmount).toBe("20.00");
    expect(topup.creditedAmount).toBe("520.00");

    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Verify wallet balance
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    expect(walletAfter).toBe(walletBefore + 520.0);

    // Verify logs
    const logs = await db.getTopupLogs(userId);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.total).toBe("520.00");

    console.log("✅ PASS: 500.00฿ → +20฿ = 520.00฿ credited");
  });

  it("SMOKE: UI Consistency - All amounts available for display", async () => {
    const userId = 99004;
    await db.getOrCreateWalletAccount(userId);

    // Create and approve 250฿ topup
    const topup = await db.createWalletTopup(userId, "250.00");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Fetch and verify all fields present
    const approved = await db.getWalletTopupById(topup.id);
    expect(approved?.requestedAmount).toBe("250.00");
    expect(approved?.bonusAmount).toBe("10.00");
    expect(approved?.creditedAmount).toBe("260.00");
    expect(approved?.status).toBe("approved");

    // Verify can construct admin display
    const adminDisplay = {
      requested: approved?.requestedAmount,
      bonus: approved?.bonusAmount,
      total: approved?.creditedAmount,
    };
    expect(adminDisplay.total).toBe("260.00");

    console.log("✅ PASS: UI consistency verified - all amounts available");
  });

  it("SMOKE: Rejection flow - Wallet not credited", async () => {
    const userId = 99005;
    await db.getOrCreateWalletAccount(userId);
    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Create and reject
    const topup = await db.createWalletTopup(userId, "250.00");
    await db.rejectWalletTopup(topup.id, testAdminUserId, "Test rejection");

    // Verify wallet unchanged
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    expect(walletAfter).toBe(walletBefore);

    console.log("✅ PASS: Rejection flow - wallet not credited");
  });
});
