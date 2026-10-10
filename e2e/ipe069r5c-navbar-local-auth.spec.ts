import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoOk } from "./support/runtime";
import { e2eBaseUrl } from "./support/env";

// IPE-069R5C — authenticated LOCAL navbar qualification. No live user or
// production cookie is ever used. The local-only guard runs before reading
// any session cookie; Playwright traces and videos are disabled for this project.
const testDir = path.dirname(fileURLToPath(import.meta.url));
// The default must be writable in ordinary Linux/macOS/Windows checkouts,
// not depend on a particular .worktrees directory nesting depth.
const evidenceRoot = process.env.E2E_NAV_EVIDENCE_DIR?.trim() ||
  path.join(tmpdir(), "IPE-069R5C-navbar");
const cookiesFile = process.env.E2E_SESSION_COOKIES_FILE?.trim() || "";

type LocalFixtureCookies = { cookieName: string; adminToken: string; userToken: string };
let cookies: LocalFixtureCookies | null = null;

function isStrictLocalUrl(url: URL): boolean {
  return url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

const widths = [320, 390, 768, 1024, 1280, 1440, 1920] as const;

async function loginAs(context: import("@playwright/test").BrowserContext, role: "user" | "admin") {
  // Verify the target again at the actual point of cookie attachment.
  const target = new URL(e2eBaseUrl);
  if (!isStrictLocalUrl(target) || !cookies) {
    throw new Error("Refusing fixture session on a non-local or uninitialized target");
  }
  const token = role === "admin" ? cookies.adminToken : cookies.userToken;
  await context.addCookies([
    { name: cookies.cookieName, value: token, url: target.origin },
  ]);
}

// Local-only guard: every test in this file is skipped unless the target is
// local AND the fixture cookie file exists. Never runs against a remote host.
test.beforeEach(async ({ baseURL }) => {
  const target = new URL(baseURL ?? e2eBaseUrl);
  // Fail closed before opening or parsing ANY fixture secret on remote targets.
  test.skip(!isStrictLocalUrl(target) || !isStrictLocalUrl(new URL(e2eBaseUrl)),
    "Fixture-session tests may run only on an explicit local HTTP target");
  test.skip(!cookiesFile || !path.isAbsolute(cookiesFile) || !existsSync(cookiesFile),
    "Local fixture session file is not configured; set E2E_SESSION_COOKIES_FILE");
  // Operator assertion after an independent, read-only test-DB binding check.
  // A local hostname does NOT, on its own, prove the backend uses test data.
  if (process.env.E2E_LOCAL_DB_ATTESTED !== "ipenovel_test") {
    throw new Error("Refusing local session fixture without explicit ipenovel_test isolation attestation");
  }
  const raw: unknown = JSON.parse(readFileSync(cookiesFile, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Invalid local fixture-session file");
  const c = raw as Record<string, unknown>;
  if (typeof c.cookieName !== "string" || typeof c.userToken !== "string" ||
      typeof c.adminToken !== "string" || !c.cookieName || !c.userToken || !c.adminToken) {
    throw new Error("Local fixture-session file is missing required fields");
  }
  const checkoutRoot = path.resolve(testDir, "..");
  const captures = path.resolve(evidenceRoot);
  if (captures === checkoutRoot || captures.startsWith(checkoutRoot + path.sep)) {
    throw new Error("Fixture screenshots must be stored outside the repository");
  }
  cookies = { cookieName: c.cookieName, userToken: c.userToken, adminToken: c.adminToken };
});

test.describe("@local-fixture IPE-069R5C navbar roles × viewports (local fixtures)", () => {
  for (const role of ["guest", "user", "admin"] as const) {
    test(`navbar ${role}: renders at 7 viewports without horizontal overflow`, async ({ page }) => {
      if (role !== "guest") await loginAs(page.context(), role);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await gotoOk(page, "/novels");
        await expect(page.locator(".ipe-public-nav")).toBeVisible();
        await expect(page.locator(".ipe-public.ipe-catalog")).toBeVisible();
        await expect(page.locator(".ipe-novel-card").first()).toBeVisible();
        // Catalog must be hydrated, not a transient auth or route spinner.
        await page.waitForFunction(() => {
          const catalog = document.querySelector(".ipe-public.ipe-catalog");
          const cards = [...document.querySelectorAll(".ipe-novel-card")];
          return Boolean(catalog) && cards.length > 0 &&
            !catalog?.querySelector(".animate-pulse") &&
            cards.every(card => [...card.querySelectorAll("img")].every(img => img.complete));
        }, undefined, { timeout: 15_000 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${role} @${width}px overflow`).toBeLessThanOrEqual(1);
        mkdirSync(evidenceRoot, { recursive: true });
        await page.screenshot({
          path: path.join(evidenceRoot, `navbar-${role}-${width}.png`),
          fullPage: false,
          animations: "disabled",
        });
      }
    });
  }

  test("guest: Login CTA visible, no More/Account menus, Browse is active", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    await expect(page.locator(".ipe-public-nav").getByText(/เรียกดู|Browse/)).toBeVisible();
    await expect(page.locator(".ipe-public-nav .ipe-nav-link-active")).toHaveText(/เรียกดู|Browse/);
    await expect(page.locator("#ipe-more-menu")).toHaveCount(0);
    await expect(page.locator("#ipe-account-menu")).toHaveCount(0);
    await expect(page.locator(".ipe-public-nav").getByText(/เข้าสู่ระบบ|Login/)).toBeVisible();
  });

  test("user: More + Account dropdowns open/close with Escape, outside press, focus restore; cart badge = 2", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    // Cart badge from the seeded cart (2 items) — first() covers desktop +
    // mobile badges rendering together at wide viewports.
    await expect(page.locator(".ipe-public-nav").getByText("2").first()).toBeVisible();
    // More dropdown (disclosure pattern)
    const moreToggle = page.locator(".ipe-public-nav").getByText(/More|เพิ่มเติม/).first();
    await moreToggle.click();
    const morePanel = page.locator("#ipe-more-menu");
    await expect(morePanel).toBeVisible();
    await expect(moreToggle).toHaveAttribute("aria-expanded", "true");
    await expect(moreToggle).toHaveAttribute("aria-controls", "ipe-more-menu");
    await expect(morePanel.getByText(/กระเป๋าเงิน|Wallet/)).toBeVisible();
    await expect(morePanel.getByText(/พอยท์|Points/)).toBeVisible();
    await expect(morePanel.getByText(/Football Votes/)).toBeVisible();
    // Escape closes and restores focus to the toggle
    await page.keyboard.press("Escape");
    await expect(moreToggle).toHaveAttribute("aria-expanded", "false");
    await expect(moreToggle).toBeFocused();
    // Outside press closes
    await moreToggle.click();
    await expect(morePanel).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(moreToggle).toHaveAttribute("aria-expanded", "false");
    // Account dropdown: profile + recovery visible; admin item absent for user
    const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await accountToggle.click();
    const accountPanel = page.locator("#ipe-account-menu");
    await expect(accountPanel).toBeVisible();
    await expect(accountPanel.getByText(/โปรไฟล์|Profile/)).toBeVisible();
    await expect(accountPanel.getByText(/กู้คืนบัญชี|Recover/)).toBeVisible();
    await expect(accountPanel.getByRole("button", { name: /ผู้ดูแล/ })).toHaveCount(0);
    await expect(accountPanel.getByText(/ออกจากระบบ|Logout/)).toBeVisible();
    // Escape closes account panel with focus restoration
    await page.keyboard.press("Escape");
    await expect(accountToggle).toHaveAttribute("aria-expanded", "false");
    await expect(accountToggle).toBeFocused();
  });

  test("admin: account menu contains Admin navigation item (user role does not)", async ({ page }) => {
    await loginAs(page.context(), "admin");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await accountToggle.click();
    const accountPanel = page.locator("#ipe-account-menu");
    await expect(accountPanel).toBeVisible();
    await expect(accountPanel.getByRole("button", { name: /ผู้ดูแล/ })).toBeVisible();
  });

  test("user: logout returns the navbar to guest state (real local session)", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await accountToggle.click();
    await page.locator("#ipe-account-menu").getByText(/ออกจากระบบ|Logout/).click();
    // Real local logout: auth.me resolves anonymous → the account toggle is
    // removed and the guest navbar (Login CTA) returns.
    await expect(page.locator(".ipe-public-nav").getByText(/เข้าสู่ระบบ|Login/)).toBeVisible();
    await expect(page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']")).toHaveCount(0);
  });

  test("keyboard: Tab reaches the disclosure panels' items after opening", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    await page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']").click();
    await expect(page.locator("#ipe-account-menu")).toBeVisible();
    await page.keyboard.press("Tab");
    const inPanel = await page.evaluate(() =>
      document.getElementById("ipe-account-menu")?.contains(document.activeElement)
    );
    expect(inPanel).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// IPE-069R5F — bounded P2 repairs regression
// ---------------------------------------------------------------------------

test.describe("@local-fixture IPE-069R5F navbar P2 repairs", () => {
  test("P2-01: More toggle shows active state on wallet/points/sports-votes routes", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    const moreToggle = page.locator(".ipe-public-nav").getByText(/More|เพิ่มเติม/).first();
    // /wallet and /sports-votes hard-load fine (their pages do not bounce
    // while auth.me is still resolving).
    for (const route of ["/wallet", "/sports-votes"]) {
      await gotoOk(page, route);
      await expect(moreToggle).toHaveClass(/ipe-nav-link-active/);
      // aria-current stays on the navigation item, not on the toggle
      await expect(moreToggle).not.toHaveAttribute("aria-current", "page");
    }
    // /points: PointsPage redirects a hard load to / while auth.me is still
    // resolving (pre-existing page behavior, outside this repair scope) —
    // verify the active state through the real user flow instead: click
    // the dropdown item, land on /points via SPA navigation.
    await gotoOk(page, "/novels");
    await moreToggle.click();
    await page.locator("#ipe-more-menu").getByText(/พอยท์|Points/).click();
    await expect(page).toHaveURL(/points/);
    await expect(moreToggle).toHaveClass(/ipe-nav-link-active/);
    // A non-More route must NOT light the More toggle
    await gotoOk(page, "/novels");
    await expect(page.locator(".ipe-public-nav").getByText(/More|เพิ่มเติม/).first()).not.toHaveClass(/ipe-nav-link-active/);
  });

  test("P2-01: Account toggle shows active state on profile route", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/profile");
    const userAccountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await expect(userAccountToggle).toHaveClass(/ipe-nav-link-active/);
    // …and returns to inactive on a non-account route
    await gotoOk(page, "/novels");
    await expect(userAccountToggle).not.toHaveClass(/ipe-nav-link-active/);
  });

  test("P2-01: on /admin the global navbar stays hidden (admin owns its navigation)", async ({ page }) => {
    // Existing contract: /admin hides the storefront navbar entirely, so
    // there is no toggle to mark active there — assert the hiding instead.
    await loginAs(page.context(), "admin");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/admin");
    await expect(page.locator(".ipe-public-nav")).toHaveCount(0);
  });

  test("P2-02: breakpoint resize closes layers and never leaves duplicate menu ids", async ({ page }) => {
    await loginAs(page.context(), "user");
    // Mobile: open the mobile menu (which contains the mobile More group)
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    await page.getByRole("button", { name: /เปิดเมนู|Open menu/ }).click();
    await expect(page.locator("#ipe-mobile-navigation")).toBeVisible();
    // Resize Mobile -> Desktop: the mobile menu must close, and the desktop
    // More dropdown may then open with a UNIQUE panel id.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#ipe-mobile-navigation")).toHaveCount(0);
    const moreToggle = page.locator(".ipe-public-nav").getByText(/More|เพิ่มเติม/).first();
    await moreToggle.click();
    await expect(page.locator("#ipe-more-menu")).toBeVisible();
    await expect(page.locator("[id='ipe-more-menu']")).toHaveCount(1);
    // Desktop -> Mobile with the desktop dropdown open: it must not linger.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']")).toHaveAttribute("aria-expanded", "false");
  });

  test("P2-02: keyboard + outside-press dismissal still work after resize", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await accountToggle.click();
    await expect(page.locator("#ipe-account-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(accountToggle).toHaveAttribute("aria-expanded", "false");
    await expect(accountToggle).toBeFocused();
    await accountToggle.click();
    await page.mouse.click(10, 400);
    await expect(accountToggle).toHaveAttribute("aria-expanded", "false");
  });
});

// IPE-069R5I — Codex exact-head P2: mobile focus and dismissal regressions.
test.describe("@local-fixture IPE-069R5I mobile navigation Codex fixes", () => {
  test("P2-01: Escape from a focused mobile menu item restores hamburger focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await hamburger.click();
    const mobile = page.locator("#ipe-mobile-navigation");
    await expect(mobile).toBeVisible();
    const firstItem = mobile.locator("button").first();
    await firstItem.focus();
    await expect(firstItem).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(mobile).toHaveCount(0);
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(hamburger).toBeFocused();
  });

  test("P2-02: pointer outside the expanded mobile navigation dismisses it", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await hamburger.click();
    await expect(page.locator("#ipe-mobile-navigation")).toBeVisible();
    // The blank space between the brand and language/cart controls is
    // inside the navbar header but outside both the toggle and mobile panel.
    await page.mouse.click(160, 32);
    await expect(page.locator("#ipe-mobile-navigation")).toHaveCount(0);
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(/\/novels$/);
  });

  test("P2-03: tapping the current More destination closes the mobile navigation", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    const mobile = page.locator("#ipe-mobile-navigation");
    await hamburger.click();
    await mobile.getByRole("button", { name: /กระเป๋าเงิน|Wallet/ }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(mobile).toHaveCount(0);

    // Reopen on /wallet, then tap Wallet again without changing the URL.
    await hamburger.click();
    await expect(mobile).toBeVisible();
    await mobile.getByRole("button", { name: /กระเป๋าเงิน|Wallet/ }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(mobile).toHaveCount(0);
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });
});

// IPE-069R5L-R1 — nullable account names must still yield meaningful
// visible and accessible account-toggle labels without mutating test DB users.
test.describe("@local-fixture IPE-069R5L-R1 account accessibility", () => {
  for (const sample of [
    { description: "null", name: null },
    { description: "empty", name: "" },
    { description: "whitespace-only", name: "   " },
  ]) {
    test(`P2 account name ${sample.description}: localized fallback remains visible and accessible`, async ({ page }) => {
      await loginAs(page.context(), "user");
      await page.setViewportSize({ width: 1440, height: 900 });
      let intercepted = 0;
      // Override only auth.me responses from the real local backend.
      // Preserve all other API behavior, cookies, and user fields.
      await page.route("**/api/trpc/**", async (route) => {
        const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
        const procedures = pathname.split("/api/trpc/")[1]?.split(",") ?? [];
        if (!procedures.includes("auth.me")) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const payload = await response.json();
        const envelopes = Array.isArray(payload) ? payload : [payload];
        for (const [index, envelope] of envelopes.entries()) {
          if (procedures[index] !== "auth.me") continue;
          const sessionUser = envelope?.result?.data?.json;
          if (sessionUser && typeof sessionUser === "object") {
            sessionUser.name = sample.name;
            intercepted += 1;
          }
        }
        await route.fulfill({ response, json: payload });
      });

      await gotoOk(page, "/novels");
      const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
      await expect(accountToggle).toBeVisible();
      expect(intercepted).toBeGreaterThan(0);
      await expect(accountToggle).toHaveAttribute("aria-label", "บัญชี");
      await expect(accountToggle.getByText("บัญชี", { exact: true })).toBeVisible();
      await accountToggle.click();
      await expect(page.locator("#ipe-account-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(accountToggle).toBeFocused();

      await page.getByRole("button", { name: "Switch to English" }).click();
      await expect(accountToggle).toHaveAttribute("aria-label", "Account");
      await expect(accountToggle.getByText("Account", { exact: true })).toBeVisible();
    });
  }

  test("P2 account name present: first-name display and accessible account label are retained", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const accountToggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await expect(accountToggle).toBeVisible();
    await expect(accountToggle).toHaveAttribute("aria-label", "บัญชี");
    await expect(accountToggle.getByText("Test", { exact: true })).toBeVisible();
    await accountToggle.click();
    await expect(page.locator("#ipe-account-menu")).toBeVisible();
  });
});


// IPE-069R5L-R4B — consolidated focus, disclosure, failure and path regressions.
test.describe("@local-fixture IPE-069R5L-R4B consolidated navbar repairs", () => {
  test("More same-route keyboard selection restores focus to the disclosure", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/wallet");
    const toggle = page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const item = page.locator("#ipe-more-menu").getByRole("button", { name: /กระเป๋าเงิน|Wallet/ });
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.locator("#ipe-more-menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("More cross-route selection retains navigation focus on the disclosure", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/wallet");
    const toggle = page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']");
    await toggle.click();
    const item = page.locator("#ipe-more-menu").getByRole("button", { name: /Football Votes/ });
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sports-votes$/);
    await expect(page.locator("#ipe-more-menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("Account same-route selection preserves focus and closes the menu", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/profile");
    const toggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await toggle.click();
    const item = page.locator("#ipe-account-menu").getByRole("button", { name: /โปรไฟล์|Profile/ });
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ipe-account-menu")).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("More and Account disclosures are mutually exclusive on keyboard activation", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const more = page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']");
    const account = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ipe-more-menu")).toBeVisible();
    await account.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ipe-more-menu")).toHaveCount(0);
    await expect(page.locator("#ipe-account-menu")).toBeVisible();
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ipe-account-menu")).toHaveCount(0);
    await expect(page.locator("#ipe-more-menu")).toBeVisible();
  });

  test("Mobile same-route selection restores hamburger focus", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const toggle = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await toggle.click();
    const item = page.locator("#ipe-mobile-navigation").getByRole("button", { name: /เรียกดู|Browse/ });
    await item.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ipe-mobile-navigation")).toHaveCount(0);
    await expect(toggle).toBeFocused();
  });

  test("Logout transport failure preserves authentication and shows an error", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    let blocked = 0;
    await page.route("**/api/trpc/auth.logout*", async route => {
      blocked += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Local synthetic network failure", code: -32603, data: { code: "INTERNAL_SERVER_ERROR" } } }),
      });
    });
    await gotoOk(page, "/novels");
    const toggle = page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']");
    await toggle.click();
    await page.locator("#ipe-account-menu").getByRole("button", { name: /ออกจากระบบ|Logout/ }).click();
    await expect(page.getByText(/ออกจากระบบไม่สำเร็จ|Unable to sign out/)).toBeVisible();
    expect(blocked).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/novels$/);
    await expect(toggle).toBeVisible();
  });

  test("Evidence default is independent of checkout nesting on POSIX and Windows", () => {
    const expected = "IPE-069R5C-navbar";
    expect(path.basename(path.join(tmpdir(), expected))).toBe(expected);
    const linux = path.posix.join("/tmp", expected);
    const windows = path.win32.join("C:\\Users\\Public\\AppData\\Local\\Temp", expected);
    expect(linux.startsWith("/tmp/")).toBe(true);
    expect(windows.endsWith(expected)).toBe(true);
    // An explicitly selected evidence path must be outside checkout (checked
    // in beforeEach), while the fallback always uses the OS temporary folder.
    if (!process.env.E2E_NAV_EVIDENCE_DIR?.trim()) {
      expect(evidenceRoot).toBe(path.join(tmpdir(), expected));
    }
  });
});


test.describe("@local-fixture IPE-069R5L-R4B extended focus lifecycle", () => {
  test("Admin destination moves focus to the new page when the public navbar disappears", async ({ page }) => {
    await loginAs(page.context(), "admin");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    await page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']").click();
    const adminDestination = page.locator("#ipe-account-menu").getByRole("button", { name: /ผู้ดูแล|Admin/ });
    await adminDestination.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator(".ipe-public-nav")).toHaveCount(0);
    const heading = page.locator("main h1:visible, main h2:visible, h1:visible, h2:visible").first();
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
  });

  test("Resize while focused in mobile navigation does not strand focus on body", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await hamburger.click();
    await page.locator("#ipe-mobile-navigation button").first().focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#ipe-mobile-navigation")).toHaveCount(0);
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      nav: Boolean(document.querySelector(".ipe-public-nav")?.contains(document.activeElement)),
    }));
    expect(active.tag).not.toBe("BODY");
    expect(active.nav).toBe(true);
  });
});


test.describe("@local-fixture IPE-069R5L-R4B bidirectional accessibility", () => {
  test("Desktop dropdown focus transfers to hamburger when resized to mobile", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoOk(page, "/novels");
    const more = page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']");
    await more.click();
    await page.locator("#ipe-more-menu").getByRole("button", { name: /กระเป๋าเงิน|Wallet/ }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#ipe-more-menu")).toHaveCount(0);
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await expect(hamburger).toBeFocused();
  });

  test("Mobile Admin navigation focuses visible destination heading", async ({ page }) => {
    await loginAs(page.context(), "admin");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    await page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']").click();
    const adminDestination = page.locator("#ipe-mobile-navigation").getByRole("button", { name: /ผู้ดูแล|Admin/ });
    await adminDestination.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator(".ipe-public-nav")).toHaveCount(0);
    const heading = page.locator("main h1:visible, main h2:visible, h1:visible, h2:visible").first();
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
  });
});


test.describe("@local-fixture IPE-069R5L-R4C-R1 deterministic focus repair", () => {
  for (const viewport of [
    { label: "desktop", width: 1440, height: 900 },
    { label: "mobile", width: 390, height: 844 },
  ] as const) {
    test(`${viewport.label}: successful logout focuses the visible guest Login CTA`, async ({ page }) => {
      await loginAs(page.context(), "user");
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await gotoOk(page, "/novels");
      if (viewport.label === "desktop") {
        await page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']").click();
        const logout = page.locator("#ipe-account-menu").getByRole("button", { name: /ออกจากระบบ|Logout/ });
        await logout.focus();
        await page.keyboard.press("Enter");
      } else {
        await page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']").click();
        const logout = page.locator("#ipe-mobile-navigation").getByRole("button", { name: /ออกจากระบบ|Logout/ });
        await logout.focus();
        await page.keyboard.press("Enter");
      }
      await expect(page).toHaveURL((url) => url.pathname === "/");
      await expect(page.locator(".ipe-public-nav [aria-controls='ipe-account-menu']")).toHaveCount(0);
      if (viewport.label === "desktop") {
        const login = page.locator(".ipe-public-nav [data-ipe-login-focus]:visible");
        await expect(login).toBeVisible();
        await expect(login).toBeFocused();
      } else {
        // Guest Login is inside the collapsed mobile panel: the remaining
        // hamburger is the correct keyboard focus destination.
        const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
        await expect(hamburger).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("#ipe-mobile-navigation [data-ipe-login-focus]")).toBeVisible();
      }
    });
  }

  test("mobile-to-desktop resize restores focus to the surviving More toggle", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await hamburger.click();
    const item = page.locator("#ipe-mobile-navigation").getByRole("button", { name: /กระเป๋าเงิน|Wallet/ });
    await item.focus();
    await expect(item).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#ipe-mobile-navigation")).toHaveCount(0);
    const more = page.locator(".ipe-public-nav [aria-controls='ipe-more-menu']");
    await expect(more).toBeVisible();
    await expect(more).toBeFocused();
    const result = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inNav: Boolean(document.querySelector(".ipe-public-nav")?.contains(document.activeElement)) }));
    expect(result).toEqual({ tag: "BUTTON", inNav: true });
  });
});


test.describe("@local-fixture IPE-069R5L-R4C-R1 logout failure focus", () => {
  test("mobile failed logout stays authenticated and keeps hamburger focus", async ({ page }) => {
    await loginAs(page.context(), "user");
    await page.setViewportSize({ width: 390, height: 844 });
    let failures = 0;
    await page.route("**/api/trpc/auth.logout*", async route => {
      failures += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Local synthetic failure", code: -32603, data: { code: "INTERNAL_SERVER_ERROR" } } }),
      });
    });
    await gotoOk(page, "/novels");
    const hamburger = page.locator(".ipe-public-nav [aria-controls='ipe-mobile-navigation']");
    await hamburger.click();
    const logout = page.locator("#ipe-mobile-navigation").getByRole("button", { name: /ออกจากระบบ|Logout/ });
    await logout.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/ออกจากระบบไม่สำเร็จ|Unable to sign out/)).toBeVisible();
    expect(failures).toBeGreaterThan(0);
    await expect(page).toHaveURL((url) => url.pathname === "/novels");
    await expect(hamburger).toBeFocused();
    await hamburger.click();
    await expect(page.locator("#ipe-mobile-navigation").getByRole("button", { name: /โปรไฟล์|Profile/ })).toBeVisible();
  });
});
