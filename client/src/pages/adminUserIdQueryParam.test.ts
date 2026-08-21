import { describe, expect, it } from "vitest";
import {
  parseUserIdQueryParam,
  readUserIdFromSearchParams,
  syncUserIdInputFromUrl,
  withUserIdInputSearchParam,
  withUserIdSearchParam,
} from "./adminUserIdQueryParam";

// PR #45 review finding: AdminOrdersPage and AdminTopupLogsPage both read
// `?userId=` incorrectly (wouter's useLocation() never carries the query
// string in this app). Both pages now call these exact functions rather
// than a duplicated inline reimplementation - testing this module IS
// testing the pages' actual parsing/read/write behavior.

describe("parseUserIdQueryParam", () => {
  it('"123" -> 123', () => {
    expect(parseUserIdQueryParam("123")).toBe(123);
  });

  it("missing (undefined) -> undefined", () => {
    expect(parseUserIdQueryParam(undefined)).toBeUndefined();
  });

  it("null -> undefined", () => {
    expect(parseUserIdQueryParam(null)).toBeUndefined();
  });

  it("empty string -> undefined", () => {
    expect(parseUserIdQueryParam("")).toBeUndefined();
  });

  it('"0" -> undefined', () => {
    expect(parseUserIdQueryParam("0")).toBeUndefined();
  });

  it('"-1" -> undefined', () => {
    expect(parseUserIdQueryParam("-1")).toBeUndefined();
  });

  it('"1.5" -> undefined', () => {
    expect(parseUserIdQueryParam("1.5")).toBeUndefined();
  });

  it('"5abc" -> undefined (never silently truncated like parseInt would)', () => {
    expect(parseUserIdQueryParam("5abc")).toBeUndefined();
  });

  it('"  5" (leading whitespace) -> undefined - only an exact positive-integer literal is accepted', () => {
    expect(parseUserIdQueryParam("  5")).toBeUndefined();
  });

  it('"007" (leading zero) -> undefined - not a canonical positive-integer literal', () => {
    expect(parseUserIdQueryParam("007")).toBeUndefined();
  });
});

describe("readUserIdFromSearchParams", () => {
  it("reads a valid userId alongside other, unrelated params", () => {
    const params = new URLSearchParams("status=pending&userId=42&sortBy=createdAt");
    expect(readUserIdFromSearchParams(params)).toBe(42);
  });

  it("returns undefined when userId is absent, even with other params present", () => {
    const params = new URLSearchParams("status=pending&sortBy=createdAt");
    expect(readUserIdFromSearchParams(params)).toBeUndefined();
  });

  it("returns undefined when userId is present but invalid", () => {
    const params = new URLSearchParams("userId=5abc&status=pending");
    expect(readUserIdFromSearchParams(params)).toBeUndefined();
  });
});

describe("withUserIdSearchParam", () => {
  it("sets userId while preserving every other existing param", () => {
    const prev = new URLSearchParams("status=pending&sortBy=createdAt");
    const next = withUserIdSearchParam(prev, 42);
    expect(next.get("userId")).toBe("42");
    expect(next.get("status")).toBe("pending");
    expect(next.get("sortBy")).toBe("createdAt");
  });

  it("removes userId (undefined) while preserving every other existing param", () => {
    const prev = new URLSearchParams("status=pending&userId=42&sortBy=createdAt");
    const next = withUserIdSearchParam(prev, undefined);
    expect(next.has("userId")).toBe(false);
    expect(next.get("status")).toBe("pending");
    expect(next.get("sortBy")).toBe("createdAt");
  });

  it("removes userId (null) the same way as undefined", () => {
    const prev = new URLSearchParams("userId=42&status=pending");
    const next = withUserIdSearchParam(prev, null);
    expect(next.has("userId")).toBe(false);
    expect(next.get("status")).toBe("pending");
  });

  it("replaces an existing userId rather than appending a duplicate", () => {
    const prev = new URLSearchParams("userId=1");
    const next = withUserIdSearchParam(prev, 2);
    expect(next.getAll("userId")).toEqual(["2"]);
  });

  it("never mutates the input URLSearchParams", () => {
    const prev = new URLSearchParams("userId=1");
    withUserIdSearchParam(prev, 2);
    expect(prev.get("userId")).toBe("1");
  });

  it("adding then removing userId leaves every other param exactly as it started", () => {
    const original = new URLSearchParams("status=pending&sortBy=createdAt");
    const withUser = withUserIdSearchParam(original, 42);
    const withoutUser = withUserIdSearchParam(withUser, undefined);
    expect(withoutUser.toString()).toBe(original.toString());
  });
});

// PR #45 review finding "Synchronize edited top-up user IDs into the URL":
// AdminTopupLogsPage's User ID box updated only local state, so editing it
// from a `?userId=5` link showed user 6's rows under a URL still saying 5 -
// a refresh or a copied link then snapped back to 5. Its onChange now calls
// withUserIdInputSearchParam directly, so these tests exercise the page's
// real URL-writing behavior.
describe("withUserIdInputSearchParam", () => {
  it("replaces the id a link arrived with: userId=5 + input '6' -> userId=6", () => {
    const prev = new URLSearchParams("userId=5");
    const next = withUserIdInputSearchParam(prev, "6");
    expect(next.get("userId")).toBe("6");
  });

  it("a valid input preserves every other existing param", () => {
    const prev = new URLSearchParams("userId=5&startDate=2026-01-01&endDate=2026-02-01");
    const next = withUserIdInputSearchParam(prev, "6");
    expect(next.get("userId")).toBe("6");
    expect(next.get("startDate")).toBe("2026-01-01");
    expect(next.get("endDate")).toBe("2026-02-01");
  });

  it("an empty input removes userId, preserving every other param", () => {
    const prev = new URLSearchParams("userId=5&startDate=2026-01-01");
    const next = withUserIdInputSearchParam(prev, "");
    expect(next.has("userId")).toBe(false);
    expect(next.get("startDate")).toBe("2026-01-01");
  });

  it.each(["0", "-1", "1.5", "5abc", "007", "  5", "abc"])(
    "invalid input %j removes the stale userId instead of stranding it in the URL",
    (rawInput) => {
      const prev = new URLSearchParams("userId=5&startDate=2026-01-01");
      const next = withUserIdInputSearchParam(prev, rawInput);
      expect(next.has("userId")).toBe(false);
      expect(next.get("startDate")).toBe("2026-01-01");
    }
  );

  it("never appends a duplicate userId", () => {
    const prev = new URLSearchParams("userId=5");
    const next = withUserIdInputSearchParam(prev, "6");
    expect(next.getAll("userId")).toEqual(["6"]);
  });

  it("never mutates the input URLSearchParams", () => {
    const prev = new URLSearchParams("userId=5&status=pending");
    withUserIdInputSearchParam(prev, "6");
    expect(prev.get("userId")).toBe("5");
    expect(prev.toString()).toBe("userId=5&status=pending");
  });

  it("is idempotent - re-applying the same input yields an identical query string", () => {
    const prev = new URLSearchParams("userId=5&status=pending");
    const once = withUserIdInputSearchParam(prev, "6");
    const twice = withUserIdInputSearchParam(once, "6");
    expect(twice.toString()).toBe(once.toString());
  });

  it("is idempotent for the removal case too - no param churn on repeated invalid input", () => {
    const prev = new URLSearchParams("userId=5&status=pending");
    const once = withUserIdInputSearchParam(prev, "5abc");
    const twice = withUserIdInputSearchParam(once, "5abc");
    expect(twice.toString()).toBe(once.toString());
    expect(twice.has("userId")).toBe(false);
  });

  it("round-trips through readUserIdFromSearchParams: what is written back is what the API filter reads", () => {
    const written = withUserIdInputSearchParam(new URLSearchParams("userId=5"), "6");
    expect(readUserIdFromSearchParams(written)).toBe(6);

    const cleared = withUserIdInputSearchParam(written, "5abc");
    expect(readUserIdFromSearchParams(cleared)).toBeUndefined();
  });
});

// Guards the URL-to-state effect against clobbering the user's own typing
// once that typing writes to the URL (above). Without it, editing `5` into
// `5a` would drop the param, and the effect would instantly blank the box.
describe("syncUserIdInputFromUrl", () => {
  it("keeps half-typed invalid text when the URL correspondingly has no userId", () => {
    expect(syncUserIdInputFromUrl("5a", undefined)).toBe("5a");
  });

  it("returns the IDENTICAL string when the box already names the URL's id (setState bails, no loop)", () => {
    const currentInput = "6";
    expect(syncUserIdInputFromUrl(currentInput, 6)).toBe(currentInput);
  });

  it("adopts an externally-changed id (browser back/forward between filters)", () => {
    expect(syncUserIdInputFromUrl("6", 5)).toBe("5");
  });

  it("clears a valid box when the URL's userId is removed externally", () => {
    expect(syncUserIdInputFromUrl("5", undefined)).toBe("");
  });

  it("adopts an id arriving at an empty box (a fresh ?userId= link)", () => {
    expect(syncUserIdInputFromUrl("", 42)).toBe("42");
  });

  it("adopts the id when the box holds invalid text and the URL names a real one", () => {
    expect(syncUserIdInputFromUrl("5a", 5)).toBe("5");
  });

  it("leaves an empty box empty when the URL has no userId", () => {
    expect(syncUserIdInputFromUrl("", undefined)).toBe("");
  });

  it("is idempotent - re-running on its own output changes nothing", () => {
    const once = syncUserIdInputFromUrl("6", 5);
    expect(syncUserIdInputFromUrl(once, 5)).toBe(once);
  });
});
