import { describe, expect, it } from "vitest";
import { ACCOUNT_RECOVERY_NAV_HREF, shouldHideGlobalNavbar, shouldShowAccountRecoveryNavItem } from "./navbarVisibility";

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
