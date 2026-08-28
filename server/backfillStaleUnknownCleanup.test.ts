/**
 * IPE-004-C03 P2: "A transient unknown that later resolves has its stale
 * unknown row removed/verified before a run may mark complete."
 *
 * `clearAndVerifyStaleUnknownRow` deletes a stale `paymentSlipLegacyUnknown`
 * record and re-reads to CONFIRM it is actually gone - a delete that throws,
 * or a row still visible afterward, is reported as a failure rather than
 * silently swallowed.
 */
import { describe, expect, it, vi } from "vitest";
import { clearAndVerifyStaleUnknownRow } from "../scripts/lib/backfillStaleUnknownCleanup.mjs";

describe("clearAndVerifyStaleUnknownRow", () => {
  it("delete succeeds and the row is confirmed gone on re-read -> cleared: true", async () => {
    const deleteRow = vi.fn().mockResolvedValue(undefined);
    const checkStillPresent = vi.fn().mockResolvedValue(false);

    const result = await clearAndVerifyStaleUnknownRow({ deleteRow, checkStillPresent });

    expect(result.cleared).toBe(true);
    expect(result.error).toBeUndefined();
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(checkStillPresent).toHaveBeenCalledTimes(1);
  });

  it("delete THROWS -> cleared: false, error captured, never swallowed", async () => {
    const error: any = new Error("connection lost");
    error.code = "ER_LOCK_WAIT_TIMEOUT";
    const deleteRow = vi.fn().mockRejectedValue(error);
    const checkStillPresent = vi.fn();

    const result = await clearAndVerifyStaleUnknownRow({ deleteRow, checkStillPresent });

    expect(result.cleared).toBe(false);
    expect(result.error).toBe("ER_LOCK_WAIT_TIMEOUT");
    // The delete itself failed - re-reading is pointless and never attempted.
    expect(checkStillPresent).not.toHaveBeenCalled();
  });

  it("delete succeeds but the row is STILL present on re-read -> cleared: false, not silently accepted", async () => {
    const deleteRow = vi.fn().mockResolvedValue(undefined);
    const checkStillPresent = vi.fn().mockResolvedValue(true);

    const result = await clearAndVerifyStaleUnknownRow({ deleteRow, checkStillPresent });

    expect(result.cleared).toBe(false);
    expect(result.error).toBe("row still present after delete");
  });

  it("a thrown error with no .code falls back to .message, never leaves error undefined on failure", async () => {
    const deleteRow = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await clearAndVerifyStaleUnknownRow({
      deleteRow,
      checkStillPresent: vi.fn(),
    });

    expect(result.cleared).toBe(false);
    expect(result.error).toBe("boom");
  });
});
