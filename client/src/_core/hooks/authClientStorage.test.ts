import { describe, expect, it, vi } from "vitest";
import {
  clearLegacyAuthLocalStorage,
  clearLegacyAuthLocalStorageFromWindow,
  LEGACY_AUTH_LOCALSTORAGE_KEY,
  LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY,
  LEGACY_AUTH_LOCALSTORAGE_KEYS,
} from "./authClientStorage";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("legacy key constants", () => {
  it("covers exactly the two known legacy auth keys", () => {
    expect(LEGACY_AUTH_LOCALSTORAGE_KEY).toBe("manus-runtime-user-info");
    expect(LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY).toBe("admin-session");
    expect(LEGACY_AUTH_LOCALSTORAGE_KEYS).toEqual(["manus-runtime-user-info", "admin-session"]);
  });
});

describe("clearLegacyAuthLocalStorage", () => {
  it("removes every legacy key (manus-runtime-user-info and admin-session), nothing else", () => {
    const removeItem = vi.fn();
    clearLegacyAuthLocalStorage({ removeItem });

    expect(removeItem).toHaveBeenCalledTimes(LEGACY_AUTH_LOCALSTORAGE_KEYS.length);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_AUTH_LOCALSTORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY);
  });

  it("does nothing (no throw) when storage is null or undefined", () => {
    expect(() => clearLegacyAuthLocalStorage(null)).not.toThrow();
    expect(() => clearLegacyAuthLocalStorage(undefined)).not.toThrow();
  });

  it("a missing key is a no-op, not an error (real localStorage.removeItem never throws for an absent key)", () => {
    const removeItem = vi.fn(); // never throws - mirrors a real Storage whose key was never set
    expect(() => clearLegacyAuthLocalStorage({ removeItem })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(2);
  });

  it("one key's removeItem throwing does not stop the other key from being removed", () => {
    const removeItem = vi.fn((key: string) => {
      if (key === LEGACY_AUTH_LOCALSTORAGE_KEY) {
        throw new Error("SecurityError: localStorage is disabled");
      }
    });

    expect(() => clearLegacyAuthLocalStorage({ removeItem })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_AUTH_LOCALSTORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY);
  });

  it("does not throw when every removeItem call throws", () => {
    const removeItem = vi.fn(() => {
      throw new Error("SecurityError: localStorage is disabled");
    });

    expect(() => clearLegacyAuthLocalStorage({ removeItem })).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(2);
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
    expect(removeItem).toHaveBeenCalledTimes(2);
  });

  it("removes exactly the two legacy keys, and only those, on a normal window", () => {
    const removeItem = vi.fn();

    clearLegacyAuthLocalStorageFromWindow({ localStorage: { removeItem } });

    expect(removeItem).toHaveBeenCalledTimes(2);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_AUTH_LOCALSTORAGE_KEY);
    expect(removeItem).toHaveBeenCalledWith(LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY);
    const calledKeys = removeItem.mock.calls.map((call) => call[0]);
    expect(new Set(calledKeys)).toEqual(new Set(LEGACY_AUTH_LOCALSTORAGE_KEYS));
  });
});

describe("useAuth.ts source shape (static regression guard - no DOM harness in this repo)", () => {
  // Normalized to \n regardless of the checkout's line-ending style (this
  // repo's working tree uses CRLF) so literal multi-line substring searches
  // below don't have to account for \r.
  const useAuthSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "useAuth.ts"),
    "utf8"
  ).replace(/\r\n/g, "\n");

  it("never calls localStorage.setItem to persist the auth.me result", () => {
    expect(useAuthSource).not.toMatch(/localStorage\.setItem/);
  });

  it("never persists the full user object under any key", () => {
    expect(useAuthSource).not.toMatch(/JSON\.stringify\(\s*meQuery\.data\s*\)/);
  });

  it("clears the legacy localStorage keys via clearLegacyAuthLocalStorageFromWindow", () => {
    expect(useAuthSource).toMatch(/clearLegacyAuthLocalStorageFromWindow/);
  });

  it("never reads window.localStorage directly - that access must happen inside clearLegacyAuthLocalStorageFromWindow's own try/catch, since the property getter itself can throw", () => {
    expect(useAuthSource).not.toMatch(/window\.localStorage/);
  });

  it("still sources the signed-in user from trpc.auth.me", () => {
    expect(useAuthSource).toMatch(/trpc\.auth\.me\.useQuery/);
    expect(useAuthSource).toMatch(/user:\s*meQuery\.data/);
  });

  it("exposes an isLoggingOut flag driven by the logout mutation's pending state", () => {
    expect(useAuthSource).toMatch(/isLoggingOut:\s*logoutMutation\.isPending/);
  });

  it("exposes authMeError as specifically auth.me's own error, never the logout mutation's", () => {
    expect(useAuthSource).toMatch(/authMeError:\s*meQuery\.error\s*\?\?\s*null/);
  });

  it("logout() classifies a failed mutation via classifyLogoutFailure and rethrows on 'unexpected_error', instead of swallowing every failure", () => {
    expect(useAuthSource).toMatch(/import \{ classifyLogoutFailure \} from ".\/logoutOutcome"/);
    const logoutStart = useAuthSource.indexOf("const logout = useCallback(async () => {");
    const logoutEnd = useAuthSource.indexOf("}, [logoutMutation, utils]);");
    const logoutBlock = useAuthSource.slice(logoutStart, logoutEnd);

    expect(logoutBlock).toMatch(/classifyLogoutFailure\(error\) === "unexpected_error"/);
    expect(logoutBlock).toMatch(/throw error;/);
  });

  it("logout() clears the auth.me cache only after the try/catch settles without rethrowing (success or already-logged-out) - never in a finally that would run even on an unexpected failure", () => {
    const logoutStart = useAuthSource.indexOf("const logout = useCallback(async () => {");
    const logoutEnd = useAuthSource.indexOf("}, [logoutMutation, utils]);");
    const logoutBlock = useAuthSource.slice(logoutStart, logoutEnd);

    expect(logoutBlock).not.toMatch(/finally/);
    const catchEnd = logoutBlock.indexOf("}\n\n    utils.auth.me.setData");
    expect(catchEnd).toBeGreaterThan(-1);
    const afterCatch = logoutBlock.slice(catchEnd);
    expect(afterCatch).toMatch(/utils\.auth\.me\.setData\(undefined, null\)/);
    expect(afterCatch).toMatch(/await utils\.auth\.me\.invalidate\(\)/);
  });

  it("the unauthenticated-redirect effect resolves its target via the shared, narrow resolveUnauthorizedRedirectTarget helper - never a bespoke, divergent copy of the /admin/* rule", () => {
    expect(useAuthSource).toMatch(/import \{ resolveUnauthorizedRedirectTarget \} from ".\/unauthorizedRedirect"/);
    expect(useAuthSource).toMatch(
      /resolveUnauthorizedRedirectTarget\(window\.location\.pathname\)/
    );
  });

  it("never evaluates getLoginUrl() eagerly - only inside the 'oauth' branch of the redirect effect, never unconditionally on every render", () => {
    expect(useAuthSource).not.toMatch(/redirectPath\s*=\s*getLoginUrl\(\)/);
    const redirectEffectStart = useAuthSource.indexOf("useEffect(() => {\n    if (!redirectOnUnauthenticated) return;");
    expect(redirectEffectStart).toBeGreaterThan(-1);
    const redirectEffectEnd = useAuthSource.indexOf("state.user,\n  ]);", redirectEffectStart);
    expect(redirectEffectEnd).toBeGreaterThan(-1);
    const redirectEffectBlock = useAuthSource.slice(redirectEffectStart, redirectEffectEnd);
    expect(redirectEffectBlock).toMatch(/target === "admin_login" \? "\/admin\/login" : getLoginUrl\(\)/);
  });

  it("the redirect effect bails out on a genuine auth.me infrastructure error (meQuery.error) BEFORE checking state.user - an error means 'unknown', not 'unauthenticated', and must never be treated as proof of no session", () => {
    const redirectEffectStart = useAuthSource.indexOf("useEffect(() => {\n    if (!redirectOnUnauthenticated) return;");
    expect(redirectEffectStart).toBeGreaterThan(-1);
    const redirectEffectEnd = useAuthSource.indexOf("state.user,\n  ]);", redirectEffectStart);
    expect(redirectEffectEnd).toBeGreaterThan(-1);
    const redirectEffectBlock = useAuthSource.slice(redirectEffectStart, redirectEffectEnd);

    const errorGuardIndex = redirectEffectBlock.indexOf("if (meQuery.error) return;");
    const userGuardIndex = redirectEffectBlock.indexOf("if (state.user) return;");
    expect(errorGuardIndex).toBeGreaterThan(-1);
    expect(userGuardIndex).toBeGreaterThan(-1);
    expect(errorGuardIndex).toBeLessThan(userGuardIndex);
  });

  it("the redirect effect's dependency array includes meQuery.error, so a settling auth.me error re-evaluates the guard instead of running stale", () => {
    const redirectEffectStart = useAuthSource.indexOf("useEffect(() => {\n    if (!redirectOnUnauthenticated) return;");
    const redirectEffectEnd = useAuthSource.indexOf("]);", useAuthSource.indexOf("state.user,\n  ]);", redirectEffectStart));
    const redirectEffectBlock = useAuthSource.slice(redirectEffectStart, redirectEffectEnd + "]);".length);
    expect(redirectEffectBlock).toMatch(/\[\s*redirectOnUnauthenticated,\s*logoutMutation\.isPending,\s*meQuery\.isLoading,\s*meQuery\.error,\s*state\.user,\s*\]/);
  });
});

/**
 * Auth Phase 2A repository-wide regression guard: after removing the
 * "admin-session" localStorage flag (AdminLoginPage used to write it,
 * AdminDashboard used to OR it into `isAdmin`), production client source
 * must never reintroduce it as a runtime authorization signal. Comments
 * documenting the migration, and this legacy-cleanup helper itself, are the
 * only allowed places the literal string may still appear - see
 * docs/AUTH_PHASE2A or the module docstring in authClientStorage.ts.
 *
 * Walks the real filesystem (no DOM harness needed for this - it's a text
 * scan), matching the pattern already used above for reading useAuth.ts's
 * own source.
 */
describe("repository regression: no runtime admin-session authorization in production client source", () => {
  const clientSrcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
  const legacyHelperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "authClientStorage.ts");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** `//` line comments and `/* ... *\/` block comments (including JSDoc `*`-prefixed continuation lines) - not a full parser, just enough to tell "this line is prose" from "this line is code". */
  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
  }

  const productionFiles = walk(clientSrcRoot);

  it("scanned at least the files this suite depends on (sanity check that the walk isn't accidentally empty)", () => {
    expect(productionFiles.length).toBeGreaterThan(50);
    expect(productionFiles).toContain(legacyHelperPath);
  });

  it('the string "admin-session" only appears in authClientStorage.ts (the legacy cleanup helper) or comments elsewhere', () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      if (file === legacyHelperPath) continue;
      const content = readFileSync(file, "utf8");
      if (!content.includes("admin-session")) continue;
      content.split("\n").forEach((line, idx) => {
        if (!line.includes("admin-session")) return;
        if (isCommentLine(line)) return;
        violations.push(`${path.relative(clientSrcRoot, file)}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it("no production file reads or writes localStorage under the admin-session key directly", () => {
    const pattern = /localStorage\.(getItem|setItem|removeItem)\(\s*["'`]admin-session["'`]/;
    const violations: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, "utf8");
      if (pattern.test(content)) violations.push(path.relative(clientSrcRoot, file));
    }
    expect(violations).toEqual([]);
  });

  it("no boolean flag named isAdminLoggedIn is used as real code anywhere in production source (superseded by resolveAdminAccessState) - mentions inside comments documenting the migration are fine", () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, "utf8");
      if (!/\bisAdminLoggedIn\b/.test(content)) continue;
      content.split("\n").forEach((line, idx) => {
        if (!/\bisAdminLoggedIn\b/.test(line)) return;
        if (isCommentLine(line)) return;
        violations.push(`${path.relative(clientSrcRoot, file)}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('no production file ORs a client-only flag into an "isAdmin"-style variable (e.g. "isAdminLoggedIn || ...", "... || user.role")', () => {
    const violations: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, "utf8");
      if (/\bisAdmin\s*=\s*[a-zA-Z0-9_.]+\s*\|\|/.test(content)) {
        violations.push(path.relative(clientSrcRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
