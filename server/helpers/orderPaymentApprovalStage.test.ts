import { describe, expect, it, vi } from "vitest";
import { mapOrderPaymentApprovalError, ORDER_PAYMENT_BUSY_MESSAGE } from "./adminPaymentApprovalError";
import {
  atOrderPaymentApprovalStage,
  getOrderPaymentApprovalLockStage,
} from "./orderPaymentApprovalStage";

function timeout(detail = "secret sql detail") {
  return Object.assign(new Error(detail), {
    errno: 1205,
    code: "ER_LOCK_WAIT_TIMEOUT",
    sqlState: "HY000",
  });
}

describe("IPE-020-C03 approval lock stage diagnostics", () => {
  it("wraps only lock wait timeouts with a fixed safe stage label", async () => {
    const driver = timeout();
    let caught: unknown;
    try {
      await atOrderPaymentApprovalStage("payment_lock", async () => {
        throw driver;
      });
    } catch (error) {
      caught = error;
    }

    expect(getOrderPaymentApprovalLockStage(caught)).toBe("payment_lock");
    expect((caught as Error).message).toBe(
      "ORDER_PAYMENT_APPROVAL_LOCK_STAGE:payment_lock"
    );
    expect((caught as any).cause).toBe(driver);
    expect((caught as Error).message).not.toContain("secret");
  });

  it("leaves non-1205 business errors byte-for-byte untouched", async () => {
    const original = new Error("SLIP_ALREADY_CLAIMED: existing owner");
    let caught: unknown;
    try {
      await atOrderPaymentApprovalStage("slip_claim", async () => {
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(getOrderPaymentApprovalLockStage(caught)).toBeUndefined();
  });

  it("the API mapper logs the safe wrapped stage while keeping the fixed client 503 contract", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let staged: unknown;
    try {
      await atOrderPaymentApprovalStage("points_user_lock", async () => {
        throw timeout("private driver detail");
      });
    } catch (error) {
      staged = error;
    }

    const mapped = mapOrderPaymentApprovalError(staged);
    expect(mapped).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: ORDER_PAYMENT_BUSY_MESSAGE,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("lock stage=points_user_lock")
    );
    expect(mapped.message).not.toContain("points_user_lock");
    log.mockRestore();
  });

  it("ignores arbitrary injected stage strings", () => {
    const untrusted = { approvalStage: "sql=select secret" };
    expect(getOrderPaymentApprovalLockStage(untrusted)).toBeUndefined();
  });
});
