/**
 * IPE-004-C04 P2: behavioral coverage for selectPendingClearsToApply - the
 * pure decision logic behind "a previously-unknown row's stale record is
 * cleared only after its file-axis collision finding is confirmed durably
 * written, regardless of which of the three accumulation sites first
 * deferred it."
 */
import { describe, expect, it } from "vitest";
import { selectPendingClearsToApply } from "../scripts/lib/backfillPendingUnknownClearScheduler.mjs";

describe("selectPendingClearsToApply", () => {
  it("registry-collision-path deferral: cleared only once the durable write succeeded", () => {
    const pending = [{ sourceType: "payment", sourceId: 101 }];
    const succeededBeforeWrite = new Set<string>(); // finalizeCollisionRegistry has not run yet
    expect(selectPendingClearsToApply(pending, succeededBeforeWrite)).toEqual([]);

    const succeededAfterWrite = new Set(["payment#101#file"]);
    expect(selectPendingClearsToApply(pending, succeededAfterWrite)).toEqual([
      { sourceType: "payment", sourceId: 101 },
    ]);
  });

  it("in-run tracker collision path: same deferred-then-confirmed behavior", () => {
    const pending = [{ sourceType: "walletTopup", sourceId: 202 }];
    expect(selectPendingClearsToApply(pending, new Set())).toEqual([]);
    expect(
      selectPendingClearsToApply(pending, new Set(["walletTopup#202#file"]))
    ).toEqual([{ sourceType: "walletTopup", sourceId: 202 }]);
  });

  it("duplicate-insert re-read collision path: same deferred-then-confirmed behavior", () => {
    const pending = [{ sourceType: "payment", sourceId: 303 }];
    expect(selectPendingClearsToApply(pending, new Set())).toEqual([]);
    expect(
      selectPendingClearsToApply(pending, new Set(["payment#303#file"]))
    ).toEqual([{ sourceType: "payment", sourceId: 303 }]);
  });

  it("a collision write that FAILED (member not in succeeded set) leaves the pending clear unapplied", () => {
    const pending = [{ sourceType: "payment", sourceId: 404 }];
    // finalizeCollisionRegistry ran, but this specific member's write failed
    // (e.g. a DB error recording the collision member) - it must not appear
    // in succeededMemberKeys, and the stale unknown row must stay untouched.
    const succeededForOtherSource = new Set(["payment#999#file"]);
    expect(selectPendingClearsToApply(pending, succeededForOtherSource)).toEqual([]);
  });

  it("a succeeded member on a DIFFERENT axis (not file) does not authorize the clear", () => {
    const pending = [{ sourceType: "payment", sourceId: 505 }];
    // Only the reference axis collision was durably recorded for this
    // source - the file axis (what the unknown row is actually about) never
    // succeeded, so the clear must not be applied.
    const succeeded = new Set(["payment#505#reference"]);
    expect(selectPendingClearsToApply(pending, succeeded)).toEqual([]);
  });

  it("the same source deferred from multiple accumulation sites is cleared exactly once", () => {
    const pending = [
      { sourceType: "payment", sourceId: 606 },
      { sourceType: "payment", sourceId: 606 },
      { sourceType: "payment", sourceId: 606 },
    ];
    const succeeded = new Set(["payment#606#file"]);
    expect(selectPendingClearsToApply(pending, succeeded)).toEqual([
      { sourceType: "payment", sourceId: 606 },
    ]);
  });

  it("multiple distinct sources are each evaluated independently", () => {
    const pending = [
      { sourceType: "payment", sourceId: 1 },
      { sourceType: "payment", sourceId: 2 },
      { sourceType: "walletTopup", sourceId: 1 }, // same numeric id, different sourceType
    ];
    const succeeded = new Set(["payment#1#file", "walletTopup#1#file"]);
    expect(selectPendingClearsToApply(pending, succeeded)).toEqual([
      { sourceType: "payment", sourceId: 1 },
      { sourceType: "walletTopup", sourceId: 1 },
    ]);
  });

  it("empty pending list -> nothing to apply, regardless of succeeded set", () => {
    expect(selectPendingClearsToApply([], new Set(["payment#1#file"]))).toEqual([]);
  });
});
