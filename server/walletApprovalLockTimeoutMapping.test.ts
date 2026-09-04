import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  mapWalletApprovalError,
  WALLET_APPROVAL_BUSY_MESSAGE,
} from "./services/walletService";
import { atWalletApprovalStage } from "./helpers/walletApprovalStage";

function timeout(detail = "Failed query: select secret") {
  return Object.assign(new Error(detail), {
    errno: 1205,
    code: "ER_LOCK_WAIT_TIMEOUT",
    sqlState: "HY000",
  });
}

describe("IPE-020-C04 wallet approval 1205 API parity", () => {
  it("maps raw 1205 to a fixed retryable 503 contract", () => {
    const original = timeout();
    const mapped = mapWalletApprovalError(original);
    expect(mapped).toBeInstanceOf(TRPCError);
    expect(mapped).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: WALLET_APPROVAL_BUSY_MESSAGE,
      cause: original,
    });
    expect(mapped.message).not.toContain("query");
    expect(mapped.message).not.toContain("secret");
  });

  it("preserves the stage wrapper while keeping stage/internal detail out of the client message", async () => {
    let wrapped: unknown;
    try {
      await atWalletApprovalStage("wallet_topup_lock", async () => {
        throw timeout();
      });
    } catch (error) {
      wrapped = error;
    }

    const mapped = mapWalletApprovalError(wrapped);
    expect(mapped).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: WALLET_APPROVAL_BUSY_MESSAGE,
      cause: wrapped,
    });
    expect(mapped.message).not.toContain("wallet_topup_lock");
  });
});
