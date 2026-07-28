import { describe, expect, it } from "vitest";
import { normalizeProviderName } from "./providerName";

describe("normalizeProviderName", () => {
  it("returns null for null", () => {
    expect(normalizeProviderName(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeProviderName(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeProviderName("")).toBeNull();
  });

  it("returns null for a whitespace-only string", () => {
    expect(normalizeProviderName("   ")).toBeNull();
    expect(normalizeProviderName("\t\n")).toBeNull();
  });

  it("trims a real name", () => {
    expect(normalizeProviderName("  Somchai  ")).toBe("Somchai");
  });

  it("keeps a real name with internal spaces untouched", () => {
    expect(normalizeProviderName("Somchai Jaidee")).toBe("Somchai Jaidee");
  });

  it("passing null/undefined/empty/whitespace through `?? undefined` yields undefined - the value that makes upsertUser skip the field entirely and preserve any existing stored name", () => {
    expect(normalizeProviderName(null) ?? undefined).toBeUndefined();
    expect(normalizeProviderName(undefined) ?? undefined).toBeUndefined();
    expect(normalizeProviderName("") ?? undefined).toBeUndefined();
    expect(normalizeProviderName("   ") ?? undefined).toBeUndefined();
  });
});
