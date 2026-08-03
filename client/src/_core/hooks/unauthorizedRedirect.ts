/**
 * Where an UNAUTHORIZED (no/expired session - never FORBIDDEN, which is a
 * different, already-authenticated state - see adminAccess.ts) visitor
 * should be sent, based only on which page they were on. Pure and
 * side-effect-free: never reads window/document/localStorage and never
 * performs the redirect itself - every caller (client/src/main.tsx's global
 * QueryCache/MutationCache handler, useAuth's redirectOnUnauthenticated
 * effect, AdminLayout) shares this ONE function so the rule can never drift
 * into three slightly-different copies.
 *
 * There is no more separate local admin login (see
 * security/remove-local-admin-password-login) - an admin is just a regular
 * signed-in user whose `role` happens to be `"admin"`, authenticated
 * through the exact same Manus/Google/transition login as everyone else.
 * `/admin` and every `/admin/*` route still get their own hardcoded,
 * literal `/login` destination (the "admin_login" target below) rather
 * than `getLoginUrl()`'s dynamic OAuth-URL resolution, so an admin route
 * expiring never depends on OAuth config (VITE_OAUTH_PORTAL_URL/
 * VITE_APP_ID) being present or valid just to decide "go back to the login
 * page" - every other route keeps using the dynamic "oauth" target,
 * unchanged. `/login` itself must never redirect to itself - that page is
 * where unauthenticated visitors are SUPPOSED to land, and a redirect loop
 * there would strand the login form.
 *
 * Returns a target TYPE, not a URL - deliberately: `getLoginUrl()` builds a
 * full OAuth authorization URL (reads `window.location.origin`,
 * `VITE_OAUTH_PORTAL_URL`, `VITE_APP_ID`, base64-encodes a redirect state)
 * purely to be thrown away on every admin-route UNAUTHORIZED. Returning a
 * type instead lets every caller skip that work entirely for `/admin/*` -
 * an admin session expiring should never depend on OAuth config being
 * present or valid.
 */
export type UnauthorizedRedirectTarget = "none" | "admin_login" | "oauth";

export function resolveUnauthorizedRedirectTarget(pathname: string): UnauthorizedRedirectTarget {
  if (pathname === "/login") return "none";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin_login";
  return "oauth";
}
