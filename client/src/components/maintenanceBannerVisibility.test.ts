import { describe, expect, it } from "vitest";
import { shouldShowMaintenanceBanner } from "./maintenanceBannerVisibility";

describe("shouldShowMaintenanceBanner", () => {
  it.each(["/admin", "/admin/payments", "/admin/orders/123", "/admin/settings", "/admin/novels"])(
    "hides the banner on the Admin section (%s) even when enabled",
    (location) => {
      expect(shouldShowMaintenanceBanner(location, true)).toBe(false);
    }
  );

  it.each([
    "/",
    "/novels",
    "/novels/example",
    "/cart",
    "/orders",
    "/profile",
    "/login",
    "/payment/123",
    "/wallet",
    "/points",
    "/sports-votes",
  ])("shows the banner on %s when enabled", (location) => {
    expect(shouldShowMaintenanceBanner(location, true)).toBe(true);
  });

  it.each(["/read/123", "/read/456789", "/read/1"])(
    "shows the banner on Reader routes (%s) too - readers need the maintenance notice, unlike the Navbar this is NOT the same hide-list",
    (location) => {
      expect(shouldShowMaintenanceBanner(location, true)).toBe(true);
    }
  );

  it("never shows the banner anywhere when disabled, including normally-visible routes and Reader", () => {
    expect(shouldShowMaintenanceBanner("/", false)).toBe(false);
    expect(shouldShowMaintenanceBanner("/cart", false)).toBe(false);
    expect(shouldShowMaintenanceBanner("/payment/123", false)).toBe(false);
    expect(shouldShowMaintenanceBanner("/read/123", false)).toBe(false);
  });

  it("does not treat a route that merely starts with 'admin' as owning its own header chrome", () => {
    expect(shouldShowMaintenanceBanner("/administrator-guide", true)).toBe(true);
  });
});
