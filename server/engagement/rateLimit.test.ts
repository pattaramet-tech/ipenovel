import { describe, expect, it } from "vitest";
import { computeWindowStart, evaluateRateLimit } from "./rateLimit";

const MINUTE = 60_000;

describe("computeWindowStart (fixed window)", () => {
  it("buckets by floor(now/windowMs)*windowMs", () => {
    expect(computeWindowStart(0, MINUTE)).toBe(0);
    expect(computeWindowStart(59_999, MINUTE)).toBe(0);
    expect(computeWindowStart(60_000, MINUTE)).toBe(60_000); // exact boundary -> NEW window
    expect(computeWindowStart(119_999, MINUTE)).toBe(60_000);
    expect(computeWindowStart(120_000, MINUTE)).toBe(120_000);
  });
  it("rejects invalid inputs", () => {
    expect(() => computeWindowStart(-1, MINUTE)).toThrow();
    expect(() => computeWindowStart(Number.NaN, MINUTE)).toThrow();
    expect(() => computeWindowStart(0, 0)).toThrow();
    expect(() => computeWindowStart(0, -5)).toThrow();
    expect(() => computeWindowStart(0, 1.5)).toThrow();
  });
  it("REGRESSION (R1): rejects non-integer / unsafe epoch-ms and window sizes", () => {
    for (const badNow of [1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, "0" as unknown as number]) {
      expect(() => computeWindowStart(badNow, MINUTE)).toThrow(/now/);
    }
    for (const badWindow of [0, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53, null as unknown as number]) {
      expect(() => computeWindowStart(0, badWindow)).toThrow(/windowMs/);
    }
  });
});

describe("evaluateRateLimit (quota decision + retry-after)", () => {
  it("allows while count < limit and reports remaining AFTER the attempt", () => {
    const d1 = evaluateRateLimit({ now: 1_000, windowMs: MINUTE, limit: 3, count: 0 });
    expect(d1).toEqual({ allowed: true, remaining: 2, retryAfterSeconds: 0 });
    const d2 = evaluateRateLimit({ now: 2_000, windowMs: MINUTE, limit: 3, count: 2 });
    expect(d2).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
  });
  it("blocks at count >= limit with retryAfter until the window ends", () => {
    const d = evaluateRateLimit({ now: 20_000, windowMs: MINUTE, limit: 3, count: 3 });
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterSeconds).toBe(40); // window ends at 60_000
  });
  it("retryAfter counts whole seconds upward", () => {
    // 40_500ms remaining -> ceil to 41
    const d = evaluateRateLimit({ now: 19_500, windowMs: MINUTE, limit: 1, count: 1 });
    expect(d.retryAfterSeconds).toBe(41);
  });
  it("boundary: blocked exactly at the last ms of a window still answers >= 1s (never 0)", () => {
    const d = evaluateRateLimit({ now: 60_000 - 1, windowMs: MINUTE, limit: 1, count: 1 });
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(1); // 1ms left, clamped up to 1s
  });
  it("boundary: the first ms of a NEW window resets the budget", () => {
    // same wall-clock story as the blocked test above, one ms later
    const d = evaluateRateLimit({ now: 60_000, windowMs: MINUTE, limit: 1, count: 0 });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(0);
  });
  it("rejects invalid limit/count", () => {
    expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: 0, count: 0 })).toThrow();
    expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: -1, count: 0 })).toThrow();
    expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: 1, count: -1 })).toThrow();
    expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: 1, count: 1.5 })).toThrow();
  });
  it("REGRESSION (R1): invalid now/windowMs are rejected on EVERY path - even when quota remains", () => {
    // the allowed path (count < limit) previously never touched the window
    // math, letting a broken clock or window slip through until the first
    // block; validation now runs before any decision
    for (const bad of [
      { now: Number.NaN, windowMs: MINUTE },
      { now: 1.5, windowMs: MINUTE },
      { now: Number.POSITIVE_INFINITY, windowMs: MINUTE },
      { now: -1, windowMs: MINUTE },
      { now: 2 ** 53, windowMs: MINUTE },
      { now: 1_000, windowMs: 0 },
      { now: 1_000, windowMs: -5 },
      { now: 1_000, windowMs: 1.5 },
      { now: 1_000, windowMs: 2 ** 53 },
    ]) {
      expect(() => evaluateRateLimit({ ...bad, limit: 5, count: 0 })).toThrow(); // allowed-path validation
      expect(() => evaluateRateLimit({ ...bad, limit: 5, count: 5 })).toThrow(); // blocked-path validation
    }
  });
  it("REGRESSION (R1): limit and count must be safe integers", () => {
    for (const badLimit of [2 ** 53, Number.POSITIVE_INFINITY, NaN, 1.5]) {
      expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: badLimit, count: 0 })).toThrow(/limit/);
    }
    for (const badCount of [2 ** 53, Number.POSITIVE_INFINITY, NaN, -1, 0.5]) {
      expect(() => evaluateRateLimit({ now: 0, windowMs: MINUTE, limit: 1, count: badCount })).toThrow(/count/);
    }
  });
  it("PD-04 approved shapes: feedback 3/10min and comment 5/min behave as configured", () => {
    const TEN_MIN = 10 * MINUTE;
    // feedback: 3rd attempt passes, 4th within the same window blocks
    expect(evaluateRateLimit({ now: 5_000, windowMs: TEN_MIN, limit: 3, count: 2 }).allowed).toBe(true);
    const blocked = evaluateRateLimit({ now: 6_000, windowMs: TEN_MIN, limit: 3, count: 3 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(594);
    // comment: 5/min
    expect(evaluateRateLimit({ now: 1_000, windowMs: MINUTE, limit: 5, count: 4 }).allowed).toBe(true);
    expect(evaluateRateLimit({ now: 2_000, windowMs: MINUTE, limit: 5, count: 5 }).allowed).toBe(false);
  });
});
