import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { e2eBaseUrl } from "./support/env";
import { gotoOk, watchRuntimeFailures } from "./support/runtime";

test.use({ trace: "off", video: "off", screenshot: "off" });

type LocalFixtureCookies = { cookieName: string; userToken: string; adminToken: string };

function isStrictLocalUrl(url: URL): boolean {
  return url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

function readFixtureCookies(): LocalFixtureCookies {
  const cookiesFile = process.env.E2E_SESSION_COOKIES_FILE?.trim() || "";
  if (!cookiesFile || !path.isAbsolute(cookiesFile) || !existsSync(cookiesFile)) {
    throw new Error("Local fixture session file is not configured");
  }
  const raw: unknown = JSON.parse(readFileSync(cookiesFile, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("Invalid local fixture-session file");
  const cookies = raw as Record<string, unknown>;
  if (typeof cookies.cookieName !== "string" || typeof cookies.userToken !== "string" ||
      typeof cookies.adminToken !== "string" || !cookies.cookieName || !cookies.userToken || !cookies.adminToken) {
    throw new Error("Local fixture-session file is missing required fields");
  }
  return {
    cookieName: cookies.cookieName,
    userToken: cookies.userToken,
    adminToken: cookies.adminToken,
  };
}

test.describe("@local-fixture authenticated public surfaces stay outside the storefront canvas", () => {
  test.beforeEach(() => {
    const target = new URL(e2eBaseUrl);
    if (!isStrictLocalUrl(target)) {
      throw new Error("Refusing fixture session on a non-local target");
    }
    if (process.env.E2E_LOCAL_DB_ATTESTED !== "ipenovel_test") {
      throw new Error("Refusing local session fixture without explicit ipenovel_test isolation attestation");
    }
  });

  test("cart, orders, and profile keep a dark navbar and a light page", async ({ page, context }) => {
    const runtime = watchRuntimeFailures(page);
    const cookies = readFixtureCookies();
    const target = new URL(e2eBaseUrl);
    await context.addCookies([
      { name: cookies.cookieName, value: cookies.userToken, url: target.origin },
    ]);
    await page.addInitScript(() => {
      localStorage.setItem("ipenovel.public-theme", "dark");
    });

    const surfaces = [
      { path: "/cart", ready: "ตะกร้าของคุณว่างอยู่" },
      { path: "/orders", ready: "ไม่มีคำสั่งซื้อ" },
      { path: "/profile", ready: "โปรไฟล์ของฉัน" },
    ];

    for (const surface of surfaces) {
      await gotoOk(page, surface.path);
      await expect(page.getByText(surface.ready).first()).toBeVisible();
      await expect(page.locator(".ipe-public")).toHaveCount(0);
      await expect(page.locator('.ipe-public-nav[data-public-theme="dark"]')).toHaveCount(1);
      await expect(page.locator("[data-ipe-theme-toggle]").first()).toBeVisible();
      const paint = await page.evaluate(() => {
        const heading = document.querySelector("h1");
        return {
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          headingColor: heading ? getComputedStyle(heading).color : "",
          htmlDark: document.documentElement.classList.contains("dark"),
        };
      });
      expect(paint.bodyBackground).not.toBe("rgb(18, 24, 32)");
      expect(paint.headingColor).not.toBe("rgb(244, 240, 230)");
      expect(paint.htmlDark).toBe(false);
    }

    runtime.assertClean();
  });
});
