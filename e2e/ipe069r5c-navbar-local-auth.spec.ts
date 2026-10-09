import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoOk } from "./support/runtime";
import { e2eBaseUrl } from "./support/env";

// IPE-069R5C — authenticated LOCAL navbar qualification. No live user or
// production cookie is ever used. The local-only guard runs before reading
// any session cookie; Playwright traces and videos are disabled for this project.
const testDir = path.dirname(fileURLToPath(import.meta.url));
// e2e -> worktree root -> .worktrees -> repo parent: deterministic location
// OUTSIDE any repository checkout, overridable for other machines.
const evidenceRoot =
  process.env.E2E_NAV_EVIDENCE_DIR?.trim() ||
  path.resolve(testDir, "..", "..", "..", "..", "evidence", "IPE-069R5C-navbar");
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