import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createWalletTopup, getWalletTopupById } from "./db";

describe("Wallet Topup Insert Result Handling", () => {
  let createdTopupId: number | undefined;

  beforeAll(async () => {
    // Setup: Create a test user if needed
    // This test assumes a user with ID 1 exists for testing
  });

  afterAll(async () => {
    // Cleanup: Remove test topup if created
    if (createdTopupId) {
      // Cleanup would happen here in a real test
    }
  });

  it("should create wallet topup and extract insertId correctly", async () => {
    const userId = 1; // Assuming test user exists
    const requestedAmount = "100.00";

    // Create topup - this will test the defensive insertId extraction
    const topup = await createWalletTopup(userId, requestedAmount);

    // Verify topup was created with valid ID
    expect(topup).toBeDefined();
    expect(topup.id).toBeGreaterThan(0);
    expect(typeof topup.id).toBe("number");

    createdTopupId = topup.id;
  });

  it("should validate inserted topup has correct data", async () => {
    const userId = 1;
    const requestedAmount = "50.00";

    const topup = await createWalletTopup(userId, requestedAmount);

    expect(topup.userId).toBe(userId);
    expect(topup.requestedAmount).toBe(requestedAmount);
    expect(topup.status).toBe("pending");
    expect(parseFloat(topup.creditedAmount)).toBeGreaterThan(parseFloat(requestedAmount));

    createdTopupId = topup.id;
  });

  it("should handle bonus calculation correctly", async () => {
    const userId = 1;
    const requestedAmount = "300.00"; // Should get 10% bonus

    const topup = await createWalletTopup(userId, requestedAmount);

    expect(topup.bonusAmount).toBe("30.00");
    expect(topup.creditedAmount).toBe("330.00");

    createdTopupId = topup.id;
  });

  it("should fail with clear error on invalid amount", async () => {
    const userId = 1;

    // Test invalid amounts
    await expect(createWalletTopup(userId, "-50")).rejects.toThrow("Invalid top-up amount");
    await expect(createWalletTopup(userId, "0")).rejects.toThrow("Invalid top-up amount");
    await expect(createWalletTopup(userId, "invalid")).rejects.toThrow("Invalid top-up amount");
  });

  it("should retrieve created topup by ID", async () => {
    const userId = 1;
    const requestedAmount = "75.00";

    const created = await createWalletTopup(userId, requestedAmount);
    createdTopupId = created.id;

    // Verify we can retrieve it
    const retrieved = await getWalletTopupById(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.userId).toBe(userId);
    expect(retrieved.requestedAmount).toBe(requestedAmount);
  });

  it("should handle slip image URL correctly", async () => {
    const userId = 1;
    const requestedAmount = "100.00";
    const slipImageUrl = "https://example.com/slip.jpg";

    const topup = await createWalletTopup(userId, requestedAmount, slipImageUrl);

    expect(topup.slipImageUrl).toBe(slipImageUrl);

    createdTopupId = topup.id;
  });

  it("should handle null slip image URL", async () => {
    const userId = 1;
    const requestedAmount = "100.00";

    const topup = await createWalletTopup(userId, requestedAmount);

    expect(topup.slipImageUrl).toBeNull();

    createdTopupId = topup.id;
  });
});
