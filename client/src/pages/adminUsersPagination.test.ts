import { describe, expect, it } from "vitest";
import { computePaginationClamp } from "./adminUsersPagination";

// PR #45 review finding "Reset pages that become out of range" -
// AdminUsersPage.tsx's pagination-clamp effect calls this exact function;
// these tests exercise the real decision logic directly (no component
// render harness available in this repo's Node-only unit test project -
// see adminUsersPagination.ts's own top-of-file docstring).
describe("computePaginationClamp", () => {
  it("[out-of-range after edit] current page 2, server totalPages 1 -> clamps to page 1", () => {
    expect(computePaginationClamp(2, 1)).toEqual({ shouldUpdate: true, nextPage: 1 });
  });

  it("[shrunk to genuinely empty] current page 3, server totalPages 0 -> normalizes to page 1", () => {
    expect(computePaginationClamp(3, 0)).toEqual({ shouldUpdate: true, nextPage: 1 });
  });

  it("[already-empty, already on page 1] current page 1, server totalPages 0 -> stays on page 1, no update", () => {
    expect(computePaginationClamp(1, 0)).toEqual({ shouldUpdate: false });
  });

  it("[still in range] current page 2, server totalPages 2 -> no change", () => {
    expect(computePaginationClamp(2, 2)).toEqual({ shouldUpdate: false });
  });

  it("[still in range, first page] current page 1, server totalPages 5 -> no change", () => {
    expect(computePaginationClamp(1, 5)).toEqual({ shouldUpdate: false });
  });

  it("[far out of range] current page 40, server totalPages 3 -> clamps to the actual last page", () => {
    expect(computePaginationClamp(40, 3)).toEqual({ shouldUpdate: true, nextPage: 3 });
  });

  it("[idempotent / no repeat-update loop] applying the clamp result again never requests a further change", () => {
    const first = computePaginationClamp(2, 1);
    expect(first).toEqual({ shouldUpdate: true, nextPage: 1 });
    if (!first.shouldUpdate) throw new Error("unreachable");
    const second = computePaginationClamp(first.nextPage, 1);
    expect(second).toEqual({ shouldUpdate: false });
  });

  it("a currentPage below 1 (defensive - should not occur via normal UI controls) is still clamped up to 1", () => {
    expect(computePaginationClamp(0, 5)).toEqual({ shouldUpdate: true, nextPage: 1 });
  });
});
