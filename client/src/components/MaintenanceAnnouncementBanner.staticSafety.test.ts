import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Static source-text assertions covering what a DOM-render test would
 * otherwise check - this repo has no component/DOM test harness (see
 * navbarVisibility.ts's own note), so, matching that established pattern,
 * behavior that can't be unit-tested as a pure function is instead pinned
 * by reading the real source files.
 */
const componentSource = readFileSync(join(__dirname, "MaintenanceAnnouncementBanner.tsx"), "utf8");
const appSource = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
const readerPageSource = readFileSync(join(__dirname, "..", "pages", "ReaderPage.tsx"), "utf8");
const readerCssSource = readFileSync(join(__dirname, "..", "pages", "ReaderPage.module.css"), "utf8");

describe("MaintenanceAnnouncementBanner - static safety assertions", () => {
  it("is wired into App.tsx, so it actually renders on real pages", () => {
    expect(appSource).toMatch(/import MaintenanceAnnouncementBanner from ["']\.\/components\/MaintenanceAnnouncementBanner["']/);
    expect(appSource).toMatch(/<MaintenanceAnnouncementBanner\s*\/>/);
  });

  it("reads its copy/enabled-state from the single config file, never a hardcoded literal of the announcement text", () => {
    expect(componentSource).toMatch(/from ["']@\/config\/maintenanceBanner["']/);
    // None of the requested announcement copy is duplicated as a literal
    // inside the component itself - it must only ever come from
    // MAINTENANCE_BANNER_CONFIG.
    expect(componentSource).not.toContain("ประกาศปิดปรับปรุงระบบ");
    expect(componentSource).not.toContain("19 สิงหาคม");
  });

  it("never renders a blocking modal/overlay - no full-viewport backdrop, no dialog role", () => {
    expect(componentSource).not.toMatch(/role=["']dialog["']/);
    expect(componentSource).not.toMatch(/fixed\s+inset-0/);
    expect(componentSource).not.toMatch(/className=["'][^"']*\bbackdrop/i);
  });

  it("persists dismissal via localStorage only, never sessionStorage or a network call", () => {
    expect(componentSource).toMatch(/localStorage/);
    expect(componentSource).not.toMatch(/sessionStorage/);
    expect(componentSource).not.toMatch(/\bfetch\(|trpc\./);
  });

  it("exports the CSS height variable name as a constant, not a string a consumer has to retype", () => {
    expect(componentSource).toMatch(/export const MAINTENANCE_BANNER_HEIGHT_CSS_VAR\s*=\s*["']--maintenance-banner-height["']/);
  });

  it("Reader integration: ReaderPage.tsx imports the shared CSS-var constant rather than a hardcoded copy of the string", () => {
    expect(readerPageSource).toMatch(
      /import\s*\{\s*MAINTENANCE_BANNER_HEIGHT_CSS_VAR\s*\}\s*from\s+["']@\/components\/MaintenanceAnnouncementBanner["']/
    );
    // Never a second, independently-typed "--maintenance-banner-height"
    // literal in ReaderPage.tsx itself - it must only ever reach the CSS
    // engine via the imported constant, so the two can never drift.
    expect(readerPageSource).not.toContain('"--maintenance-banner-height"');
  });

  it("Reader integration: watermarkTopOffset still branches on chromeState.hideHeader / headerHeight exactly as before - only wrapped in an additive calc()", () => {
    expect(readerPageSource).toMatch(/chromeState\.hideHeader/);
    expect(readerPageSource).toMatch(/headerHeight\s*>\s*0/);
    expect(readerPageSource).toMatch(/watermarkTopOffset\s*=\s*`calc\(/);
  });

  it("Reader integration: no changes to any actual reading/business logic (purchase, entitlement, navigation, TOC, progress-save helpers all untouched by name)", () => {
    // Not a diff check (that's covered by code review / `git diff`) - this
    // just pins that these specific business-logic function names are
    // still present, completely unrelated to the maintenance-banner CSS
    // plumbing above, as a light regression guard against an accidental
    // deletion while editing this file.
    for (const fn of ["handlePurchase", "goToEpisode", "handleBackToNovel", "flushProgressSave"]) {
      expect(readerPageSource).toContain(fn);
    }
  });

  it("Reader CSS: .container reserves the banner's height instead of assuming it owns the full viewport", () => {
    expect(readerCssSource).toMatch(/\.container\s*\{[\s\S]*?height:\s*calc\(100dvh - var\(--maintenance-banner-height,\s*0px\)\)/);
  });

  it("Reader CSS: the Focus Mode restore button offsets past the banner's height too", () => {
    expect(readerCssSource).toMatch(/\.restoreButton\s*\{[\s\S]*?top:\s*calc\(env\(safe-area-inset-top\) \+ 10px \+ var\(--maintenance-banner-height,\s*0px\)\)/);
  });
});
