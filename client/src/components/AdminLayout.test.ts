import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Auth Phase 2A wiring checks for AdminLayout - source-text assertions (no
 * DOM harness in this repo; see AdminLoginPage.test.ts/
 * authClientStorage.test.ts for the same pattern). Pins that this is still
 * the single admin access gate (via the shared resolveAdminAccessState
 * helper), that redirecting on "unauthenticated" happens in an effect (not
 * during render), and that Logout goes through useAuth's real logout flow
 * instead of the old `<a href="/api/auth/logout">` link.
 */
// Normalized to \n regardless of the checkout's line-ending style (this
// repo's working tree uses CRLF) so literal multi-line substring searches
// below don't have to account for \r.
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminLayout.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("AdminLayout source shape", () => {
  it("has no localStorage/admin-session reference at all", () => {
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/admin-session/);
  });

  it("uses the shared resolveAdminAccessState helper as the access gate", () => {
    expect(source).toMatch(/import \{ resolveAdminAccessState \} from "@\/_core\/hooks\/adminAccess"/);
    expect(source).toMatch(/resolveAdminAccessState\(\{ loading, user \}\)/);
  });

  it("has a branch for each of the four access states", () => {
    expect(source).toMatch(/accessState === "loading"/);
    expect(source).toMatch(/accessState === "unauthenticated"/);
    expect(source).toMatch(/accessState === "forbidden"/);
  });

  it("redirects unauthenticated users to /admin/login from inside a useEffect, not during render", () => {
    const effectStart = source.indexOf("useEffect(() => {\n    if (accessState === \"unauthenticated\")");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBlock = source.slice(effectStart, effectStart + 200);
    expect(effectBlock).toMatch(/navigate\("\/admin\/login"\)/);

    // The "unauthenticated" render branch itself must NOT call navigate()
    // directly - only the effect above may.
    const renderBranchStart = source.indexOf('if (accessState === "unauthenticated") {', effectStart + 200);
    const renderBranchBlock = source.slice(renderBranchStart, renderBranchStart + 200);
    expect(renderBranchBlock).not.toMatch(/navigate\(/);
  });

  it("the forbidden (Access Denied) screen offers a Home link and a Logout/switch-account action, never auto-redirects to /admin/login", () => {
    const forbiddenStart = source.indexOf('if (accessState === "forbidden")');
    const forbiddenEnd = source.indexOf("const isActive =");
    const forbiddenBlock = source.slice(forbiddenStart, forbiddenEnd);

    expect(forbiddenBlock).toMatch(/Access Denied/);
    expect(forbiddenBlock).toMatch(/href="\/"/);
    expect(forbiddenBlock).toMatch(/handleLogout/);
    expect(forbiddenBlock).not.toMatch(/navigate\("\/admin\/login"\)/);
  });

  it('logout uses useAuth().logout() - no more <a href="/api/auth/logout">', () => {
    expect(source).not.toMatch(/href="\/api\/auth\/logout"/);
    expect(source).toMatch(/const \{ user, loading, logout, isLoggingOut \} = useAuth\(\)/);
    expect(source).toMatch(/await logout\(\)/);
  });

  it("the logout button is disabled while a logout is already in flight (double-click guard)", () => {
    const sidebarLogoutButtonIndex = source.indexOf("onClick={() => {\n            setMobileMenuOpen(false);");
    expect(sidebarLogoutButtonIndex).toBeGreaterThan(-1);
    const sidebarButtonBlock = source.slice(sidebarLogoutButtonIndex, sidebarLogoutButtonIndex + 400);
    expect(sidebarButtonBlock).toMatch(/disabled=\{isLoggingOut\}/);

    expect(source).toMatch(/if \(isLoggingOut\) return;/);
  });

  it("navigates to /admin/login after logout completes (success or failure)", () => {
    const handleLogoutStart = source.indexOf("async function handleLogout()");
    const handleLogoutEnd = source.indexOf("\n  }\n", handleLogoutStart);
    const handleLogoutBlock = source.slice(handleLogoutStart, handleLogoutEnd);
    expect(handleLogoutBlock).toMatch(/finally/);
    expect(handleLogoutBlock).toMatch(/navigate\("\/admin\/login"\)/);
  });
});
