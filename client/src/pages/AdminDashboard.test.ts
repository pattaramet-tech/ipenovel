import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Auth Phase 2A wiring checks for AdminDashboard - source-text assertions
 * (no DOM harness in this repo; see AdminLoginPage.test.ts/
 * authClientStorage.test.ts for the same pattern). Pins that this page no
 * longer reads the admin-session localStorage flag, no longer runs its own
 * competing loading/"Access Denied" screens (AdminLayout is now the sole
 * gate), and gates its admin queries with the shared resolveAdminAccessState
 * helper rather than a locally-invented boolean.
 */
// Normalized to \n regardless of the checkout's line-ending style (this
// repo's working tree uses CRLF) so literal multi-line substring searches
// below don't have to account for \r.
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminDashboard.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("AdminDashboard source shape", () => {
  it("never reads the admin-session localStorage flag", () => {
    expect(source).not.toMatch(/localStorage\.getItem\(\s*["'`]admin-session["'`]/);
    expect(source).not.toMatch(/localStorage\.(getItem|setItem|removeItem)\(/);
  });

  it("has no isAdminLoggedIn/isAdmin OR-fallback flag - only user.role decides admin queries", () => {
    expect(source).not.toMatch(/isAdminLoggedIn/);
    expect(source).not.toMatch(/isAdminLoggedIn\s*\|\|/);
  });

  it("derives shouldFetchAdminData from resolveAdminAccessState, not a hand-rolled boolean", () => {
    expect(source).toMatch(/resolveAdminAccessState\(\{ loading: authLoading, user \}\) === "allowed"/);
  });

  it("does not render its own competing loading/Access Denied screen - AdminLayout is the sole gate", () => {
    expect(source).not.toMatch(/Access Denied/);
  });

  it("still wraps its content in AdminLayout", () => {
    expect(source).toMatch(/<AdminLayout>/);
    expect(source).toMatch(/<\/AdminLayout>/);
  });

  it("every admin query passes shouldFetchAdminData as its enabled flag", () => {
    const queryBlocks = source.match(/trpc\.admin\.[a-zA-Z.]+\.useQuery\([\s\S]{0,200}?\)/g) ?? [];
    expect(queryBlocks.length).toBeGreaterThan(0);
    for (const block of queryBlocks) {
      expect(block).toMatch(/enabled:\s*shouldFetchAdminData/);
    }
  });
});
