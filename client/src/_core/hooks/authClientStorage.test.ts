import { describe, expect, it, vi } from "vitest";
import { clearLegacyAuthLocalStorage, LEGACY_AUTH_LOCALSTORAGE_KEY } from "./authClientStorage";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("clearLegacyAuthLocalStorage", () => {
  it("removes the legacy key and only the legacy key", () => {
    const removeItem = vi.fn();
    clearLegacyAuthLocalStorage({ removeItem });

    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_AUTH_LOCALSTORAGE_KEY);
    expect(LEGACY_AUTH_LOCALSTORAGE_KEY).toBe("manus-runtime-user-info");
  });

  it("does nothing (no throw) when storage is null or undefined", () => {
    expect(() => clearLegacyAuthLocalStorage(null)).not.toThrow();
    expect(() => clearLegacyAuthLocalStorage(undefined)).not.toThrow();
  });

  it("does not throw when storage.removeItem itself throws (private-mode/quota/disabled storage)", () => {
    const removeItem = vi.fn(() => {
      throw new Error("SecurityError: localStorage is disabled");
    });

    expect(() => clearLegacyAuthLocalStorage({ removeItem })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(1);
  });
});

describe("useAuth.ts source shape (static regression guard - no DOM harness in this repo)", () => {
  const useAuthSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "useAuth.ts"),
    "utf8"
  );

  it("never calls localStorage.setItem to persist the auth.me result", () => {
    expect(useAuthSource).not.toMatch(/localStorage\.setItem/);
  });

  it("never persists the full user object under any key", () => {
    expect(useAuthSource).not.toMatch(/JSON\.stringify\(\s*meQuery\.data\s*\)/);
  });

  it("clears the legacy localStorage key via clearLegacyAuthLocalStorage", () => {
    expect(useAuthSource).toMatch(/clearLegacyAuthLocalStorage/);
  });

  it("still sources the signed-in user from trpc.auth.me", () => {
    expect(useAuthSource).toMatch(/trpc\.auth\.me\.useQuery/);
    expect(useAuthSource).toMatch(/user:\s*meQuery\.data/);
  });
});
