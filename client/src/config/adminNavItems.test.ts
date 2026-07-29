import { describe, expect, it } from "vitest";
import {
  adminNavSections,
  getAdminNavItemsFlat,
  getAdminRouteTitle,
  isAdminRouteActive,
} from "./adminNavItems";

const expectedSections = ["Main", "Sales", "Content", "Marketing", "System"];

const expectedRoutes = [
  "/admin",
  "/admin/analytics",
  "/admin/orders",
  "/admin/payments",
  "/admin/wallet-topups",
  "/admin/topup-logs",
  "/admin/novels",
  "/admin/episodes",
  "/admin/import-episodes",
  "/admin/hybrid-health",
  "/admin/categories",
  "/admin/bulk-upload",
  "/admin/coupons",
  "/admin/banners",
  "/admin/sports-votes",
  "/admin/entitlements",
  "/admin/entitlement-lookup",
  "/admin/media-migration",
  "/admin/settings",
];

describe("admin navigation configuration", () => {
  it("keeps every Admin section and route available to the layout", () => {
    expect(adminNavSections.map(section => section.title)).toEqual(
      expectedSections
    );
    expect(getAdminNavItemsFlat().map(item => item.href)).toEqual(
      expectedRoutes
    );
  });

  it.each([
    ["/admin", "Dashboard"],
    ["/admin/orders", "Orders"],
    ["/admin/orders/123", "Orders"],
    ["/admin/wallet-topups/456", "Wallet Top-ups"],
    ["/admin/settings", "Settings"],
    ["/admin/unknown", "Admin"],
  ])("resolves %s to the correct title", (location, title) => {
    expect(getAdminRouteTitle(location)).toBe(title);
  });

  it("does not treat child Admin routes as the Dashboard route", () => {
    expect(isAdminRouteActive("/admin", "/admin")).toBe(true);
    expect(isAdminRouteActive("/admin/orders", "/admin")).toBe(false);
  });
});
