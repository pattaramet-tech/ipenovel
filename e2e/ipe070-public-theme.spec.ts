import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidenceDir =
  process.env.IPE070_EVIDENCE_DIR?.trim() ||
  path.join(process.cwd(), "test-results", "ipe070-public-theme");

const widths = [320, 390, 768, 1024, 1280, 1440, 1920] as const;

const themeButton = (page: Page) => page.locator("[data-ipe-theme-toggle]:visible");

async function chooseTheme(page: Page, name: "Light, สว่าง" | "Dark, มืด" | "System, ตามระบบ") {
  await themeButton(page).click();
  await page.getByRole("menuitemradio", { name }).click();
}

async function cssVars(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("div");
    probe.className = "bg-background text-primary";
    element.appendChild(probe);
    const probeStyle = getComputedStyle(probe);
    const result = {
      backgroundVar: style.getPropertyValue("--background").trim(),
      primaryVar: style.getPropertyValue("--primary").trim(),
      canvasVar: style.getPropertyValue("--ipe-canvas").trim(),
      probeBackground: probeStyle.backgroundColor,
      probeColor: probeStyle.color,
    };
    probe.remove();
    return result;
  });
}

test.use({ trace: "off", video: "off", screenshot: "off" });

test.describe("@public IPE-070 public theme", () => {
  test.beforeAll(() => {
    fs.mkdirSync(evidenceDir, { recursive: true });
  });

  test("light default, dark, system, persistence, and isolation", async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".ipe-public").first()).toBeVisible();
    await expect(page.locator(".ipe-public[data-public-theme='dark']")).toHaveCount(0);
    await expect(page.locator(".ipe-public-nav[data-public-theme='dark']")).toHaveCount(0);

    const lightBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightPublic = await cssVars(page, ".ipe-public");

    await chooseTheme(page, "Dark, มืด");
    await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");
    await expect(page.locator(".ipe-public-nav").first()).toHaveAttribute("data-public-theme", "dark");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ipenovel.public-theme"))).toBe("dark");

    const darkPublic = await cssVars(page, ".ipe-public");
    const darkBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const outsideProbe = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "bg-background text-primary";
      document.body.appendChild(probe);
      const style = getComputedStyle(probe);
      const result = { background: style.backgroundColor, color: style.color };
      probe.remove();
      return result;
    });

    expect(darkPublic.canvasVar.toLowerCase()).toBe("#121820");
    expect(darkPublic.backgroundVar.toLowerCase()).toBe("#121820");
    expect(darkPublic.primaryVar.toLowerCase()).toBe("#24344f");
    expect(darkPublic.probeBackground).not.toBe(lightPublic.probeBackground);
    expect(darkBody).toBe(lightBody);
    expect(outsideProbe.background).toBe(lightBody);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");

    await chooseTheme(page, "Light, สว่าง");
    await expect(page.locator(".ipe-public[data-public-theme='dark']")).toHaveCount(0);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator(".ipe-public[data-public-theme='dark']")).toHaveCount(0);

    await chooseTheme(page, "System, ตามระบบ");
    await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator(".ipe-public[data-public-theme='dark']")).toHaveCount(0);

    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".ipe-public-nav")).toBeVisible();
    await expect(page.locator(".ipe-public-nav[data-public-theme='dark']")).toHaveCount(0);
    await expect(page.locator("[data-ipe-theme-toggle]")).toHaveCount(0);
    const loginBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(loginBody).toBe(lightBody);

    await page.evaluate(() => {
      localStorage.setItem("ipenovel.public-theme", "dark");
      localStorage.setItem("ipenovel_reader_preferences", "{\"theme\":\"sepia\"}");
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");

    const routes: { path: string; note: string }[] = [];
    for (const pathName of ["/workspace", "/admin", "/read/1", "/cart"]) {
      await page.goto(pathName, { waitUntil: "domcontentloaded" });
      const snapshot = await page.evaluate(() => {
        const outside = document.querySelector("main, [data-admin-shell], .min-h-screen") ?? document.body;
        const style = getComputedStyle(outside);
        const probe = document.createElement("div");
        probe.className = "bg-background text-primary";
        outside.appendChild(probe);
        const probeStyle = getComputedStyle(probe);
        const result = {
          url: location.pathname,
          htmlDark: document.documentElement.classList.contains("dark"),
          publicDark: document.querySelectorAll("[data-public-theme='dark']").length,
          publicRootCount: document.querySelectorAll(".ipe-public").length,
          outsideTag: outside.tagName,
          outsideClass: outside.className.toString().slice(0, 180),
          backgroundVar: style.getPropertyValue("--background").trim(),
          primaryVar: style.getPropertyValue("--primary").trim(),
          probeBackground: probeStyle.backgroundColor,
          probeColor: probeStyle.color,
        };
        probe.remove();
        return result;
      });
      routes.push({ path: pathName, note: JSON.stringify(snapshot) });
      expect(snapshot.htmlDark).toBe(false);
      expect(snapshot.probeBackground).toBe(lightBody);
      if (pathName === "/cart") {
        expect(snapshot.publicDark).toBe(1);
        expect(snapshot.publicRootCount).toBe(0);
      } else {
        expect(snapshot.publicDark).toBe(0);
      }
    }

    fs.writeFileSync(
      path.join(evidenceDir, "isolation-routes.json"),
      JSON.stringify({ lightBody, lightPublic, darkPublic, outsideProbe, routes, consoleErrors }, null, 2),
    );
  });

  test("first public node is already dark when the key exists", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("ipenovel.public-theme", "dark");
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const first = await page.evaluate(() => {
      const element = document.querySelector(".ipe-public");
      return element?.getAttribute("data-public-theme") ?? null;
    });
    expect(first).toBe("dark");
  });

  test("keyboard selects dark and mobile nav still opens", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await themeButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: "Light, สว่าง" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", { name: "Dark, มืด" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");
    await expect(themeButton(page)).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    const menuToggle = page.getByRole("button", { name: /เปิดเมนู|Open menu|ปิดเมนู|Close menu/ });
    await menuToggle.click();
    await expect(menuToggle).toHaveAttribute("aria-expanded", "true");
    await expect(themeButton(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("screenshots at the required widths", async ({ page }) => {
    test.setTimeout(240_000);
    const pages = ["/", "/novels", "/novels/not-a-real-novel"] as const;
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const pathName of pages) {
        await page.goto(pathName, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".ipe-public").first()).toBeVisible();
        if (pathName === "/novels/not-a-real-novel" && width === 1280) {
          const early = await page.locator(".ipe-public").first().evaluate((element) => ({
            dark: element.getAttribute("data-public-theme"),
            background: getComputedStyle(element).backgroundColor,
          }));
          expect(early.dark).toBeNull();
          expect(early.background).toBe("rgb(247, 245, 240)");
        }
        const slug = pathName === "/" ? "home" : pathName.replace(/\//g, "-");
        await page.screenshot({
          path: path.join(evidenceDir, `light-${slug}-${width}.png`),
          fullPage: true,
        });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${pathName} at ${width}`).toBeLessThanOrEqual(1);
      }
    }

    await page.addInitScript(() => {
      localStorage.setItem("ipenovel.public-theme", "dark");
    });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const pathName of pages) {
        await page.goto(pathName, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".ipe-public").first()).toHaveAttribute("data-public-theme", "dark");
        const slug = pathName === "/" ? "home" : pathName.replace(/\//g, "-");
        if (pathName === "/novels/not-a-real-novel" && width === 1440) {
          const canvas = await page.locator(".ipe-public").first().evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            viewport: document.documentElement.clientWidth,
          }));
          expect(canvas.width).toBeGreaterThanOrEqual(canvas.viewport - 1);
        }
        await page.screenshot({
          path: path.join(evidenceDir, `dark-${slug}-${width}.png`),
          fullPage: true,
        });
      }
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await themeButton(page).click();
    await page.screenshot({ path: path.join(evidenceDir, "theme-menu-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /เปิดเมนู|Open menu/ }).click();
    await page.screenshot({ path: path.join(evidenceDir, "mobile-nav-open.png") });
  });
});
