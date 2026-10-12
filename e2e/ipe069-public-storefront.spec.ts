import { expect, test } from "@playwright/test";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";
import { e2eBaseUrl, novelIdentifier } from "./support/env";

// IPE-069R2D: the storefront renders progressively — the SPA shell arrives
// first, then the tRPC home/catalog/detail payloads hydrate the sections.
// Screenshots captured before those queries settle showed empty/placeholder
// sections, so every content assertion waits for the LIVE API-backed markup
// below before capture. The novel identifier stays overridable via
// E2E_NOVEL_IDENTIFIER (no API mutation is ever performed — read-only UI
// checks only).

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
      // IPE-069R5L-R4G-R2 Finding A — INDEPENDENT read-only fixture
      // attestation with three-state classification. The response contract
      // is validated fail-closed: INVALID_API_RESPONSE must FAIL (never be
      // converted into count = 0 → skip); only VALID_FIXTURE_ABSENT may skip.
      const attestation = await page.request.get(
        "/api/trpc/novels.browse?input=" +
          encodeURIComponent(JSON.stringify({ json: { page: 1, pageSize: 20 } }))
      );
      let jsonParsed = true;
      let parsedBody: unknown = null;
      try {
        parsedBody = await attestation.json();
      } catch {
        jsonParsed = false; // malformed JSON body
      }
      const decision = attestCatalogFixtureResponse({
        httpStatus: attestation.status(),
        jsonParsed,
        body: parsedBody,
      });
      test.skip(decision.state === "VALID_FIXTURE_ABSENT", decision.reason);
      // Attested: the UI MUST render exactly PAGE_SIZE (20) cards. A smaller
      // count with an attested fixture is a FAIL, never a skip.
      assertAttestedCatalogCardCount(decision.state, (await page.locator(".ipe-novel-card").count()));
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

// IPE-069R5L-R4G-R2 Finding A — fixture attestation decision (pure and
// deterministically regression-tested). The response contract is classified
// fail-closed: a valid tRPC envelope (result.data.json) with a full page-1
// ATTESTS the 20-card fixture, a valid envelope with fewer items means the
// standard prepare ran without the load-test seed (skip), and ANY
// schema/HTTP/JSON defect — including a malformed envelope or a non-boolean
// hasNextPage — is INVALID_API_RESPONSE, which must FAIL, never be converted
// into count = 0.
export type CatalogAttestationState =
  | "VALID_FIXTURE_READY"
  | "VALID_FIXTURE_ABSENT"
  | "INVALID_API_RESPONSE";

function attestCatalogFixtureResponse(params: {
  httpStatus: number;
  jsonParsed: boolean;
  body: unknown;
}): { state: CatalogAttestationState; attestedCount: number; reason: string } {
  const { httpStatus, jsonParsed, body } = params;
  const envelope = validateBrowseEnvelope(body);
  if (httpStatus !== 200 || !jsonParsed || !envelope.ok) {
    return {
      state: "INVALID_API_RESPONSE",
      attestedCount: 0,
      reason: `browse attestation response invalid: HTTP ${httpStatus}, json parsed = ${jsonParsed}, envelope = ${envelope.ok ? "valid" : envelope.reason}`,
    };
  }
  const items = envelope.items;
  if (items.length >= 20) {
    return {
      state: "VALID_FIXTURE_READY",
      attestedCount: items.length,
      reason: `fixture attested: browse page 1 returned ${items.length} novels`,
    };
  }
  return {
    state: "VALID_FIXTURE_ABSENT",
    attestedCount: items.length,
    reason: `20-card fixture not provisioned: browse page 1 returned ${items.length} novels (need >= 20)`,
  };
}

/**
 * Strict, fail-closed validation of the tRPC browse output envelope.
 * The real contract (server/db.ts BrowseCatalogResult) returns exactly
 * { items: BrowseCatalogNovel[]; hasNextPage: boolean } inside
 * result.data.json. Anything missing or of the wrong type is treated as a
 * malformed contract and must FAIL, never be converted into a skip.
 */
function validateBrowseEnvelope(
  body: unknown
):
  | { ok: true; items: unknown[]; hasNextPage: boolean }
  | { ok: false; reason: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "body is not an object" };
  }
  const b = body as Record<string, unknown>;
  if (!b.result || typeof b.result !== "object") {
    return { ok: false, reason: "missing result envelope" };
  }
  const result = b.result as Record<string, unknown>;
  if (!result.data || typeof result.data !== "object") {
    return { ok: false, reason: "missing result.data envelope" };
  }
  const data = result.data as Record<string, unknown>;
  if (!data.json || typeof data.json !== "object") {
    return { ok: false, reason: "missing result.data.json envelope" };
  }
  const json = data.json as Record<string, unknown>;
  if (!Array.isArray(json.items)) {
    return { ok: false, reason: "items is not an array" };
  }
  if (typeof json.hasNextPage !== "boolean") {
    return { ok: false, reason: "hasNextPage is not a boolean" };
  }
  return { ok: true, items: json.items, hasNextPage: json.hasNextPage };
}

/**
 * The UI-side contract: with an ATTESTED fixture the catalog MUST render
 * exactly PAGE_SIZE (20) cards — fewer or more is a FAIL, never a skip.
 * Deterministically regression-tested below.
 */
function assertAttestedCatalogCardCount(
  attestationState: CatalogAttestationState,
  uiCardCount: number
): void {
  if (attestationState !== "VALID_FIXTURE_READY") {
    throw new Error(`catalog attestation ${attestationState} — card count cannot be asserted`);
  }
  expect(uiCardCount, "attested fixture page 1 must render exactly PAGE_SIZE (20) cards").toBe(20);
}

function browseEnvelope(items: unknown[], hasNextPage = true): unknown {
  return {
    result: {
      data: {
        json: { items, hasNextPage },
      },
    },
  };
}

test.describe("@public IPE-069R4E fixture attestation decision matrix", () => {
  test("HTTP 200 + valid envelope with 20 items → VALID_FIXTURE_READY", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: browseEnvelope(Array.from({ length: 20 }, (_v, i) => ({ id: i }))),
    });
    expect(decision.state).toBe("VALID_FIXTURE_READY");
    expect(decision.attestedCount).toBe(20);
  });

  test("HTTP 200 + valid envelope with 5 items → VALID_FIXTURE_ABSENT (skip with reason)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: browseEnvelope(Array.from({ length: 5 }, (_v, i) => ({ id: i }))),
    });
    expect(decision.state).toBe("VALID_FIXTURE_ABSENT");
    expect(decision.reason).toContain("5");
  });

  test("HTTP 200 + missing result envelope → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: { notResult: true },
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
    expect(decision.reason).toContain("result");
  });

  test("HTTP 200 + missing result.data.json envelope → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: { result: { data: { notJson: true } } },
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
    expect(decision.reason).toContain("json");
  });

  test("HTTP 200 + items not an array → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: browseEnvelope({ unexpected: "shape" } as unknown as unknown[]),
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
    expect(decision.reason).toContain("items");
  });

  test("HTTP 200 + hasNextPage not a boolean → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: true,
      body: {
        result: {
          data: {
            json: {
              items: Array.from({ length: 20 }, (_v, i) => ({ id: i })),
              hasNextPage: "yes",
            },
          },
        },
      },
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
    expect(decision.reason).toContain("hasNextPage");
  });

  test("HTTP error status → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 500,
      jsonParsed: true,
      body: browseEnvelope(Array.from({ length: 20 }, (_v, i) => ({ id: i }))),
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
  });

  test("malformed JSON body → INVALID_API_RESPONSE (FAIL)", () => {
    const decision = attestCatalogFixtureResponse({
      httpStatus: 200,
      jsonParsed: false,
      body: null,
    });
    expect(decision.state).toBe("INVALID_API_RESPONSE");
  });

  test("attested fixture + UI renders 19 cards → assertion FAILS (count mismatch detected)", () => {
    expect(() => assertAttestedCatalogCardCount("VALID_FIXTURE_READY", 19)).toThrow(/exactly PAGE_SIZE \(20\) cards/);
  });

  test("attested fixture + UI renders exactly 20 cards → assertion passes", () => {
    expect(() => assertAttestedCatalogCardCount("VALID_FIXTURE_READY", 20)).not.toThrow();
  });

  test("non-attested state cannot assert a card count at all", () => {
    expect(() => assertAttestedCatalogCardCount("VALID_FIXTURE_ABSENT", 20)).toThrow(/card count cannot be asserted/);
  });
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
          const covers = await page.locator(".ipe-novel-card").evaluateAll((cards) =>
            cards.map((card) => {
              const heading = card.querySelector("h3")?.textContent?.trim() ?? "";
              const images = Array.from(card.querySelectorAll("img")) as HTMLImageElement[];
              const placeholder = card.querySelector(".ipe-cover-placeholder span")?.textContent?.trim() ?? "";
              return {
                heading,
                imageCount: images.length,
                broken: images.filter((image) => image.naturalWidth <= 0).length,
                placeholder,
              };
            })
          );
          for (const cover of covers) {
            if (cover.imageCount > 0) {
              expect(cover.broken, cover.heading).toBe(0);
              expect(cover.placeholder).toBe("");
            } else if (cover.heading) {
              expect(cover.placeholder).toBe(cover.heading);
            } else {
              expect(cover.placeholder).toBe("ไม่มีภาพปก");
            }
          }
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