import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Auth Phase 2A wiring checks for AdminLayout - source-text assertions (no
 * DOM harness in this repo; see AdminLoginPage.test.ts/
 * authClientStorage.test.ts for the same pattern). Pins that this is still
 * the single admin access gate (via the shared resolveAdminAccessState
 * helper, now including the "error" state), that redirecting on
 * "unauthenticated" happens in an effect (not during render) via the shared
 * narrow redirect helper, and that Logout goes through useAuth's real
 * logout flow and only navigates away when that actually succeeded.
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

  it("uses the shared resolveAdminAccessState helper, including auth.me's error, as the access gate", () => {
    expect(source).toMatch(/import \{ resolveAdminAccessState \} from "@\/_core\/hooks\/adminAccess"/);
    expect(source).toMatch(/resolveAdminAccessState\(\{ loading, user, authMeError \}\)/);
  });

  it("has a branch for every access state, including the new 'error' state", () => {
    expect(source).toMatch(/accessState === "loading"/);
    expect(source).toMatch(/accessState === "unauthenticated"/);
    expect(source).toMatch(/accessState === "error"/);
    expect(source).toMatch(/accessState === "forbidden"/);
  });

  it("redirects unauthenticated users via the shared resolveUnauthorizedRedirectPath helper, from inside a useEffect, not during render", () => {
    expect(source).toMatch(/import \{ resolveUnauthorizedRedirectPath \} from "@\/_core\/hooks\/unauthorizedRedirect"/);

    const effectStart = source.indexOf("useEffect(() => {\n    if (accessState !== \"unauthenticated\") return;");
    expect(effectStart).toBeGreaterThan(-1);
    const effectBlock = source.slice(effectStart, effectStart + 300);
    expect(effectBlock).toMatch(/resolveUnauthorizedRedirectPath\(location, getLoginUrl\(\)\)/);
    expect(effectBlock).toMatch(/if \(target\) navigate\(target\);/);

    // The "unauthenticated" render branch itself must NOT call navigate()
    // directly - only the effect above may.
    const renderBranchStart = source.indexOf('if (accessState === "unauthenticated") {', effectStart + 300);
    expect(renderBranchStart).toBeGreaterThan(-1);
    const renderBranchEnd = source.indexOf("if (accessState ===", renderBranchStart + 10);
    const renderBranchBlock = source.slice(renderBranchStart, renderBranchEnd);
    expect(renderBranchBlock).not.toMatch(/navigate\(/);
  });

  it("the error (infrastructure failure) screen never shows the raw error and offers a Retry that refetches auth.me", () => {
    const errorStart = source.indexOf('if (accessState === "error")');
    const errorEnd = source.indexOf('if (accessState === "forbidden")');
    expect(errorStart).toBeGreaterThan(-1);
    const errorBlock = source.slice(errorStart, errorEnd);

    expect(errorBlock).toMatch(/Retry/);
    expect(errorBlock).toMatch(/refresh\(\)/);
    // Never interpolates the caught error object/message into the UI.
    expect(errorBlock).not.toMatch(/\{authMeError/);
    expect(errorBlock).not.toMatch(/authMeError\.message/);
    expect(errorBlock).not.toMatch(/\{error\b/);
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
    expect(source).toMatch(/const \{ user, loading, authMeError, logout, isLoggingOut, refresh \} = useAuth\(\)/);
    expect(source).toMatch(/await logout\(\)/);
  });

  it("the logout button is disabled while a logout is already in flight (double-click guard)", () => {
    const sidebarLogoutButtonIndex = source.indexOf("onClick={() => {\n            setMobileMenuOpen(false);");
    expect(sidebarLogoutButtonIndex).toBeGreaterThan(-1);
    const sidebarButtonBlock = source.slice(sidebarLogoutButtonIndex, sidebarLogoutButtonIndex + 400);
    expect(sidebarButtonBlock).toMatch(/disabled=\{isLoggingOut\}/);

    expect(source).toMatch(/if \(isLoggingOut\) return;/);
  });

  it("navigates to /admin/login only on the success path (inside the try, after await logout()) - never in a finally, never unconditionally", () => {
    const handleLogoutStart = source.indexOf("async function handleLogout()");
    const handleLogoutEnd = source.indexOf("\n  }\n", handleLogoutStart);
    const handleLogoutBlock = source.slice(handleLogoutStart, handleLogoutEnd);

    // No finally block at all - the old "always navigate regardless of
    // outcome" shape is gone.
    expect(handleLogoutBlock).not.toMatch(/finally/);

    const tryStart = handleLogoutBlock.indexOf("try {");
    const catchStart = handleLogoutBlock.indexOf("} catch");
    expect(tryStart).toBeGreaterThan(-1);
    expect(catchStart).toBeGreaterThan(tryStart);

    const tryBlock = handleLogoutBlock.slice(tryStart, catchStart);
    const catchBlock = handleLogoutBlock.slice(catchStart);

    // navigate() only appears in the try block, after logout() - never in
    // the catch block, which only shows an error toast.
    expect(tryBlock).toMatch(/await logout\(\)/);
    expect(tryBlock).toMatch(/navigate\("\/admin\/login"\)/);
    expect(tryBlock.indexOf("await logout()")).toBeLessThan(tryBlock.indexOf('navigate("/admin/login")'));
    expect(catchBlock).not.toMatch(/navigate\(/);
  });
});
