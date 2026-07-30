import { afterEach, describe, expect, it } from "vitest";
import {
  ENV,
  isGoogleConnectionMandatory,
  resolveAuthProviderMode,
  resolveForceReloginCutoffSeconds,
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
});

describe("isGoogleConnectionMandatory", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
  });

  it("transition + true -> true", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    expect(isGoogleConnectionMandatory()).toBe(true);
  });

  it("transition + false -> false", () => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = false;
    expect(isGoogleConnectionMandatory()).toBe(false);
  });

  it("google + true -> false (the flag alone, without transition, never activates the gate)", () => {
    ENV.authProvider = "google";
    ENV.requireGoogleConnection = true;
    expect(isGoogleConnectionMandatory()).toBe(false);
  });

  it("manus + true -> false", () => {
    ENV.authProvider = "manus";
    ENV.requireGoogleConnection = true;
    expect(isGoogleConnectionMandatory()).toBe(false);
  });
});
