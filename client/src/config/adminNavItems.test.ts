import { describe, expect, it } from "vitest";
import {
  adminNavSections,
  authorCatalogNavSections,
  getAdminNavItemsFlat,
  getAdminRouteTitle,
  isAdminRouteActive,
  isAuthorCatalogRoute,
} from "./adminNavItems";

const expectedSections = ["Main", "Sales", "Content", "Marketing", "System"];

const expectedRoutes = [
  "/admin",
  "/admin/analytics",
  "/admin/author-analytics",
  "/admin/users",
  "/admin/orders",
  "/admin/payments",
  "/admin/wallet-topups",
  "/admin/topup-logs",
  "/admin/novels",
  "/admin/episodes",
  "/admin/import-episodes",
  "/admin/hybrid-health",
  "/admin/nqa",
  "/admin/categories",
  "/admin/bulk-upload",
  "/admin/coupons",
  "/admin/banners",
  "/admin/sports-votes",
  "/admin/entitlements",
  "/admin/gift-wallet-adjustment",
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
    ["/admin/author-analytics", "Author Analysis"],
    ["/admin/orders", "Orders"],
    ["/admin/orders/123", "Orders"],
    ["/admin/wallet-topups/456", "Wallet Top-ups"],
    ["/admin/gift-wallet-adjustment", "Gift / Wallet Adjustment"],
    ["/admin/nqa", "NQA"],
    ["/admin/settings", "Settings"],
    ["/admin/users", "Users"],
    ["/admin/unknown", "Admin"],
  ])("resolves %s to the correct title", (location, title) => {
    expect(getAdminRouteTitle(location)).toBe(title);
  });

  it("does not treat child Admin routes as the Dashboard route", () => {
    expect(isAdminRouteActive("/admin", "/admin")).toBe(true);
    expect(isAdminRouteActive("/admin/orders", "/admin")).toBe(false);
    expect(isAdminRouteActive("/admin/users", "/admin")).toBe(false);
  });

  it("shows an author only the catalog sections", () => {
    expect(authorCatalogNavSections().flatMap((section) => section.items.map((item) => item.href))).toEqual([
      "/admin/author-analytics",
      "/admin/novels",
      "/admin/episodes",
      "/admin/import-episodes",
      "/admin/bulk-upload",
    ]);
    expect(isAuthorCatalogRoute("/admin/novels/12")).toBe(true);
    expect(isAuthorCatalogRoute("/admin/users")).toBe(false);
    expect(isAuthorCatalogRoute("/admin/payments")).toBe(false);
    expect(isAuthorCatalogRoute("/workspace")).toBe(false);
  });
});
