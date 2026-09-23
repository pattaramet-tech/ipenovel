import { expect, test, type Page } from "@playwright/test";
import {
  mutationSkipReason,
  novelIdentifier,
  packageLabel,
} from "./support/env";
import { escapeRegExp, gotoOk, watchRuntimeFailures } from "./support/runtime";

function packageCard(page: Page) {
  return page
    .getByRole("button", {
      name: new RegExp(`Episode ${escapeRegExp(packageLabel)}`),
    })
    .first();
}

async function waitForCartButton(page: Page) {
  const card = packageCard(page);
  await expect(card).toBeVisible();
  const button = card.locator(
    'button[title="Add to cart"], button[title="Remove from cart"]'
  );
  await expect(button).toBeVisible();
  return { card, button };
}
async function removeIfSelected(page: Page) {
  const { card } = await waitForCartButton(page);
  const remove = card.locator('button[title="Remove from cart"]');
  if (await remove.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForResponse(r => r.url().includes("/api/trpc/cart.remove")),
      remove.click(),
    ]);
    await expect(card.locator('button[title="Add to cart"]')).toBeVisible();
  }
}

test.describe("@mutation package cart regression", () => {
  test("paid package can be added to cart and removed again", async ({
    page,
  }) => {
    const skipReason = mutationSkipReason();
    test.skip(Boolean(skipReason), skipReason);

    const runtime = watchRuntimeFailures(page);
    await gotoOk(page, `/novels/${novelIdentifier}`);
    await removeIfSelected(page);

    const card = packageCard(page);
    const add = card.locator('button[title="Add to cart"]');
    await expect(add).toBeVisible();
    try {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().includes("/api/trpc/cart.add")),
        add.click(),
      ]);

      expect(response.status(), await response.text()).toBe(200);
      await expect(
        card.locator('button[title="Remove from cart"]')
      ).toBeVisible();

      await gotoOk(page, "/cart");
      await expect(
        page.getByText(packageLabel, { exact: false }).first()
      ).toBeVisible();
      runtime.assertClean();
    } finally {
      await gotoOk(page, `/novels/${novelIdentifier}`);
      await removeIfSelected(page);
    }
  });
});
