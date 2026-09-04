import { describe, expect, it } from "vitest";
import {
  atWalletApprovalStage,
  getWalletApprovalLockStage,
} from "./walletApprovalStage";

function timeout(detail = "secret driver detail") {
  return Object.assign(new Error(detail), {
    errno: 1205,
    code: "ER_LOCK_WAIT_TIMEOUT",
    sqlState: "HY000",
  });
}

describe("IPE-020-C04 wallet approval stage diagnostics", () => {
  it("wraps 1205 with a fixed whitelisted stage and retains the raw cause server-side", async () => {
    const driver = timeout();
    let caught: unknown;
    try {
      await atWalletApprovalStage("wallet_user_guard", async () => {
        throw driver;
      });
    } catch (error) {
      caught = error;
    }

    expect(getWalletApprovalLockStage(caught)).toBe("wallet_user_guard");
    expect((caught as Error).message).toBe(
      "WALLET_APPROVAL_LOCK_STAGE:wallet_user_guard"
    );
    expect((caught as any).cause).toBe(driver);
    expect((caught as Error).message).not.toContain("secret");
  });

  it("does not relabel non-1205 business failures", async () => {
    const original = Object.assign(new Error("duplicate"), { code: "SLIP_ALREADY_CLAIMED" });
    let caught: unknown;
    try {
      await atWalletApprovalStage("wallet_slip_claim", async () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(getWalletApprovalLockStage(caught)).toBeUndefined();
  });

  it("ignores arbitrary stage injection", () => {
    expect(
      getWalletApprovalLockStage({ walletApprovalStage: "sql=select secret" })
    ).toBeUndefined();
  });
});
