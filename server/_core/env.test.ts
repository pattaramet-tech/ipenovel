import { afterEach, describe, expect, it } from "vitest";
import {
  ENV,
  evaluateGoogleConnectionCutoff,
  resolveAuthProviderMode,
  resolveForceReloginCutoffSeconds,
  resolveGoogleConnectionCutoffAfterMs,
  resolveRequireGoogleConnection,
} from "./env";

describe("resolveAuthProviderMode - EXACT LITERAL ONLY, no trim/toLowerCase/toUpperCase", () => {
  it('"manus" -> "manus"', () => {
    expect(resolveAuthProviderMode("manus")).toBe("manus");
  });

  it('"google" -> "google"', () => {
    expect(resolveAuthProviderMode("google")).toBe("google");
  });

  it('"transition" -> "transition"', () => {
    expect(resolveAuthProviderMode("transition")).toBe("transition");
  });

  it.each([
    undefined,
    "",
    "GOOGLE",
    "Google",
    "Transition",
    " transition",
    "transition ",
    "google ",
    " google",
    "typo",
    "Manus",
    "MANUS",
    " manus",
    "manus ",
    "\ttransition",
    "transition\n",
  ])("%j -> \"manus\" (never normalized, never accepted as a near-miss)", (raw) => {
    expect(resolveAuthProviderMode(raw)).toBe("manus");
  });

  it("does not call .trim()/.toLowerCase()/.toUpperCase() on its input - a value that would only match after normalization must still resolve to manus", () => {
    // Precision check for the exact regression this function's docstring
    // guards against: an earlier version of this logic trimmed and
    // lowercased before comparing, so " GOOGLE " would have silently
    // resolved to "google". It must not anymore.
    expect(resolveAuthProviderMode(" GOOGLE ")).toBe("manus");
    expect(resolveAuthProviderMode(" TRANSITION ")).toBe("manus");
  });
});

describe("resolveRequireGoogleConnection - EXACT LITERAL \"true\" ONLY", () => {
  it('"true" -> true', () => {
    expect(resolveRequireGoogleConnection("true")).toBe(true);
  });

  it.each([undefined, "", "TRUE", "True", " true", "true ", "1", "yes", "false"])(
    "%j -> false",
    (raw) => {
      expect(resolveRequireGoogleConnection(raw)).toBe(false);
    }
  );
});

describe("resolveForceReloginCutoffSeconds - strict ISO-8601 UTC, null on anything invalid", () => {
  it("a valid ISO-8601 UTC timestamp resolves to the correct epoch seconds", () => {
    const result = resolveForceReloginCutoffSeconds("2026-08-01T00:00:00Z");
    expect(result).toBe(Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000));
    expect(result).not.toBeNull();
  });

  it("accepts an optional fractional-seconds component", () => {
    const result = resolveForceReloginCutoffSeconds("2026-08-01T00:00:00.123Z");
    expect(result).toBe(Math.floor(Date.parse("2026-08-01T00:00:00.123Z") / 1000));
  });

  it.each([undefined, ""])("%j (empty/unset) -> null (disabled), never a mass-logout cutoff", (raw) => {
    expect(resolveForceReloginCutoffSeconds(raw)).toBeNull();
  });

  it.each([
    "not-a-date",
    "2026-08-01",
    "2026-08-01 00:00:00",
    "2026/08/01T00:00:00Z",
    "2026-08-01T00:00:00+07:00",
    "2026-08-01T00:00:00",
    "tomorrow",
    "0",
    "2026-13-01T00:00:00Z",
  ])("invalid/malformed value %j -> null (disabled) - NEVER epoch 0 or 'now', which would force a mass logout", (raw) => {
    expect(resolveForceReloginCutoffSeconds(raw)).toBeNull();
  });

  describe("strict calendar-date validation (Date.UTC round-trip, never Date.parse's silent normalization)", () => {
    it.each([
      "2026-02-30T00:00:00Z", // February never has 30 days
      "2025-02-29T00:00:00Z", // 2025 is not a leap year
      "2026-04-31T00:00:00Z", // April has 30 days
      "2026-13-01T00:00:00Z", // month 13 does not exist
      "2026-00-01T00:00:00Z", // month 0 does not exist
      "2026-01-00T00:00:00Z", // day 0 does not exist
      "2026-01-01T24:00:00Z", // hour 24 does not exist (00-23 only)
      "2026-01-01T00:60:00Z", // minute 60 does not exist (00-59 only)
      "2026-01-01T00:00:60Z", // second 60 does not exist (00-59 only, no leap-second support)
    ])("rejects the nonexistent calendar date/time %j -> null, never silently normalized to a nearby real date", (raw) => {
      expect(resolveForceReloginCutoffSeconds(raw)).toBeNull();
    });

    it("accepts 2024-02-29 (2024 IS a leap year)", () => {
      const result = resolveForceReloginCutoffSeconds("2024-02-29T00:00:00Z");
      expect(result).not.toBeNull();
      expect(result).toBe(Math.floor(Date.UTC(2024, 1, 29, 0, 0, 0) / 1000));
    });

    it("a year expressed as 4 digits in the 0-99 range (an edge case only, never realistic for this feature) still validates correctly - the +400 round-trip shift never itself causes a false rejection or a false acceptance", () => {
      // Year 99 is NOT divisible by 4, so it is not a leap year under any
      // version of the rule - Feb 29 must still correctly reject.
      expect(resolveForceReloginCutoffSeconds("0099-02-29T00:00:00Z")).toBeNull();
      // 0099-02-28 is a real date and must be accepted.
      expect(resolveForceReloginCutoffSeconds("0099-02-28T00:00:00Z")).not.toBeNull();
      // Year 100 IS divisible by 4, but is a century year not divisible by
      // 400, so it is NOT a leap year (the century exception) - proves the
      // round-trip shift didn't collapse the full three-part leap-year rule
      // into a simpler "divisible by 4" check.
      expect(resolveForceReloginCutoffSeconds("0100-02-29T00:00:00Z")).toBeNull();
      expect(resolveForceReloginCutoffSeconds("0100-02-28T00:00:00Z")).not.toBeNull();
    });

    it("accepts a timestamp with fractional seconds representing a real date/time", () => {
      const result = resolveForceReloginCutoffSeconds("2026-08-01T12:30:45.500Z");
      expect(result).not.toBeNull();
      expect(result).toBe(Math.floor(Date.UTC(2026, 7, 1, 12, 30, 45, 500) / 1000));
    });
  });
});

describe("resolveGoogleConnectionCutoffAfterMs", () => {
  it("unset/empty -> null (disabled), never throws", () => {
    expect(resolveGoogleConnectionCutoffAfterMs(undefined)).toBeNull();
    expect(resolveGoogleConnectionCutoffAfterMs("")).toBeNull();
    expect(resolveGoogleConnectionCutoffAfterMs("   ")).toBeNull();
  });

  it("a valid strict ISO-8601 UTC timestamp resolves to the correct epoch milliseconds", () => {
    const result = resolveGoogleConnectionCutoffAfterMs("2026-08-15T18:00:00Z");
    expect(result).toBe(Date.UTC(2026, 7, 15, 18, 0, 0));
  });

  it.each([
    "not-a-date",
    "2026-08-15",
    "2026-08-15T18:00:00+07:00",
    "2026-02-30T00:00:00Z",
    "2026-01-01T24:00:00Z",
  ])("a SET but malformed/nonexistent value %j -> throws (never silently null, never silently 'now')", (raw) => {
    expect(() => resolveGoogleConnectionCutoffAfterMs(raw)).toThrow();
  });

  it("the thrown error message names the offending value, for operator debugging, but is a plain config error (not a secret)", () => {
    expect(() => resolveGoogleConnectionCutoffAfterMs("garbage")).toThrow(/AUTH_REQUIRE_GOOGLE_CONNECTION_AFTER/);
    expect(() => resolveGoogleConnectionCutoffAfterMs("garbage")).toThrow(/garbage/);
  });
});

describe("evaluateGoogleConnectionCutoff - single source of truth for the targeted Google-connection gate", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;
  const originalCutoff = ENV.googleConnectionCutoffAfterMs;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
    ENV.googleConnectionCutoffAfterMs = originalCutoff;
  });

  it("[rule 1] requireGoogleConnection=false -> enabled=false, activeNow=false, regardless of provider/cutoff", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = false;
    ENV.googleConnectionCutoffAfterMs = null;
    const result = evaluateGoogleConnectionCutoff(1_000_000);
    expect(result.enabled).toBe(false);
    expect(result.activeNow).toBe(false);
  });

  it("[rule 2] requireGoogleConnection=true, no cutoff configured -> enabled=true, activeNow=true immediately (backward compatible)", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = null;
    const result = evaluateGoogleConnectionCutoff(1_000_000);
    expect(result.enabled).toBe(true);
    expect(result.activeNow).toBe(true);
    expect(result.cutoffAt).toBeNull();
  });

  it("[rule 3] requireGoogleConnection=true, cutoff in the future -> enabled=true, activeNow=false until reached", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = 2_000_000;
    const before = evaluateGoogleConnectionCutoff(1_000_000);
    expect(before.enabled).toBe(true);
    expect(before.activeNow).toBe(false);
  });

  it("exact cutoff time (now === cutoff) -> active", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = 2_000_000;
    expect(evaluateGoogleConnectionCutoff(2_000_000).activeNow).toBe(true);
  });

  it("past cutoff (now > cutoff) -> active", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = 2_000_000;
    expect(evaluateGoogleConnectionCutoff(3_000_000).activeNow).toBe(true);
  });

  it("[rule 7] AUTH_PROVIDER=transition -> can be enabled", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = null;
    expect(evaluateGoogleConnectionCutoff().enabled).toBe(true);
  });

  it("[rule 7] AUTH_PROVIDER=google -> can ALSO be enabled (broadened from the old transition-only isGoogleConnectionMandatory)", () => {
    ENV.authProvider = "google";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = null;
    expect(evaluateGoogleConnectionCutoff().enabled).toBe(true);
    expect(evaluateGoogleConnectionCutoff().activeNow).toBe(true);
  });

  it("[rule 8] AUTH_PROVIDER=manus -> NEVER enabled, even with requireGoogleConnection=true and no cutoff (no Google flow exists for a user to satisfy this gate)", () => {
    ENV.authProvider = "manus";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = null;
    const result = evaluateGoogleConnectionCutoff();
    expect(result.enabled).toBe(false);
    expect(result.activeNow).toBe(false);
  });

  it("serverNow reflects the passed-in nowMs, never the real wall clock when overridden - proves the server-time contract this whole feature depends on", () => {
    const result = evaluateGoogleConnectionCutoff(0);
    expect(result.serverNow).toBe(new Date(0).toISOString());
  });

  it("cutoffAt round-trips the configured cutoff as an ISO string", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = Date.UTC(2026, 7, 15, 18, 0, 0);
    const result = evaluateGoogleConnectionCutoff();
    expect(result.cutoffAt).toBe("2026-08-15T18:00:00.000Z");
  });

  it("defaults nowMs to the real server clock (Date.now()) when omitted", () => {
    ENV.authProvider = "manus"; // enabled=false regardless, isolates this to just checking serverNow is "real"
    const before = Date.now();
    const result = evaluateGoogleConnectionCutoff();
    const after = Date.now();
    const resultMs = new Date(result.serverNow).getTime();
    expect(resultMs).toBeGreaterThanOrEqual(before);
    expect(resultMs).toBeLessThanOrEqual(after);
  });
});
