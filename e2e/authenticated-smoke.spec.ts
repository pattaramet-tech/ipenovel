import { expect, test } from "@playwright/test";
import { authStatePath, hasAuthState } from "./support/env";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";

test.describe("@auth authenticated Preview smoke", () => {
  test.beforeEach(() => {
    test.skip(
      !hasAuthState,
      `Authenticated state not found at ${authStatePath}. Run test:e2e:auth:capture first.`
    );
  });

  test("cart resolves as an authenticated page", async ({ page }) => {
    const runtime = watchRuntimeFailures(page);
    await gotoOk(page, "/cart");

    await expect(page.locator("h1")).toBeVisible();
    await expect(page).toHaveURL(/\/cart(?:\?|$)/);
    runtime.assertClean();
  });
  test("account and library routes render without same-origin 5xx", async ({
    page,
  }) => {
    const runtime = watchRuntimeFailures(page);

    for (const route of ["/profile", "/my-library", "/my-novels"]) {
      await gotoOk(page, route);
      await expect(page.locator("body")).toBeVisible();
    }

    runtime.assertClean();
  });
});
