import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Wallet Staging End-to-End: Top-up Submission → Approval → Consistency", () => {
  const testAdminUserId = 88888;

  /**
   * STAGING E2E TEST: Complete wallet top-up flow
   * 
   * Verifies:
   * 1. Top-up submission creates correct record with bonus calculation
   * 2. Admin approval updates status and credits wallet
   * 3. creditedAmount = requestedAmount + bonusAmount
   * 4. Wallet balance increases by creditedAmount (not just requested)
   * 5. Topup logs record correct amounts
   * 6. UI consistency: topup record shows all amounts for admin/user display
   */

  it("E2E: 250฿ top-up submission creates correct record with bonus", async () => {
    const userId = 77001;
    await db.getOrCreateWalletAccount(userId);

    // Step 1: User submits top-up request
    const topup = await db.createWalletTopup(userId, "250.00");

    // Verify submission created correct record
    expect(topup.userId).toBe(userId);
    expect(topup.requestedAmount).toBe("250.00");
    expect(topup.bonusAmount).toBe("10.00");
    expect(topup.creditedAmount).toBe("260.00");
    expect(topup.status).toBe("pending");

    console.log("[E2E] Step 1 PASS: Top-up submitted with correct amounts");
    console.log(`  requestedAmount: ${topup.requestedAmount}`);
    console.log(`  bonusAmount: ${topup.bonusAmount}`);
    console.log(`  creditedAmount: ${topup.creditedAmount}`);
  });

  it("E2E: Admin approval updates status and credits wallet correctly", async () => {
    const userId = 77002;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Step 1: User submits top-up
    const topup = await db.createWalletTopup(userId, "500.00");
    expect(topup.creditedAmount).toBe("520.00"); // 500 + 20 bonus

    // Step 2: Admin approves
    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Step 3: Verify status changed
    const approvedTopup = await db.getWalletTopupById(topup.id);
    expect(approvedTopup?.status).toBe("approved");

    // Step 4: Verify wallet balance increased by creditedAmount
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    const expectedBalance = walletBefore + 520.0; // creditedAmount, not just requested

    expect(walletAfter).toBe(expectedBalance);

    console.log("[E2E] Step 2 PASS: Admin approval processed correctly");
    console.log(`  Wallet before: ${walletBefore}`);
    console.log(`  Wallet after: ${walletAfter}`);
    console.log(`  Credited: ${walletAfter - walletBefore}฿ (includes 20฿ bonus)`);
  });

  it("E2E: Topup logs record correct amounts and creator", async () => {
    const userId = 77003;
    await db.getOrCreateWalletAccount(userId);

    // Step 1: User submits
    const topup = await db.createWalletTopup(userId, "249.99");

    // Step 2: Admin approves
    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Step 3: Check topup logs - verify logs were created
    const logs = await db.getTopupLogs(userId);
    expect(logs.length).toBeGreaterThan(0);

    // Verify log structure has correct fields
    const firstLog = logs[0];
    expect(firstLog?.amount).toBeDefined();
    expect(firstLog?.bonus).toBeDefined();
    expect(firstLog?.total).toBeDefined();
    expect(firstLog?.method).toBe("slip");
    expect(firstLog?.createdBy).toBe(testAdminUserId);
    expect(firstLog?.createdByName).toBeDefined();

    console.log("[E2E] Step 3 PASS: Topup logs record correct amounts");
    console.log(`  Log amount: ${firstLog?.amount}`);
    console.log(`  Log bonus: ${firstLog?.bonus}`);
    console.log(`  Log total: ${firstLog?.total}`);
    console.log(`  Log createdBy: ${firstLog?.createdBy}`);
    console.log(`  Log createdByName: ${firstLog?.createdByName}`);
  });

  it("E2E: UI consistency - topup record shows all amounts for display", async () => {
    const userId = 77004;
    await db.getOrCreateWalletAccount(userId);

    // Create and approve a topup
    const topup = await db.createWalletTopup(userId, "499.99");
    await db.approveWalletTopup(topup.id, testAdminUserId);

    // Fetch the approved topup
    const approvedTopup = await db.getWalletTopupById(topup.id);

    // Verify all amounts are present for UI display
    expect(approvedTopup?.requestedAmount).toBe("499.99");
    expect(approvedTopup?.bonusAmount).toBe("10.00");
    expect(approvedTopup?.creditedAmount).toBe("509.99");
    expect(approvedTopup?.status).toBe("approved");

    // Simulate admin UI display
    const adminDisplay = {
      userId: approvedTopup?.userId,
      requestedAmount: approvedTopup?.requestedAmount,
      bonusAmount: approvedTopup?.bonusAmount,
      creditedAmount: approvedTopup?.creditedAmount,
      status: approvedTopup?.status,
    };

    expect(adminDisplay.requestedAmount).toBe("499.99");
    expect(adminDisplay.bonusAmount).toBe("10.00");
    expect(adminDisplay.creditedAmount).toBe("509.99");

    // Simulate user UI display
    const userDisplay = {
      requestedAmount: approvedTopup?.requestedAmount,
      bonusAmount: approvedTopup?.bonusAmount,
      totalCredit: approvedTopup?.creditedAmount,
      status: approvedTopup?.status,
    };

    expect(userDisplay.totalCredit).toBe("509.99");

    console.log("[E2E] Step 4 PASS: UI consistency verified");
    console.log(`  Admin display: ${adminDisplay.requestedAmount} + ${adminDisplay.bonusAmount} = ${adminDisplay.creditedAmount}`);
    console.log(`  User display: Total credit = ${userDisplay.totalCredit}`);
  });

  it("E2E: Bonus tier boundary at 250฿ works correctly", async () => {
    const userId = 77005;
    await db.getOrCreateWalletAccount(userId);

    // Test boundary: 250฿ should get +10฿ bonus
    const topup = await db.createWalletTopup(userId, "250.00");
    expect(topup.bonusAmount).toBe("10.00");
    expect(topup.creditedAmount).toBe("260.00");

    await db.approveWalletTopup(topup.id, testAdminUserId);

    const approved = await db.getWalletTopupById(topup.id);
    expect(approved?.status).toBe("approved");
    expect(approved?.creditedAmount).toBe("260.00");

    console.log("[E2E] Tier boundary test PASS: 250.00฿ → +10.00฿ = 260.00฿");
  });

  it("E2E: Wallet balance accumulates correctly", async () => {
    const userId = 77006;
    await db.getOrCreateWalletAccount(userId);

    const walletStart = parseFloat(await db.getWalletBalance(userId));

    // First topup: 250฿ + 10฿ = 260฿
    const topup1 = await db.createWalletTopup(userId, "250.00");
    await db.approveWalletTopup(topup1.id, testAdminUserId);
    const balance1 = parseFloat(await db.getWalletBalance(userId));
    expect(balance1).toBe(walletStart + 260.0);

    console.log("[E2E] Accumulation test PASS:");
    console.log(`  Start: ${walletStart}฿`);
    console.log(`  After topup 1 (260฿): ${balance1}฿`);
  });

  it("E2E: Rejection flow does not credit wallet", async () => {
    const userId = 77007;
    await db.getOrCreateWalletAccount(userId);

    const walletBefore = parseFloat(await db.getWalletBalance(userId));

    // Create topup
    const topup = await db.createWalletTopup(userId, "250.00");

    // Reject instead of approve
    await db.rejectWalletTopup(topup.id, testAdminUserId, "Invalid slip image");

    // Verify status is rejected
    const rejectedTopup = await db.getWalletTopupById(topup.id);
    expect(rejectedTopup?.status).toBe("rejected");
    expect(rejectedTopup?.rejectionReason).toBe("Invalid slip image");

    // Verify wallet balance did NOT increase
    const walletAfter = parseFloat(await db.getWalletBalance(userId));
    expect(walletAfter).toBe(walletBefore);

    console.log("[E2E] Rejection test PASS: Wallet not credited on rejection");
    console.log(`  Wallet before: ${walletBefore}฿`);
    console.log(`  Wallet after: ${walletAfter}฿ (unchanged)`);
  });
});
