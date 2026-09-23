import { expect, test } from "@playwright/test";
import { freeEpisodeId, novelIdentifier, packageLabel } from "./support/env";
import { escapeRegExp, gotoOk, watchRuntimeFailures } from "./support/runtime";

test.describe("@public Preview system smoke", () => {
  test("readyz reports ready", async ({ request }) => {
    const response = await request.get("/readyz");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
  });

  test("public application routes render without same-origin 5xx", async ({
    page,
  }) => {
    const runtime = watchRuntimeFailures(page);

    for (const route of ["/", "/novels", "/login", "/sports-votes"]) {
      await gotoOk(page, route);
      await expect(page.locator("body")).toBeVisible();
    }

    runtime.assertClean();
  });

  test("published package is visible on the novel detail page", async ({
    page,
  }) => {
    const runtime = watchRuntimeFailures(page);
    await gotoOk(page, `/novels/${novelIdentifier}`);
    const packageCard = page
      .getByRole("button", {
        name: new RegExp(`Episode ${escapeRegExp(packageLabel)}`),
      })
      .first();

    await expect(packageCard).toBeVisible();
    await expect(
      packageCard.locator(
        'button[title="Add to cart"], button[title="Remove from cart"]'
      )
    ).toBeVisible();
    runtime.assertClean();
  });

  test("free package reader renders without same-origin 5xx", async ({
    page,
  }) => {
    const runtime = watchRuntimeFailures(page);
    await gotoOk(page, `/read/${freeEpisodeId}`);
    await expect(page.locator("body")).toBeVisible();
    runtime.assertClean();
  });
});
