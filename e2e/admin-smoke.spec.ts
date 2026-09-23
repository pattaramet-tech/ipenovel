import { expect, test } from "@playwright/test";
import { adminAuthStatePath, hasAdminAuthState } from "./support/env";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";

const adminRoutes = [
  "/admin",
  "/admin/novels",
  "/admin/episodes",
  "/admin/orders",
  "/admin/payments",
  "/admin/wallet-topups",
  "/admin/entitlements",
  "/admin/gift-wallet-adjustment",
  "/admin/settings",
  "/admin/analytics",
  "/workspace",
];

test.describe("@admin read-only admin/workspace smoke", () => {
  test.beforeEach(() => {
    test.skip(
      !hasAdminAuthState,
      `Admin storage state not found at ${adminAuthStatePath}. Capture an admin Preview session first.`
    );
  });
  test("critical admin and workspace routes render without same-origin 5xx", async ({
    page,
  }) => {
    const runtime = watchRuntimeFailures(page);

    for (const route of adminRoutes) {
      await gotoOk(page, route);
      await expect(page.locator("body")).toBeVisible();
    }

    runtime.assertClean();
  });
});
