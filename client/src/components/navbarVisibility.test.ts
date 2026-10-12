import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RECOVERY_NAV_HREF,
  isPublicStorefrontPath,
  publicToasterTheme,
  shouldHideGlobalNavbar,
  shouldShowAccountRecoveryNavItem,
  shouldThemePublicNavbar,
} from "./navbarVisibility";

describe("shouldHideGlobalNavbar", () => {
  it.each([
    "/admin",
    "/admin/payments",
    "/admin/orders/123",
    "/admin/settings",
    "/admin/novels",
    "/read/123",
  ])("hides the storefront navbar on %s", location => {
    expect(shouldHideGlobalNavbar(location)).toBe(true);
  });

  it.each([
    "/",
    "/novels",
    "/novels/example",
    "/cart",
    "/orders",
    "/profile",
    "/points",
    "/wallet",
    "/sports-votes",
  ])("shows the storefront navbar on %s", location => {
    expect(shouldHideGlobalNavbar(location)).toBe(false);
  });

  it("does not treat a route that merely starts with 'admin' as an Admin route", () => {
    // Guards against a naive `location.startsWith("/admin")` false-positive
    // - there is no such route today, but the predicate must not be fooled
    // by prefix collisions if one is ever added.
    expect(shouldHideGlobalNavbar("/administrator-guide")).toBe(false);
  });

  it("hides the navbar when the reader path only differs by case or a trailing slash", () => {
    expect(shouldHideGlobalNavbar("/READ/1")).toBe(true);
    expect(shouldHideGlobalNavbar("/read/1/")).toBe(true);
  });

  it("does not treat a route that merely starts with 'read' as a Reader route", () => {
    expect(shouldHideGlobalNavbar("/readme")).toBe(false);
  });
});

describe("shouldShowAccountRecoveryNavItem", () => {
  it("shows the Account Recovery nav item for a signed-in user", () => {
    expect(shouldShowAccountRecoveryNavItem(true)).toBe(true);
  });

  it("hides the Account Recovery nav item for an anonymous visitor", () => {
    expect(shouldShowAccountRecoveryNavItem(false)).toBe(false);
  });
});

describe("ACCOUNT_RECOVERY_NAV_HREF", () => {
  it("points at the lowercase /account/recovery route", () => {
    expect(ACCOUNT_RECOVERY_NAV_HREF).toBe("/account/recovery");
  });
});

describe("isPublicStorefrontPath", () => {
  it.each(["/", "/novels", "/novels/", "/novels/4230170", "/novels/4230170/", "/NOVELS/Example"])("is true for %s", (location) => {
    expect(isPublicStorefrontPath(location)).toBe(true);
  });

  it.each([
    "/workspace",
    "/admin",
    "/admin/users",
    "/read/1",
    "/login",
    "/cart",
    "/novels/a/b",
    "/novels/a/b/",
  ])("is false for %s", (location) => {
    expect(isPublicStorefrontPath(location)).toBe(false);
  });
});

describe("shouldThemePublicNavbar", () => {
  it.each(["/cart", "/orders", "/profile"])("is true for %s", (location) => {
    expect(shouldThemePublicNavbar(location)).toBe(true);
  });

  it.each([
    "/workspace",
    "/workspace/intake",
    "/login",
    "/login/",
    "/Login",
    "/account/recovery",
    "/account/recovery/",
    "/account/upgrade-login",
    "/read/1",
    "/admin",
  ])("is false for %s", (location) => {
    expect(shouldThemePublicNavbar(location)).toBe(false);
  });
});

describe("publicToasterTheme", () => {
  it("follows the resolved theme on storefront pages", () => {
    expect(publicToasterTheme("/", "dark")).toBe("dark");
    expect(publicToasterTheme("/novels/example", "dark")).toBe("dark");
    expect(publicToasterTheme("/novels/", "dark")).toBe("dark");
    expect(publicToasterTheme("/", "light")).toBe("light");
  });

  it("stays light on cart, profile, workspace, and admin even when the preference is dark", () => {
    expect(publicToasterTheme("/cart", "dark")).toBe("light");
    expect(publicToasterTheme("/cart/", "dark")).toBe("light");
    expect(publicToasterTheme("/orders", "dark")).toBe("light");
    expect(publicToasterTheme("/profile", "dark")).toBe("light");
    expect(publicToasterTheme("/workspace", "dark")).toBe("light");
    expect(publicToasterTheme("/admin", "dark")).toBe("light");
  });
});
