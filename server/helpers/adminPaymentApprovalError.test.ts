import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  mapOrderPaymentApprovalError,
  mapOrderPaymentRecheckError,
  ORDER_PAYMENT_BUSY_MESSAGE,
} from "./adminPaymentApprovalError";

describe("mapOrderPaymentApprovalError", () => {
  it.each([
    ["SLIP_ALREADY_CLAIMED: claimed elsewhere", "CONFLICT"],
    ["NO_STRONG_IDENTIFIER: recheck required", "PRECONDITION_FAILED"],
    ["LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION: review required", "PRECONDITION_FAILED"],
  ])("preserves the established business mapping for %s", (message, code) => {
    expect(mapOrderPaymentApprovalError(new Error(message))).toMatchObject({ code, message });
  });

  it("preserves the prior BAD_REQUEST mapping for other deliberate business errors", () => {
    const mapped = mapOrderPaymentApprovalError(
      new Error("SLIP_CURRENT_BYTES_UNAVAILABLE: run Recheck OCR first")
    );
    expect(mapped).toMatchObject({
      code: "BAD_REQUEST",
      message: "SLIP_CURRENT_BYTES_UNAVAILABLE: run Recheck OCR first",
    });
  });

  it("maps a wrapped lock timeout to a fixed retryable response and retains the raw cause server-side", () => {
    const driver = Object.assign(new Error("Lock wait timeout exceeded; try restarting transaction"), {
      errno: 1205,
      code: "ER_LOCK_WAIT_TIMEOUT",
      sqlState: "HY000",
    });
    const wrapped = Object.assign(new Error("Failed query: update `payments` set `status` = ?\nparams: approved"), {
      cause: driver,
    });

    const mapped = mapOrderPaymentApprovalError(wrapped);

    expect(mapped).toBeInstanceOf(TRPCError);
    expect(mapped.code).toBe("SERVICE_UNAVAILABLE");
    expect(mapped.message).toBe(ORDER_PAYMENT_BUSY_MESSAGE);
    expect(mapped.message).not.toContain("payments");
    expect(mapped.cause).toBe(wrapped);
  });

  it("recognizes driver metadata even when the outer message has no SQL marker", () => {
    const wrapped = Object.assign(new Error("Query failed"), {
      cause: { errno: 1146, code: "ER_NO_SUCH_TABLE", sqlState: "42S02" },
    });

    expect(mapOrderPaymentApprovalError(wrapped)).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      cause: wrapped,
    });
  });
});

describe("mapOrderPaymentRecheckError", () => {
  it("preserves deliberate TRPC errors", () => {
    const original = new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
    expect(mapOrderPaymentRecheckError(original)).toBe(original);
  });

  it("maps wrapped 1205 to the same fixed retryable contract", () => {
    const driver = Object.assign(new Error("secret driver detail"), {
      errno: 1205,
      code: "ER_LOCK_WAIT_TIMEOUT",
      sqlState: "HY000",
    });
    const wrapped = Object.assign(new Error("Failed query"), { cause: driver });

    const mapped = mapOrderPaymentRecheckError(wrapped);
    expect(mapped).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: ORDER_PAYMENT_BUSY_MESSAGE,
      cause: wrapped,
    });
  });

  it("maps other unexpected failures to a fixed internal response", () => {
    const original = new Error("provider secret");
    const mapped = mapOrderPaymentRecheckError(original);
    expect(mapped).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to recheck this order payment due to an unexpected server error.",
      cause: original,
    });
    expect(mapped.message).not.toContain("secret");
  });
});
