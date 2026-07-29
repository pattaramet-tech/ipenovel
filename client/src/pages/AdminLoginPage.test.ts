import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Auth Phase 2A wiring checks for AdminLoginPage. This repo has no
 * component/DOM test harness (see authClientStorage.test.ts's precedent),
 * so these are source-text/static assertions rather than a rendered
 * interaction test - enough to pin the specific behaviors this page must
 * never regress on: no admin-session localStorage, auth.me is the only
 * thing allowed to confirm admin access after login, and an already-signed-
 * in non-admin is never redirected into /admin.
 */
// Normalized to \n regardless of the checkout's line-ending style (this
// repo's working tree uses CRLF) so literal multi-line substring searches
// below don't have to account for \r.
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminLoginPage.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("AdminLoginPage source shape", () => {
  it("never writes the admin-session localStorage flag", () => {
    expect(source).not.toMatch(/localStorage\.setItem\(\s*["'`]admin-session["'`]/);
    expect(source).not.toMatch(/localStorage\.setItem/);
  });

  it("never calls localStorage as executable code (getItem/setItem/removeItem) - only a documentation comment may mention the word", () => {
    expect(source).not.toMatch(/localStorage\.(getItem|setItem|removeItem)\(/);
  });

  it("fetches auth.me fresh after a successful login instead of trusting the mutation's own adminId", () => {
    expect(source).toMatch(/utils\.auth\.me\.fetch\(/);
  });

  it("checks role === \"admin\" on the freshly-fetched user before navigating to /admin on login success", () => {
    const onSuccessStart = source.indexOf("onSuccess:");
    const onSuccessBlock = source.slice(onSuccessStart, source.indexOf("onError:"));
    expect(onSuccessBlock).toMatch(/freshUser\?\.role === "admin"/);

    const roleCheckIndex = onSuccessBlock.indexOf('freshUser?.role === "admin"');
    const navigateIndex = onSuccessBlock.indexOf('navigate("/admin")');
    expect(roleCheckIndex).toBeGreaterThan(-1);
    expect(navigateIndex).toBeGreaterThan(roleCheckIndex);
  });

  it("navigates to /admin for an already-authenticated admin via a useEffect, not during render", () => {
    expect(source).toMatch(/useEffect\(\s*\(\)\s*=>\s*\{\s*\n\s*if \(!authLoading && user\?\.role === "admin"\) \{\s*\n\s*navigate\("\/admin"\)/);
  });

  it('a signed-in non-admin never triggers navigate("/admin")', () => {
    const nonAdminBranchStart = source.indexOf('if (user && user.role !== "admin")');
    expect(nonAdminBranchStart).toBeGreaterThan(-1);
    const nextBranchStart = source.indexOf('if (user && user.role === "admin")');
    const nonAdminBranch = source.slice(nonAdminBranchStart, nextBranchStart);
    expect(nonAdminBranch).not.toMatch(/navigate\("\/admin"\)/);
  });

  it("the non-admin screen offers both a Home link and a logout/switch-account action", () => {
    const nonAdminBranchStart = source.indexOf('if (user && user.role !== "admin")');
    const nextBranchStart = source.indexOf('if (user && user.role === "admin")');
    const nonAdminBranch = source.slice(nonAdminBranchStart, nextBranchStart);
    expect(nonAdminBranch).toMatch(/href="\/"/);
    expect(nonAdminBranch).toMatch(/handleLogoutAndSwitchAccount/);
  });

  it("login failure keeps a generic error message, never a raw server error", () => {
    const onErrorStart = source.indexOf("onError:");
    const onErrorBlock = source.slice(onErrorStart, onErrorStart + 300);
    expect(onErrorBlock).toMatch(/Invalid email or password/);
    expect(onErrorBlock).not.toMatch(/error\.message/);
  });

  it("reads authMeError and refresh from useAuth", () => {
    expect(source).toMatch(
      /const \{ user, loading: authLoading, authMeError, logout, isLoggingOut, refresh \} = useAuth\(\)/
    );
  });

  it("an auth.me infrastructure error shows a safe message and a Retry that calls refresh(), never the raw error", () => {
    const errorBranchStart = source.indexOf("if (authMeError)");
    expect(errorBranchStart).toBeGreaterThan(-1);
    const nonAdminBranchStart = source.indexOf('if (user && user.role !== "admin")');
    const errorBranch = source.slice(errorBranchStart, nonAdminBranchStart);

    expect(errorBranch).toMatch(/refresh\(\)/);
    expect(errorBranch).not.toMatch(/\{authMeError/);
    expect(errorBranch).not.toMatch(/authMeError\.message/);
    // Must not render the login form in this branch.
    expect(errorBranch).not.toMatch(/<form/);
  });

  it("the auth.me-error branch is checked before the non-admin/admin/form branches, so an infra error never falls through to the login form", () => {
    const loadingBranchIndex = source.indexOf("if (authLoading)");
    const errorBranchIndex = source.indexOf("if (authMeError)");
    const nonAdminBranchIndex = source.indexOf('if (user && user.role !== "admin")');

    expect(errorBranchIndex).toBeGreaterThan(loadingBranchIndex);
    expect(errorBranchIndex).toBeLessThan(nonAdminBranchIndex);
  });

  it("renders the login form only after the loading/error/non-admin/admin-redirect branches", () => {
    const formIndex = source.indexOf("<form onSubmit={handleLogin}");
    const loadingBranchIndex = source.indexOf("if (authLoading)");
    const errorBranchIndex = source.indexOf("if (authMeError)");
    const nonAdminBranchIndex = source.indexOf('if (user && user.role !== "admin")');
    const adminBranchIndex = source.indexOf('if (user && user.role === "admin")');

    expect(formIndex).toBeGreaterThan(loadingBranchIndex);
    expect(formIndex).toBeGreaterThan(errorBranchIndex);
    expect(formIndex).toBeGreaterThan(nonAdminBranchIndex);
    expect(formIndex).toBeGreaterThan(adminBranchIndex);
  });
});
