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
    googleConnectedLoading: false,
    googleConnectedError: false,
    googleConnected: false,
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
});
