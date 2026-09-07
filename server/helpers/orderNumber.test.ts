import { describe, expect, it } from "vitest";
import {
  formatOrderNumber,
  getOrderNumberBusinessDate,
  getOrderNumberSequenceSettingKey,
} from "./orderNumber";

describe("order number format", () => {
  it("formats YYYYMMDDXXX with a zero-padded daily sequence", () => {
    expect(formatOrderNumber("2026-09-07", 1)).toBe("20260907001");
    expect(formatOrderNumber("2026-09-07", 42)).toBe("20260907042");
    expect(formatOrderNumber("2026-09-07", 999)).toBe("20260907999");
  });

  it("uses the Bangkok business date rather than the server/UTC date", () => {
    expect(getOrderNumberBusinessDate(new Date("2026-09-06T18:30:00.000Z"))).toBe("2026-09-07");
  });

  it("uses a date-scoped internal sequence key", () => {
    expect(getOrderNumberSequenceSettingKey("2026-09-07")).toBe(
      "internal:order-number-sequence:2026-09-07",
    );
  });

  it("fails closed outside the three-digit sequence capacity", () => {
    expect(() => formatOrderNumber("2026-09-07", 0)).toThrow("Invalid order number sequence");
    expect(() => formatOrderNumber("2026-09-07", 1000)).toThrow("Invalid order number sequence");
  });
});
