import { describe, expect, it } from "vitest";
import {
  resolveSupportUrl,
  resolveUpgradeLoginPageAction,
  type UpgradeLoginPageInput,
} from "./upgradeLoginPresentation";

describe("resolveSupportUrl", () => {
  it("an https URL is returned as-is (trimmed)", () => {
    expect(resolveSupportUrl("https://support.example.com")).toBe("https://support.example.com");
    expect(resolveSupportUrl("  https://support.example.com  ")).toBe("https://support.example.com");
  });

  it.each(["http://support.example.com", "mailto:support@example.com", "tel:+66812345678"])(
    "%s (allowlisted scheme) is accepted",
    (raw) => {
      expect(resolveSupportUrl(raw)).toBe(raw);
    }
  );

  it.each([undefined, "", "   "])("%j (unset/empty/whitespace-only) -> null - never a guessed/fabricated URL", (raw) => {
    expect(resolveSupportUrl(raw)).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "vbscript:msgbox(1)",
  ])("%s (disallowed scheme) -> null, never rendered as an href", (raw) => {
    expect(resolveSupportUrl(raw)).toBeNull();
  });

  it.each(["not-a-url", "example.com", "//example.com", "support.example.com/help"])(
    "%s (unparseable / no scheme at all) -> null",
    (raw) => {
      expect(resolveSupportUrl(raw)).toBeNull();
    }
  );
});

function baseInput(overrides: Partial<UpgradeLoginPageInput> = {}): UpgradeLoginPageInput {
  return {
    authLoading: false,
    isAuthenticated: true,
    connectErrorRequested: false,
    googleConnectedLoading: false,
    googleConnectedError: false,
    googleConnected: false,
    exempt: false,
    ...overrides,
  };
}

describe("resolveUpgradeLoginPageAction", () => {
  it("auth state still loading -> loading", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ authLoading: true }))).toBe("loading");
  });

  it("anonymous (no session) -> redirect_login, never an infinite spinner", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ isAuthenticated: false, googleConnected: undefined }))).toBe(
      "redirect_login"
    );
  });

  it("authenticated, googleConnected query still loading -> loading", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ googleConnectedLoading: true, googleConnected: undefined }))
    ).toBe("loading");
  });

  it("authenticated, googleConnected query errored -> render_error, never redirect_home or render_upgrade (a guess)", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ googleConnectedError: true, googleConnected: undefined }))
    ).toBe("render_error");
  });

  it("authenticated, connected: true -> redirect_home", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ googleConnected: true }))).toBe("redirect_home");
  });

  it("authenticated, connected: false (settled, no error) -> render_upgrade", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ googleConnected: false }))).toBe("render_upgrade");
  });

  it("googleConnectedError takes priority over a stale googleConnected: true value - still render_error, never redirect_home", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ googleConnectedError: true, googleConnected: true }))
    ).toBe("render_error");
  });

  it("[required test 8] connectErrorRequested: true -> render_connect_error", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true }))).toBe("render_connect_error");
  });

  it("connectErrorRequested is checked before auth is settled or confirmed - loading and anonymous still take priority (never overridden by a stale query param)", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true, authLoading: true }))
    ).toBe("loading");
    expect(
      resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true, isAuthenticated: false, googleConnected: undefined }))
    ).toBe("redirect_login");
  });

  it("connectErrorRequested takes priority over the googleConnected query's own loading/error/value state - never waits on or is second-guessed by that query", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true, googleConnectedLoading: true, googleConnected: undefined }))
    ).toBe("render_connect_error");
    expect(
      resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true, googleConnectedError: true, googleConnected: undefined }))
    ).toBe("render_connect_error");
    expect(
      resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: true, googleConnected: true }))
    ).toBe("render_connect_error");
  });

  it("connectErrorRequested: false (success/unknown/missing query value) -> never render_connect_error", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ connectErrorRequested: false, googleConnected: false }))).toBe(
      "render_upgrade"
    );
  });

  it("[rule 5] exempt: true (admin) -> redirect_home, even when not connected - an admin who navigates here directly is never shown the upgrade card", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ exempt: true, googleConnected: false }))).toBe("redirect_home");
  });

  it("exempt: false, not connected -> render_upgrade (exempt alone never triggers render_upgrade early)", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ exempt: false, googleConnected: false }))).toBe(
      "render_upgrade"
    );
  });

  it("exempt: undefined (status not yet resolved either way) is never treated as true - stays render_upgrade once connected/loading/error are all settled-false", () => {
    expect(resolveUpgradeLoginPageAction(baseInput({ exempt: undefined, googleConnected: false }))).toBe(
      "render_upgrade"
    );
  });

  it("googleConnectedError takes priority over exempt: true too - still render_error, never redirect_home", () => {
    expect(
      resolveUpgradeLoginPageAction(baseInput({ googleConnectedError: true, exempt: true, googleConnected: undefined }))
    ).toBe("render_error");
  });
});
