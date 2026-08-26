import { describe, expect, it } from "vitest";
import {
  DATE_ONLY_MINIMUM_WINDOW_MINUTES,
  effectiveFreshnessWindowMinutes,
  isWithinFreshnessWindow,
  normalizeConfiguredWindowMinutes,
} from "@shared/slipFreshness";

/**
 * The freshness allowance rule, shared by server verification and the admin
 * presentation model precisely so the two cannot drift.
 *
 * The bug this closes: the server granted a DATE-ONLY result at least 1440
 * minutes, while the panel compared every result against the configured
 * window - so a date-only transfer submitted later the same day passed
 * verification but was rendered as a FAILED freshness check.
 */

describe("effectiveFreshnessWindowMinutes", () => {
  it("a result WITH a transaction time uses the configured window", () => {
    expect(effectiveFreshnessWindowMinutes(120, true)).toBe(120);
  });

  it("a DATE-ONLY result is granted at least a full day", () => {
    expect(effectiveFreshnessWindowMinutes(120, false)).toBe(DATE_ONLY_MINIMUM_WINDOW_MINUTES);
    expect(effectiveFreshnessWindowMinutes(120, false)).toBe(1440);
  });

  it("a configured window LARGER than a day wins for date-only results", () => {
    // The floor raises a too-small window; it never caps a generous one.
    expect(effectiveFreshnessWindowMinutes(2000, false)).toBe(2000);
  });

  it("a configured window larger than a day is unaffected when a time exists", () => {
    expect(effectiveFreshnessWindowMinutes(2000, true)).toBe(2000);
  });

  it("clamps an absurdly small configured window to the floor", () => {
    expect(effectiveFreshnessWindowMinutes(1, true)).toBe(5);
  });

  it("falls back to the default when configuration is missing or non-finite", () => {
    expect(effectiveFreshnessWindowMinutes(undefined, true)).toBe(120);
    expect(effectiveFreshnessWindowMinutes(null, true)).toBe(120);
    expect(effectiveFreshnessWindowMinutes(Number.NaN, true)).toBe(120);
  });
});

describe("normalizeConfiguredWindowMinutes", () => {
  it("passes a sane value through", () => {
    expect(normalizeConfiguredWindowMinutes(240)).toBe(240);
  });

  it("raises anything below the floor", () => {
    expect(normalizeConfiguredWindowMinutes(0)).toBe(5);
    expect(normalizeConfiguredWindowMinutes(-100)).toBe(5);
  });
});

describe("isWithinFreshnessWindow", () => {
  it("accepts a gap inside the allowance", () => {
    expect(isWithinFreshnessWindow(30, 120)).toBe(true);
  });

  it("accepts a gap exactly at the allowance", () => {
    expect(isWithinFreshnessWindow(120, 120)).toBe(true);
  });

  it("rejects a gap beyond the allowance", () => {
    expect(isWithinFreshnessWindow(121, 120)).toBe(false);
  });

  it("tolerates small negative clock skew", () => {
    expect(isWithinFreshnessWindow(-3, 120)).toBe(true);
  });

  it("rejects a transaction implausibly far in the future", () => {
    expect(isWithinFreshnessWindow(-60, 120)).toBe(false);
  });
});

describe("the exact scenarios the server/UI disagreed on", () => {
  it("configured=120, DATE-ONLY, gap=600 min -> allowed (both sides)", () => {
    const allowance = effectiveFreshnessWindowMinutes(120, false);
    expect(allowance).toBe(1440);
    expect(isWithinFreshnessWindow(600, allowance)).toBe(true);
  });

  it("configured=120, WITH TIME, gap=600 min -> refused (both sides)", () => {
    const allowance = effectiveFreshnessWindowMinutes(120, true);
    expect(allowance).toBe(120);
    expect(isWithinFreshnessWindow(600, allowance)).toBe(false);
  });

  it("configured=2000, DATE-ONLY uses 2000, not 1440", () => {
    expect(effectiveFreshnessWindowMinutes(2000, false)).toBe(2000);
  });
});
