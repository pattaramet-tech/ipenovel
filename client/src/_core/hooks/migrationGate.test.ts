import { describe, expect, it } from "vitest";
import {
  isMandatoryGoogleConnectionEnabled,
  isMigrationGateExemptPath,
  resolveMigrationGateAction,
  type MigrationGateInput,
} from "./migrationGate";

describe("isMandatoryGoogleConnectionEnabled", () => {
  it('"transition" + "true" -> true', () => {
    expect(isMandatoryGoogleConnectionEnabled("transition", "true")).toBe(true);
  });

  it('"google" + "true" -> false (the flag alone, without transition, never activates the gate)', () => {
    expect(isMandatoryGoogleConnectionEnabled("google", "true")).toBe(false);
  });

  it('"manus" + "true" -> false', () => {
    expect(isMandatoryGoogleConnectionEnabled("manus", "true")).toBe(false);
  });

  it.each([undefined, "", "TRUE", "True", " true", "true "])(
    '"transition" + %j -> false (exact literal "true" only)',
    (requireValue) => {
      expect(isMandatoryGoogleConnectionEnabled("transition", requireValue)).toBe(false);
    }
  );

  it("both unset -> false", () => {
    expect(isMandatoryGoogleConnectionEnabled(undefined, undefined)).toBe(false);
  });
});

describe("isMigrationGateExemptPath", () => {
  it.each(["/account/upgrade-login", "/login"])("%s -> exempt", (path) => {
    expect(isMigrationGateExemptPath(path)).toBe(true);
  });

  it.each(["/admin", "/admin/login", "/admin/novels", "/admin/orders/123"])("%s -> exempt (entire admin surface)", (path) => {
    expect(isMigrationGateExemptPath(path)).toBe(true);
  });

  it.each(["/", "/profile", "/wallet", "/novels/some-novel", "/cart", "/account"])("%s -> NOT exempt", (path) => {
    expect(isMigrationGateExemptPath(path)).toBe(false);
  });

  it("a path merely starting with /admin as a substring but not a real segment boundary is still exempt only via the startsWith('/admin/') check - /adminfoo must NOT be exempt", () => {
    expect(isMigrationGateExemptPath("/adminfoo")).toBe(false);
  });
});

function baseInput(overrides: Partial<MigrationGateInput> = {}): MigrationGateInput {
  return {
    mandatoryEnabled: true,
    pathname: "/profile",
    isAuthenticated: true,
    authLoading: false,
    googleConnected: false,
    googleConnectedLoading: false,
    googleConnectedError: false,
    ...overrides,
  };
}

describe("resolveMigrationGateAction", () => {
  it("mandatory disabled -> always allow, regardless of everything else", () => {
    expect(
      resolveMigrationGateAction(
        baseInput({ mandatoryEnabled: false, isAuthenticated: true, googleConnected: false })
      )
    ).toBe("allow");
  });

  it("exempt path (/account/upgrade-login) -> allow even for an unconnected, authenticated user", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/account/upgrade-login" }))).toBe("allow");
  });

  it("exempt path (/login) -> allow", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/login" }))).toBe("allow");
  });

  it("exempt path (/admin/novels) -> allow, admin surface is never gated", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/admin/novels" }))).toBe("allow");
  });

  it("auth state still loading -> allow (never guesses/redirects before auth settles)", () => {
    expect(resolveMigrationGateAction(baseInput({ authLoading: true }))).toBe("allow");
  });

  it("anonymous visitor (not authenticated) -> allow, on any non-exempt public page", () => {
    expect(resolveMigrationGateAction(baseInput({ isAuthenticated: false }))).toBe("allow");
  });

  it("authenticated, googleConnected query still loading -> block_loading", () => {
    expect(resolveMigrationGateAction(baseInput({ googleConnectedLoading: true, googleConnected: undefined }))).toBe(
      "block_loading"
    );
  });

  it("authenticated, googleConnected query errored (infrastructure failure) -> block_error, NEVER 'allow' (fail open) and NEVER 'redirect_upgrade' (a guess)", () => {
    expect(
      resolveMigrationGateAction(baseInput({ googleConnectedError: true, googleConnected: undefined }))
    ).toBe("block_error");
  });

  it("googleConnectedError takes priority over a stale googleConnected: false value from a previous successful fetch - still block_error, never redirect_upgrade", () => {
    expect(
      resolveMigrationGateAction(baseInput({ googleConnectedError: true, googleConnected: false }))
    ).toBe("block_error");
  });

  it("authenticated, googleConnected: true -> allow", () => {
    expect(resolveMigrationGateAction(baseInput({ googleConnected: true }))).toBe("allow");
  });

  it("authenticated, googleConnected: false (settled, no error) -> redirect_upgrade", () => {
    expect(resolveMigrationGateAction(baseInput({ googleConnected: false }))).toBe("redirect_upgrade");
  });

  it("redirect_upgrade is never returned for an exempt path, even if every other condition would otherwise trigger it (no redirect loop)", () => {
    expect(
      resolveMigrationGateAction(
        baseInput({ pathname: "/account/upgrade-login", googleConnected: false, googleConnectedError: false })
      )
    ).toBe("allow");
  });

  it("block_error is never returned for an exempt path either", () => {
    expect(
      resolveMigrationGateAction(baseInput({ pathname: "/admin/orders", googleConnectedError: true }))
    ).toBe("allow");
  });
});
