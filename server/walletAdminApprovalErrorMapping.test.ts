import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getWalletTopupById: vi.fn(),
    approveWalletTopup: vi.fn(),
  };
});

import * as db from "./db";
import * as walletService from "./services/walletService";

const REVIEWABLE_TOPUP = {
  id: 91,
  userId: 7,
  status: "pending_review",
  slipImageUrl: null,
};

describe("wallet admin approval error contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.getWalletTopupById as any).mockResolvedValue({ ...REVIEWABLE_TOPUP });
  });

  it("does not require a slip-image preflight when the database path may still have a transaction identifier", async () => {
    (db.approveWalletTopup as any).mockResolvedValue({ ...REVIEWABLE_TOPUP, status: "approved" });

    await expect(walletService.adminApproveWalletTopup(91, 1)).resolves.toMatchObject({ status: "approved" });
    expect(db.approveWalletTopup).toHaveBeenCalledWith(91, 1);
  });

  it("maps a stable NO_STRONG_IDENTIFIER code even when it is not an instanceof WalletSlipClaimError", async () => {
    (db.approveWalletTopup as any).mockRejectedValue({
      code: "NO_STRONG_IDENTIFIER",
      message: "No replay identifier remains",
    });

    await expect(walletService.adminApproveWalletTopup(91, 1)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "NO_STRONG_IDENTIFIER: No replay identifier remains",
    });
  });

  it("maps account-merge guard refusals as actionable preconditions instead of generic 500", async () => {
    (db.approveWalletTopup as any).mockRejectedValue({
      code: "ACCOUNT_MERGE_SOURCE_GUARDED",
      message: "Classified account mutation refused while merge is active",
    });

    await expect(walletService.adminApproveWalletTopup(91, 1)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("ACCOUNT_MERGE_SOURCE_GUARDED"),
    });
  });

  it("maps a lost approval race as CONFLICT", async () => {
    (db.approveWalletTopup as any).mockRejectedValue({
      code: "TOPUP_STATE_RACE",
      message: "Wallet top-up already processed by another request",
    });

    await expect(walletService.adminApproveWalletTopup(91, 1)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("TOPUP_STATE_RACE"),
    });
  });

  it("keeps unexpected faults as a safe INTERNAL_SERVER_ERROR without leaking the raw message", async () => {
    const rawError = Object.assign(new Error("SQL password=do-not-leak"), {
      errno: 1205,
      code: "ER_LOCK_WAIT_TIMEOUT",
      sqlState: "HY000",
    });
    (db.approveWalletTopup as any).mockRejectedValue(rawError);

    try {
      await walletService.adminApproveWalletTopup(91, 1);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
      expect((error as TRPCError).message).not.toContain("do-not-leak");
      expect((error as TRPCError).cause).toBe(rawError);
    }
  });

  it("break-glass is a separate call carrying a mandatory server-side reason", async () => {
    (db.approveWalletTopup as any).mockResolvedValue({ ...REVIEWABLE_TOPUP, status: "approved" });

    await walletService.adminApproveLegacyUnprotectedWalletTopup(
      91,
      1,
      "Checked archived bank statement manually"
    );

    expect(db.approveWalletTopup).toHaveBeenCalledWith(91, 1, {
      legacyUnprotectedApproval: { reason: "Checked archived bank statement manually" },
    });
  });
});
