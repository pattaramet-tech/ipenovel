import { describe, expect, it, vi } from "vitest";
import {
  clearLegacyAuthLocalStorage,
  clearLegacyAuthLocalStorageFromWindow,
  LEGACY_AUTH_LOCALSTORAGE_KEY,
} from "./authClientStorage";
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

describe("clearLegacyAuthLocalStorageFromWindow", () => {
  it("does nothing (no throw) when window itself is null or undefined (SSR)", () => {
    expect(() => clearLegacyAuthLocalStorageFromWindow(null)).not.toThrow();
    expect(() => clearLegacyAuthLocalStorageFromWindow(undefined)).not.toThrow();
  });

  it("does nothing (no throw) when window.localStorage is null or undefined", () => {
    expect(() => clearLegacyAuthLocalStorageFromWindow({ localStorage: null })).not.toThrow();
    expect(() => clearLegacyAuthLocalStorageFromWindow({})).not.toThrow();
  });

  it("does not throw when the window.localStorage GETTER itself throws (real runtime behavior, not a static check) - this is the actual browser SecurityError case: reading the property throws before removeItem is ever reached", () => {
    let getterCalls = 0;
    const fakeWindow: { localStorage?: Pick<Storage, "removeItem"> } = {};
    Object.defineProperty(fakeWindow, "localStorage", {
      get() {
        getterCalls += 1;
        throw new Error("SecurityError: The operation is insecure");
      },
    });

    expect(() => clearLegacyAuthLocalStorageFromWindow(fakeWindow)).not.toThrow();
    expect(getterCalls).toBe(1);
  });

  it("does not throw when window.localStorage.removeItem itself throws", () => {
    const removeItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => clearLegacyAuthLocalStorageFromWindow({ localStorage: { removeItem } })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(1);
  });

  it("removes exactly the legacy key, and only the legacy key, on a normal window", () => {
    const removeItem = vi.fn();

    clearLegacyAuthLocalStorageFromWindow({ localStorage: { removeItem } });

    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_AUTH_LOCALSTORAGE_KEY);
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

  it("clears the legacy localStorage key via clearLegacyAuthLocalStorageFromWindow", () => {
    expect(useAuthSource).toMatch(/clearLegacyAuthLocalStorageFromWindow/);
  });

  it("never reads window.localStorage directly - that access must happen inside clearLegacyAuthLocalStorageFromWindow's own try/catch, since the property getter itself can throw", () => {
    expect(useAuthSource).not.toMatch(/window\.localStorage/);
  });

  it("still sources the signed-in user from trpc.auth.me", () => {
    expect(useAuthSource).toMatch(/trpc\.auth\.me\.useQuery/);
    expect(useAuthSource).toMatch(/user:\s*meQuery\.data/);
  });
});
