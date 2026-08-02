import { describe, expect, it } from "vitest";
import {
  isMandatoryGoogleConnectionEnabled,
  isMigrationGateExemptPath,
  resolveMigrationGateAction,
  shouldShowUpcomingCutoffBanner,
  type MigrationGateInput,
  type UpcomingCutoffBannerInput,
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
  it.each(["/account/upgrade-login", "/login", "/account/recovery"])("%s -> exempt", (path) => {
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

  it("/account/recovery is an EXACT match only - a path merely sharing that prefix is NOT exempt (never a startsWith('/account/recovery') rule, unlike /admin)", () => {
    expect(isMigrationGateExemptPath("/account/recovery-other")).toBe(false);
    expect(isMigrationGateExemptPath("/account/recovery/")).toBe(false);
    expect(isMigrationGateExemptPath("/account/recovery/sub")).toBe(false);
  });

  it("other /account/* pages remain fully gated - the exemption is scoped to /account/recovery specifically, never the whole /account surface", () => {
    expect(isMigrationGateExemptPath("/account/profile")).toBe(false);
    expect(isMigrationGateExemptPath("/account")).toBe(false);
  });
});

function baseInput(overrides: Partial<MigrationGateInput> = {}): MigrationGateInput {
  return {
    pathname: "/profile",
    isAuthenticated: true,
    authLoading: false,
    statusLoading: false,
    statusError: false,
    needsConnection: false,
    ...overrides,
  };
}

describe("resolveMigrationGateAction", () => {
  it("server says needsConnection: false -> allow, regardless of everything else about the feature being on/off (that's the server's call, baked into needsConnection already)", () => {
    expect(resolveMigrationGateAction(baseInput({ needsConnection: false }))).toBe("allow");
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

  it("authenticated, status query still loading -> block_loading", () => {
    expect(resolveMigrationGateAction(baseInput({ statusLoading: true, needsConnection: undefined }))).toBe(
      "block_loading"
    );
  });

  it("authenticated, status query errored (infrastructure failure) -> block_error, NEVER 'allow' (fail open) and NEVER 'redirect_upgrade' (a guess)", () => {
    expect(resolveMigrationGateAction(baseInput({ statusError: true, needsConnection: undefined }))).toBe(
      "block_error"
    );
  });

  it("statusError takes priority over a stale needsConnection: false value from a previous successful fetch - still block_error, never redirect_upgrade", () => {
    expect(resolveMigrationGateAction(baseInput({ statusError: true, needsConnection: false }))).toBe("block_error");
  });

  it("authenticated, needsConnection: true -> redirect_upgrade", () => {
    expect(resolveMigrationGateAction(baseInput({ needsConnection: true }))).toBe("redirect_upgrade");
  });

  it("needsConnection: undefined (not yet resolved, no loading/error flag set either) -> allow, never guesses redirect_upgrade", () => {
    expect(resolveMigrationGateAction(baseInput({ needsConnection: undefined }))).toBe("allow");
  });

  it("redirect_upgrade is never returned for an exempt path, even if every other condition would otherwise trigger it (no redirect loop)", () => {
    expect(
      resolveMigrationGateAction(
        baseInput({ pathname: "/account/upgrade-login", needsConnection: true, statusError: false })
      )
    ).toBe("allow");
  });

  it("block_error is never returned for an exempt path either", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/admin/orders", statusError: true }))).toBe("allow");
  });

  // ---- /account/recovery: a user whose Google identity was just moved
  // away by an approved account-recovery request must be able to reach
  // this page (see AccountRecoveryPage.tsx's "log out and log back in
  // with Google" instruction) even though, by definition, they now have
  // no linked Google identity and needsConnection would otherwise be true.

  it("[FIX] pathname=/account/recovery, needsConnection=true -> allow, never redirect_upgrade - the post-approval source session must reach its own explanation page", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/account/recovery", needsConnection: true }))).toBe(
      "allow"
    );
  });

  it("[FIX] pathname=/account/recovery, statusError=true -> allow, never block_error - the exempt-path check runs before the status query is even consulted (MigrationGate.tsx never issues the query at all on an exempt path)", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/account/recovery", statusError: true }))).toBe(
      "allow"
    );
  });

  it("[FIX] pathname=/account/recovery, statusLoading=true -> allow, never block_loading", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/account/recovery", statusLoading: true }))).toBe(
      "allow"
    );
  });

  it("[FIX] a path merely resembling /account/recovery (/account/recovery-other) with needsConnection=true -> redirect_upgrade, NOT exempt - the exemption is exact-match only", () => {
    expect(
      resolveMigrationGateAction(baseInput({ pathname: "/account/recovery-other", needsConnection: true }))
    ).toBe("redirect_upgrade");
  });

  it("[FIX] other, non-exempt /account/* pages (e.g. /account/profile) are still fully gated - needsConnection=true -> redirect_upgrade", () => {
    expect(resolveMigrationGateAction(baseInput({ pathname: "/account/profile", needsConnection: true }))).toBe(
      "redirect_upgrade"
    );
  });
});

function baseBannerInput(overrides: Partial<UpcomingCutoffBannerInput> = {}): UpcomingCutoffBannerInput {
  return {
    enabled: true,
    activeNow: false,
    googleConnected: false,
    exempt: false,
    ...overrides,
  };
}

describe("shouldShowUpcomingCutoffBanner", () => {
  it("feature disabled -> never shown", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ enabled: false }))).toBe(false);
  });

  it("feature enabled, not yet active, not connected, not exempt -> shown", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput())).toBe(true);
  });

  it("cutoff already active -> never shown (MigrationGate's redirect_upgrade takes over instead)", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ activeNow: true }))).toBe(false);
  });

  it("already connected -> never shown", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ googleConnected: true }))).toBe(false);
  });

  it("exempt (admin) -> never shown", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ exempt: true }))).toBe(false);
  });

  it("googleConnected/exempt still undefined (status not yet resolved) -> never shown, not a guess", () => {
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ googleConnected: undefined }))).toBe(false);
    expect(shouldShowUpcomingCutoffBanner(baseBannerInput({ exempt: undefined }))).toBe(false);
  });
});
