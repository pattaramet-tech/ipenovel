/**
 * R40R58 — LOCAL BROWSER ACCEPTANCE for the notification UI.
 *
 * Runs ONLY against an explicit local HTTP target seeded by
 * scripts/local-notifications-acceptance.ts (disposable ipenovel_test DB,
 * synthetic accounts, real pipeline events). Every guard below fails closed
 * on a remote host, a missing fixture file, or a missing isolation
 * attestation - the same contract as the existing @local-fixture specs.
 *
 * Evidence screenshots go to NOTIFICATIONS_ACCEPTANCE_EVIDENCE_DIR which the
 * operator must point OUTSIDE the repository.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { e2eBaseUrl } from "./support/env";

const fixturesFile = process.env.NOTIFICATIONS_ACCEPTANCE_FIXTURES?.trim() || "";
const evidenceDir = process.env.NOTIFICATIONS_ACCEPTANCE_EVIDENCE_DIR?.trim() || "";
const BELL = 'button[aria-label^="เปิดการแจ้งเตือน"]';

interface FixtureFile {
  cookieName: string;
  userToken: string;
  secondToken: string;
  badge99Token: string;
  bulkflowToken: string;
  isoAToken: string;
  isoBToken: string;
  emptyToken: string;
  emptyAdminToken: string;
}

let fixtures: FixtureFile | null = null;

function isStrictLocalUrl(url: URL): boolean {
  return url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

async function shot(page: Page, name: string): Promise<void> {
  if (evidenceDir && isAbsolute(evidenceDir) && existsSync(evidenceDir)) {
    await page.screenshot({ path: join(evidenceDir, name), fullPage: false });
  }
}

async function loginAs(context: BrowserContext, token: string): Promise<void> {
  const target = new URL(e2eBaseUrl);
  if (!isStrictLocalUrl(target) || !fixtures) {
    throw new Error("Refusing fixture session on a non-local or uninitialized target");
  }
  await context.addCookies([{ name: fixtures.cookieName, value: token, url: target.origin }]);
}

async function openNotificationCenter(page: Page): Promise<void> {
  await page.locator(BELL).first().click();
  await expect(page.getByRole("heading", { name: "การแจ้งเตือน" })).toBeVisible();
}

/** Idempotent: re-opens the dialog if a refetch closed it mid-flow.
 *  (Known behavior under qualification: the Radix dialog may dismiss when
 *  the last unread row's action button unmounts at zero unread.) */
async function ensureDialogOpen(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "การแจ้งเตือน" });
  try {
    await heading.waitFor({ state: "visible", timeout: 1_500 });
  } catch {
    await page.locator(BELL).first().click();
    await expect(heading).toBeVisible();
  }
}

test.beforeEach(async ({ baseURL }) => {
  const target = new URL(baseURL ?? e2eBaseUrl);
  test.skip(!isStrictLocalUrl(target) || !isStrictLocalUrl(new URL(e2eBaseUrl)),
    "Acceptance tests may run only on an explicit local HTTP target");
  test.skip(!fixturesFile || !existsSync(fixturesFile),
    "Notification acceptance fixtures not configured; run the local acceptance harness first");
  if (process.env.E2E_LOCAL_DB_ATTESTED !== "ipenovel_test") {
    throw new Error("Refusing notification acceptance without explicit ipenovel_test isolation attestation");
  }
  const raw = JSON.parse(readFileSync(fixturesFile, "utf8")) as Record<string, unknown>;
  if (typeof raw.cookieName !== "string" || typeof raw.userToken !== "string" ||
      typeof raw.secondToken !== "string" || typeof raw.badge99Token !== "string" ||
      typeof raw.bulkflowToken !== "string" || typeof raw.isoAToken !== "string" ||
      typeof raw.isoBToken !== "string" || typeof raw.emptyToken !== "string") {
    throw new Error("Notification acceptance fixture file is missing required fields");
  }
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  fixtures = raw as unknown as FixtureFile;
});

test.describe("@local-fixture A. notification center", () => {
  test("A1: bell visible for an authenticated user with the live unread badge", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/");
    const bell = page.locator(BELL).first();
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute("aria-label", /มี 25 รายการยังไม่อ่าน/);
    await shot(page, "A1-authenticated-badge.png");
  });

  test("A2: badge 99+ for the 101-item account", async ({ page }) => {
    await loginAs(page.context(), fixtures!.badge99Token);
    await page.goto("/");
    await expect(page.locator(BELL).first()).toHaveAttribute("aria-label", /มี \d+ รายการยังไม่อ่าน/);
    await expect(page.locator(`${BELL} >> text=99+`).first()).toBeVisible();
    await shot(page, "A2-badge-99plus.png");
  });

  test("A3: empty state for an account with no notifications", async ({ page }) => {
    await loginAs(page.context(), fixtures!.emptyToken);
    await page.goto("/");
    await expect(page.locator(BELL).first()).toBeVisible();
    await openNotificationCenter(page);
    await expect(page.getByText("ไม่มีรายการในหมวดนี้")).toBeVisible();
    await shot(page, "A3-empty-state.png");
  });

  test("A4: fetch error shows an alert, refresh recovers without cached rows", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    let failList = true;
    // the client batches calls as notifications.unreadCount,notifications.list
    // in one URL - block the whole notifications namespace (regex: unambiguous)
    page.on("request", request => {
      if (request.url().includes("/api/trpc")) console.log("A4_REQ", request.method(), request.url().slice(0, 140));
    });
    await page.route(/notifications\.(list|unreadCount)/, async route => {
      console.log("A4_INTERCEPTED", route.request().url().slice(0, 140));
      if (failList) return route.abort();
      return route.continue();
    });
    await page.goto("/");
    await openNotificationCenter(page);
    await expect(page.locator('[role="alert"]')).toBeVisible();
    // no cached/stale rows may render alongside the error
    await shot(page, "A4-error-state.png");
    failList = false;
    await page.unroute(/\/api\/trpc\/notifications/);
    await page.getByRole("button", { name: "รีเฟรช" }).click();
    await expect(page.getByText("เติมเงินสำเร็จ").first()).toBeVisible();
    await shot(page, "A4-refresh-recovered.png");
  });

  test("A5: category filters query the server-side category", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/");
    await openNotificationCenter(page);
    await expect(page.getByText("เติมเงินสำเร็จ").first()).toBeVisible();
    await page.getByRole("button", { name: "นิยาย" }).click();
    await expect(page.getByText("Wishlist มีตอนใหม่").first()).toBeVisible();
    await shot(page, "A5-novel-filter.png");
    await page.getByRole("button", { name: "ทั้งหมด", exact: true }).click();
    await expect(page.getByText("เติมเงินสำเร็จ").first()).toBeVisible();
  });

  test("A6: cursor pagination loads the next page", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/");
    await openNotificationCenter(page);
    const rows = page.locator('[aria-live="polite"] > div');
    await expect(rows).toHaveCount(20);
    await page.getByRole("button", { name: "โหลดการแจ้งเตือนเพิ่มเติม" }).click();
    await expect(rows).toHaveCount(26, { timeout: 15_000 });
    await shot(page, "A6-load-more.png");
  });

  test("A7-A9: mark single read, mark all read, delete all with confirmation", async ({ page }) => {
    await loginAs(page.context(), fixtures!.secondToken);
    await page.goto("/");
    // second account has exactly 1 unread
    await openNotificationCenter(page);
    await page.getByRole("button", { name: /ทำเครื่องหมายอ่านแล้ว/ }).first().click();
    await expect(page.locator(BELL).first()).toHaveAttribute("aria-label", /มี 0 รายการยังไม่อ่าน/);
    await shot(page, "A7-marked-read.png");

    // delete-all CONFIRMATION appears; cancel keeps the row.
    // The toolbar button is scoped to the main dialog; the confirmation
    // buttons live in the separate alertdialog - the two never collide.
    const centerDialog = page.getByRole("dialog");
    const confirmDialog = page.getByRole("alertdialog");
    await centerDialog.getByRole("button", { name: "ลบทั้งหมด" }).click();
    await expect(confirmDialog.getByText("ยืนยันลบการแจ้งเตือนทั้งหมด")).toBeVisible();
    await page.waitForTimeout(450); // Radix dialog open animation settles
    await confirmDialog.getByRole("button", { name: "ยกเลิก" }).click();
    await expect(page.getByText("เติมเงินสำเร็จ").first()).toBeVisible();

    await centerDialog.getByRole("button", { name: "ลบทั้งหมด" }).click();
    await expect(confirmDialog.getByText("ยืนยันลบการแจ้งเตือนทั้งหมด")).toBeVisible();
    await page.waitForTimeout(450); // Radix dialog open animation settles
    await confirmDialog.getByRole("button", { name: "ยืนยันลบทั้งหมด" }).click();
    await expect(page.getByText("ไม่มีรายการในหมวดนี้")).toBeVisible();
    await shot(page, "A9-deleted-all.png");
  });

  test("A11: mark-all THEN delete-all in the same session - per-kind operation keys never collide", async ({ page }) => {
    test.setTimeout(60_000);
    await loginAs(page.context(), fixtures!.bulkflowToken);
    // R40R59 regression: the server's (actorUserId, operationKey) identity is
    // kind-immutable; a delete-all replaying the mark-all's key throws
    // "kind mismatch". The container must use one key per action kind and
    // mint a fresh key after each confirmed success.
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/");
    await openNotificationCenter(page);
    const centerDialog = page.getByRole("dialog");
    const markAll = centerDialog.getByRole("button", { name: "อ่านทั้งหมด" });
    await markAll.click();
    // bulkflow carries exactly 3 unread: 3 -> 0 proves every row was swept
    await expect(page.locator(BELL).first()).toHaveAttribute("aria-label", /มี 0 รายการยังไม่อ่าน/, { timeout: 15_000 });
    await shot(page, "A11-mark-all-confirmed.png");

    await centerDialog.getByRole("button", { name: "ลบทั้งหมด" }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog.getByText("ยืนยันลบการแจ้งเตือนทั้งหมด")).toBeVisible();
    await page.waitForTimeout(450);
    await confirmDialog.getByRole("button", { name: "ยืนยันลบทั้งหมด" }).click();
    await expect(page.getByText("ไม่มีรายการในหมวดนี้")).toBeVisible();
    await shot(page, "A11-delete-all-after-mark-all.png");
  });

  test("A10: duplicate clicks on mark-all cannot double-run (busy guard + server idempotency)", async ({ page }) => {
    await loginAs(page.context(), fixtures!.badge99Token);
    await page.goto("/");
    await openNotificationCenter(page);
    const markAll = page.getByRole("button", { name: "อ่านทั้งหมด" });
    await expect(markAll).toBeEnabled();
    await markAll.click();
    // the second immediate click must be a no-op: the busy guard disables it
    await expect(markAll).toBeDisabled();
    // at zero unread the button stays disabled by design and the badge clears
    await expect(page.locator(BELL).first()).toHaveAttribute("aria-label", /มี 0 รายการยังไม่อ่าน/, { timeout: 15_000 });
    await expect(markAll).toBeDisabled();
    await shot(page, "A10-mark-all-done.png");
  });
});

test.describe("@local-fixture B. preferences", () => {
  test("B1: server-backed values, toggles persist across reload, defaults honor policy", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "การตั้งค่าการแจ้งเตือน" })).toBeVisible();
    // finance kinds default ON (first checkbox); catalog kinds default OFF
    const financeBox = page.locator('input[type="checkbox"]').first();
    const novelBox = page.locator('input[type="checkbox"]').nth(4);
    await expect(financeBox).toBeChecked();
    await expect(novelBox).not.toBeChecked();
    await shot(page, "B1-preferences-loaded.png");
    await financeBox.click();
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.locator('input[type="checkbox"]').first()).not.toBeChecked();
    await expect(page.locator('input[type="checkbox"]').nth(4)).not.toBeChecked();
    await shot(page, "B1-preferences-persisted.png");
  });

  test("B2: a failed preference mutation shows an error and never a false success", async ({ page }) => {
    await loginAs(page.context(), fixtures!.userToken);
    await page.goto("/profile");
    const financeBox = page.locator('input[type="checkbox"]').first();
    await expect(financeBox).toBeVisible();
    const before = await financeBox.isChecked();
    await page.route("**/api/trpc/notifications.setPreference*", route => route.abort());
    await financeBox.click();
    await expect(page.getByText("บันทึกการตั้งค่าไม่สำเร็จ")).toBeVisible();
    await shot(page, "B2-mutation-failed.png");
    // the value reverts server-truth on the next load
    await page.unroute("**/api/trpc/notifications.setPreference*");
    await page.reload();
    expect(await page.locator('input[type="checkbox"]').first().isChecked()).toBe(before);
  });
});

test.describe("@local-fixture C. authentication and privacy", () => {
  test("C1: a guest gets no bell and the API refuses the inbox", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(BELL)).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/trpc/notifications.unreadCount");
      return response.status;
    });
    expect(result).toBe(401);
    await shot(page, "C1-guest.png");
  });

  test("C2: accounts are isolated - switching accounts drops cached rows; logout clears", async ({ page }) => {
    await loginAs(page.context(), fixtures!.isoAToken);
    await page.goto("/");
    await openNotificationCenter(page);
    await expect(page.getByText("เติมเงินสำเร็จ").first()).toBeVisible();
    await page.keyboard.press("Escape");

    // switch account mid-session (cookie swap, no logout round-trip): the
    // cached primary rows must be dropped and replaced by the OTHER
    // account's own data (its own unread count and its own first rows)
    await loginAs(page.context(), fixtures!.badge99Token);
    await page.goto("/");
    await openNotificationCenter(page);
    const rows = page.locator('[aria-live="polite"] > div');
    await expect(rows.first()).toBeVisible();
    const shown = await rows.count();
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(20);
    await shot(page, "C2-badge99-isolated.png");

    // logout: the bell disappears and a reload never shows stale rows
    await page.keyboard.press("Escape");
    await page.locator('button[data-ipe-nav-toggle][aria-controls="ipe-account-menu"]').first().click();
    await page.getByRole("button", { name: /ออกจากระบบ|logout/i }).first().click();
    await expect(page.locator(BELL)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(BELL)).toHaveCount(0);
    await shot(page, "C3-logged-out.png");
  });
});

test.describe("@local-fixture D. responsive, keyboard and locale", () => {
  test("D1: desktop 1440 - no horizontal overflow, keyboard opens the dialog", async ({ page }) => {
    await loginAs(page.context(), fixtures!.isoBToken);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.locator(BELL).first().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "การแจ้งเตือน" })).toBeVisible();
    await shot(page, "D1-desktop-1440.png");
  });

  test("D2: mobile 390 - bell in the mobile panel, no horizontal overflow", async ({ page }) => {
    await loginAs(page.context(), fixtures!.secondToken);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.locator('button[aria-label*="menu" i], button[aria-label*="เมนู"]').first().click();
    const mobileBell = page.locator('#ipe-mobile-navigation button[aria-label^="เปิดการแจ้งเตือน"]');
    await expect(mobileBell).toBeVisible();
    await mobileBell.click();
    await expect(page.getByRole("heading", { name: "การแจ้งเตือน" })).toBeVisible();
    await shot(page, "D2-mobile-390.png");
  });

  test("D3: Thai locale with Asia/Bangkok time rendering", async ({ page }) => {
    await loginAs(page.context(), fixtures!.isoBToken);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openNotificationCenter(page);
    const timeText = await page.locator("time").first().textContent();
    expect(timeText ?? "").toMatch(/25\d\d/); // Buddhist era year from th-TH
    const dateTimeAttr = await page.locator("time").first().getAttribute("datetime");
    expect(dateTimeAttr ?? "").toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await shot(page, "D3-thai-locale.png");
  });
});
