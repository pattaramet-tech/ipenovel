/**
 * Where an UNAUTHORIZED (no/expired session - never FORBIDDEN, which is a
 * different, already-authenticated state - see adminAccess.ts) visitor
 * should be sent, based only on which page they were on. Pure and
 * side-effect-free: never reads window/document/localStorage or performs
 * the navigation itself - callers (useAuth's redirectOnUnauthenticated
 * effect, AdminLayout) pass in `pathname` and the OAuth login URL and apply
 * the result themselves.
 *
 * Narrowly scoped on purpose: admin routes use a local email/password
 * session, never OAuth, so an expired/missing admin session must return to
 * `/admin/login`, not the OAuth flow. Every other route keeps sending
 * visitors to the OAuth login flow, unchanged. `/admin/login` itself must
 * never redirect to itself - that page is where unauthenticated visitors
 * are SUPPOSED to land, and a redirect loop there would strand the login
 * form.
 */
export function resolveUnauthorizedRedirectPath(pathname: string, oauthLoginUrl: string): string | null {
  if (pathname === "/admin/login") return null;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "/admin/login";
  return oauthLoginUrl;
}
