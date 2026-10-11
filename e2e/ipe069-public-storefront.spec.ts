import { expect, test } from "@playwright/test";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";
import { e2eBaseUrl } from "./support/env";

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

// IPE-069R4E P2-01 regression: lazy catalog covers must SETTLE (complete)
// on mobile and desktop after scrolling the whole grid into view — the
// suite requires the local seed with 20 load-test novels; on other targets
// it self-skips (card-count guard below).
test.describe("@public IPE-069R4E catalog lazy-load regression", () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    test(`catalog with 20 seeded cards settles all lazy covers at ${viewport.width}px`, async ({ page }) => {
      // Local-only: the 20 load-test novels come from the local seed. On
      // staging/preview the catalog content differs, so this test self-skips.
      const target = new URL(e2eBaseUrl);
      test.skip(
        target.hostname !== "localhost" && target.hostname !== "127.0.0.1",
        "20-card lazy-load regression requires the local seed"
      );
      await page.setViewportSize(viewport);
      await gotoOk(page, "/novels");
      await expect(page.locator(".ipe-public.ipe-catalog")).toBeVisible();
      // IPE-069R5L-R4E-R4 — query-loaded signal: while trpc.novels.browse is
      // resolving its FIRST load (isLoading), the page renders 10 pulse
      // skeleton placeholders instead of cards. Hydration is complete only
      // when every skeleton is gone.
      await expect(page.locator(".ipe-catalog .animate-pulse")).toHaveCount(0, { timeout: 15_000 });
      // Expected card count per the pagination contract: browse paginates
      // with PAGE_SIZE = 20 (NovelsPage.tsx) and the local seed carries 23
      // published novels — so hydrated page 1 renders EXACTLY 20 cards
      // (hasNextPage = true). An under-count proves incomplete hydration;
      // an over-count proves the pagination contract broke. Neither can
      // pass before the query has resolved.
      await expect(page.locator(".ipe-novel-card")).toHaveCount(20, { timeout: 10_000 });
      for (const card of await page.locator(".ipe-novel-card").all()) {
        await card.scrollIntoViewIfNeeded();
      }
      await page.waitForFunction(
        () => {
          const images = Array.from(
            document.querySelectorAll<HTMLImageElement>(".ipe-novel-card img")
          );
          return images.length > 0 && images.every((image) => image.complete);
        },
        undefined,
        { timeout: 15_000 }
      );
      const broken = await page.locator(".ipe-novel-card img").evaluateAll(
        (images) => images.filter((image) => (image as HTMLImageElement).naturalWidth <= 0).length
      );
      expect(broken, "broken catalog covers").toBe(0);
      // No horizontal overflow after the full grid hydrated.
      const widths = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
      }));
      expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
    });
  }
});

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
        // server-rendered card list (not just the shell). Covers use
        // loading="lazy", so cards below the fold never START fetching until
        // scrolled into view: nudge every card through the viewport BEFORE
        // the completeness wait, otherwise the wait itself prevents the
        // loads it is waiting for.
        ready: async () => {
          await expect(page.locator(".ipe-public.ipe-catalog")).toBeVisible();
          await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
          // Wait for the card count to stabilize before triggering lazy
          // loads — a mid-load count would miss below-the-fold cards.
          await expect.poll(
            () => page.locator(".ipe-novel-card").count(),
            { timeout: 10_000 }
          ).toBeGreaterThanOrEqual(1);
          for (const card of await page.locator(".ipe-novel-card").all()) {
            await card.scrollIntoViewIfNeeded();
          }
          await expect(page.locator(".ipe-novel-card img").first()).toBeAttached();
          await page.waitForFunction(
            () => {
              const images = Array.from(
                document.querySelectorAll<HTMLImageElement>(".ipe-novel-card img")
              );
              // complete covers both loaded covers and covers that errored
              // while loading — settled either way.
              return images.every((image) => image.complete);
            },
            undefined,
            { timeout: 10_000 }
          );
          // Broken-image detection: a completed cover must decode with real
          // pixels — completed-but-empty (naturalWidth 0) fails explicitly.
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