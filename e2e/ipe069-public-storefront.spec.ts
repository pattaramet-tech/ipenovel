import { expect, test } from "@playwright/test";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";

// IPE-069R2D: the storefront renders progressively — the SPA shell arrives
// first, then the tRPC home/catalog/detail payloads hydrate the sections.
// Screenshots captured before those queries settle showed empty/placeholder
// sections, so every content assertion waits for the LIVE API-backed markup
// below before capture. The novel identifier stays overridable via
// E2E_NOVEL_IDENTIFIER (no API mutation is ever performed — read-only UI
// checks only).
const novelIdentifier = process.env.E2E_NOVEL_IDENTIFIER?.trim() || "4230170";

const viewports = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
] as const;

test.describe("@public IPE-069 premium editorial storefront", () => {
  test("home, catalog and published detail keep one H1 and no horizontal overflow", async ({ page }) => {
    const runtime = watchRuntimeFailures(page);
    const routes = [
      {
        path: "/",
        key: "home",
        // Home is hydrated by trpc.home.getSections — the storefront shell
        // mounts immediately, but sections/cards/banner are not part of the
        // first paint. Wait for the API-driven content before capture:
        // at least one API-backed novel card rendered.
        ready: async () => {
          await expect(page.locator(".ipe-public.ipe-home")).toBeVisible();
          await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
          // Banner area: whenever the API returns a banner image for the
          // carousel, wait for the actual <img> to be attached and loaded
          // (naturalWidth > 0) so the capture shows the real hero.
          await page.waitForFunction(
            () => {
              const images = Array.from(
                document.querySelectorAll<HTMLImageElement>(".ipe-home-hero img")
              );
              return (
                images.length === 0 ||
                images.every((image) => image.complete && image.naturalWidth > 0)
              );
            },
            undefined,
            { timeout: 10_000 }
          );
        },
      },
      {
        path: "/novels",
        key: "catalog",
        // Catalog is backed by the novels browse query — wait for the
        // server-rendered card list (not just the shell), for every card
        // image to finish loading, and for the card count to settle so the
        // overflow check + capture see the fully hydrated grid.
        ready: async () => {
          await expect(page.locator(".ipe-public.ipe-catalog")).toBeVisible();
          await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
          await page.waitForFunction(
            () => {
              const images = Array.from(
                document.querySelectorAll<HTMLImageElement>(".ipe-novel-card img")
              );
              return images.every((image) => image.complete);
            },
            undefined,
            { timeout: 10_000 }
          );
          // complete can be true even when the browser could not decode an
          // image (e.g. a preview image host returning HTML). Fail explicitly
          // on broken images rather than timing out or silently accepting them.
          const brokenImages = await page.locator(".ipe-novel-card img").evaluateAll(
            (images) => images.filter((image) => (image as HTMLImageElement).naturalWidth <= 0).length
          );
          expect(brokenImages, "Catalog images completed with zero naturalWidth").toBe(0);
          await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
        },
      },
      {
        path: "/novels/" + novelIdentifier,
        key: "detail",
        // Detail needs BOTH payloads: the novel identity (canonical/H1) and
        // the commercial package list (ขายแพ็ก) — capture only after the
        // packages section is actually rendered.
        ready: async () => {
          await expect(page.locator(".ipe-public.ipe-detail")).toBeVisible();
          await expect(page.locator("h1")).not.toBeEmpty();
          await expect(
            page.getByText(/ขายแพ็ก/).first()
          ).toBeVisible();
        },
      },
    ];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await gotoOk(page, route.path);
        await expect(page.locator(".ipe-public")).toBeVisible();
        await expect(page.locator("h1")).toHaveCount(1);
        await route.ready();
        const widths = await page.evaluate(() => ({
          document: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
        }));
        expect(widths.document, route.key + " at " + viewport.width + "px").toBeLessThanOrEqual(widths.viewport + 1);
        await page.screenshot({
          path: test.info().outputPath("ipe069-candidate-" + route.key + "-" + viewport.width + ".png"),
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    runtime.assertClean();
  });

  test("mobile menu has accessible name, expanded state and keyboard controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/");
    const nav = page.getByRole("navigation", { name: "Public navigation" });
    const open = nav.getByRole("button", { name: /^(เปิดเมนู|Open menu)$/ });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.focus();
    await page.keyboard.press("Enter");
    const close = nav.getByRole("button", { name: /^(ปิดเมนู|Close menu)$/ });
    await expect(close).toHaveAttribute("aria-expanded", "true");
    await expect(close).toHaveAttribute("aria-controls", "ipe-mobile-navigation");
    await expect(page.locator("#ipe-mobile-navigation")).toBeVisible();
    await close.click();
    await expect(open).toHaveAttribute("aria-expanded", "false");
  });

  test("catalog keeps URL-synced sort and debounced search", async ({ page }) => {
    await gotoOk(page, "/novels");
    // Wait for the API-backed catalog before interacting with it.
    await expect(page.locator(".ipe-public.ipe-catalog")).toBeVisible();
    await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
    await page.getByRole("button", { name: /^(ยอดนิยม|Popular)$/ }).click();
    await expect(page).toHaveURL(/sort=popular/);
    await page.getByPlaceholder(/ค้นหานิยาย|Search novels/).fill("IPE069-preview-only-no-results");
    await expect(page).toHaveURL(/search=IPE069-preview-only-no-results/);
    await expect(page.getByText(/No novels found|ไม่พบนิยายที่ตรงกับการค้นหา/)).toBeVisible();
    // Read-only UI checks: never toggle wishlist on a live environment.
  });

  test("detail retains canonical SEO and commercial package list", async ({ page }) => {
    await gotoOk(page, "/novels/" + novelIdentifier);
    // Wait for the API-backed detail payload before asserting SEO/ commerce.
    await expect(page.locator(".ipe-public.ipe-detail")).toBeVisible();
    await expect(page.getByText(/ขายแพ็ก/).first()).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/novels\//);
    await expect(page.locator("#seo-json-ld")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    // Never click cart, checkout, purchase, account or wishlist controls.
  });
});