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
 * Narrowly scoped on purpose: admin routes use a local email/password
 * session, never OAuth, so an expired/missing admin session must return to
 * `/admin/login`, not the OAuth flow. Every other route keeps sending
 * visitors to the OAuth login flow, unchanged. `/admin/login` itself must
 * never redirect to itself - that page is where unauthenticated visitors
 * are SUPPOSED to land, and a redirect loop there would strand the login
 * form.
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
  if (pathname === "/admin/login") return "none";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin_login";
  return "oauth";
}
