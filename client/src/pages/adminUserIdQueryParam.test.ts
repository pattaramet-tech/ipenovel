import { describe, expect, it } from "vitest";
import {
  parseUserIdQueryParam,
  readUserIdFromSearchParams,
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
