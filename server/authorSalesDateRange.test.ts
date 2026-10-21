import { describe, expect, it } from "vitest";
import {
  isValidIsoCalendarDate,
  resolveAuthorSalesCustomRange,
  resolveAuthorSalesRange,
} from "./db";

describe("IPE-070 isValidIsoCalendarDate", () => {
  it("accepts real calendar days in YYYY-MM-DD", () => {
    expect(isValidIsoCalendarDate("2024-01-15")).toBe(true);
    expect(isValidIsoCalendarDate("2024-02-29")).toBe(true); // leap day
    expect(isValidIsoCalendarDate("2024-12-31")).toBe(true);
    expect(isValidIsoCalendarDate("2023-02-28")).toBe(true);
  });

  it("rejects impossible dates that JS Date would silently normalize", () => {
    expect(isValidIsoCalendarDate("2023-02-29")).toBe(false); // non-leap leap day
    expect(isValidIsoCalendarDate("2024-02-30")).toBe(false);
    expect(isValidIsoCalendarDate("2024-04-31")).toBe(false);
    expect(isValidIsoCalendarDate("2024-13-01")).toBe(false);
    expect(isValidIsoCalendarDate("2024-00-10")).toBe(false);
    expect(isValidIsoCalendarDate("2024-01-00")).toBe(false);
  });

  it("rejects malformed shapes and non-strings", () => {
    expect(isValidIsoCalendarDate("2024-1-5")).toBe(false);
    expect(isValidIsoCalendarDate("20240115")).toBe(false);
    expect(isValidIsoCalendarDate("2024/01/15")).toBe(false);
    expect(isValidIsoCalendarDate("")).toBe(false);
    expect(isValidIsoCalendarDate("2024-01-15T00:00:00Z")).toBe(false);
    expect(isValidIsoCalendarDate(null)).toBe(false);
    expect(isValidIsoCalendarDate(undefined)).toBe(false);
    expect(isValidIsoCalendarDate(20240115)).toBe(false);
  });
});

describe("IPE-070 resolveAuthorSalesCustomRange", () => {
  it("resolves a single day to the exact Bangkok midnight bounds (end-exclusive)", () => {
    // Bangkok is a fixed UTC+7: local 2024-01-15 00:00 == 2024-01-14T17:00Z.
    const { start, end } = resolveAuthorSalesCustomRange("2024-01-15", "2024-01-15");
    expect(start.toISOString()).toBe("2024-01-14T17:00:00.000Z");
    expect(end.toISOString()).toBe("2024-01-15T17:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("resolves a multi-day range inclusive of both end days", () => {
    const { start, end } = resolveAuthorSalesCustomRange("2024-01-14", "2024-01-15");
    expect(start.toISOString()).toBe("2024-01-13T17:00:00.000Z");
    expect(end.toISOString()).toBe("2024-01-15T17:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(48 * 60 * 60 * 1000);
  });

  it("rolls over month and year boundaries", () => {
    const { start, end } = resolveAuthorSalesCustomRange("2024-12-31", "2025-01-01");
    expect(start.toISOString()).toBe("2024-12-30T17:00:00.000Z");
    expect(end.toISOString()).toBe("2025-01-01T17:00:00.000Z");
  });

  it("handles leap-day ranges", () => {
    const { start, end } = resolveAuthorSalesCustomRange("2024-02-28", "2024-02-29");
    expect(start.toISOString()).toBe("2024-02-27T17:00:00.000Z");
    expect(end.toISOString()).toBe("2024-02-29T17:00:00.000Z");
  });

  it("rejects impossible calendar dates without normalizing them", () => {
    for (const [startDate, endDate] of [
      ["2023-02-29", "2023-02-29"],
      ["2024-02-30", "2024-02-30"],
      ["2024-13-01", "2024-13-05"],
      ["garbage", "2024-01-15"],
      ["2024-01-15", "garbage"],
    ]) {
      try {
        resolveAuthorSalesCustomRange(startDate, endDate);
        expect.unreachable(`${startDate}..${endDate} should have been rejected`);
      } catch (error: any) {
        expect(error.statusCode).toBe(400);
      }
    }
  });

  it("rejects a reversed range", () => {
    try {
      resolveAuthorSalesCustomRange("2024-01-15", "2024-01-14");
      expect.unreachable("reversed range should have been rejected");
    } catch (error: any) {
      expect(error.statusCode).toBe(400);
    }
  });
});

describe("IPE-070 resolveAuthorSalesRange", () => {
  it("delegates the preset contract to the shared dashboard semantics", () => {
    expect(resolveAuthorSalesRange("all", undefined)).toBeNull();
    // "month" preset: local first of this month → first of next month,
    // computed here with the same local-midnight expressions as
    // resolveDashboardRange so the expectation is timezone-agnostic.
    const now = new Date();
    const expectedStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const expectedEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const resolved = resolveAuthorSalesRange("month", undefined);
    expect(resolved?.start.getTime()).toBe(expectedStart.getTime());
    expect(resolved?.end.getTime()).toBe(expectedEnd.getTime());
  });

  it("resolves custom_month exactly like the dashboard does", () => {
    const resolved = resolveAuthorSalesRange("custom_month", "2024-01");
    expect(resolved?.start.getTime()).toBe(new Date("2024-01-01T00:00:00").getTime());
    expect(resolved?.end.getTime()).toBe(new Date(2024, 1, 1).getTime());
  });

  it("prefers a complete custom pair over the preset", () => {
    const resolved = resolveAuthorSalesRange("month", undefined, "2024-01-15", "2024-01-15");
    expect(resolved?.start.toISOString()).toBe("2024-01-14T17:00:00.000Z");
    expect(resolved?.end.toISOString()).toBe("2024-01-15T17:00:00.000Z");
  });

  it("rejects a half-supplied pair instead of silently falling back", () => {
    for (const args of [
      ["2024-01-15", undefined],
      [undefined, "2024-01-15"],
    ] as const) {
      try {
        resolveAuthorSalesRange("month", undefined, args[0], args[1]);
        expect.unreachable("incomplete pair should have been rejected");
      } catch (error: any) {
        expect(error.statusCode).toBe(400);
      }
    }
  });

  it("rejects the custom_range preset without a complete pair", () => {
    try {
      resolveAuthorSalesRange("custom_range", undefined);
      expect.unreachable("custom_range without bounds should have been rejected");
    } catch (error: any) {
      expect(error.statusCode).toBe(400);
    }
  });
});
