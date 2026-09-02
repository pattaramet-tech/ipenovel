export { COOKIE_NAME } from "@shared/const";

// Exported (not module-private) so the in-app /login page (LoginPage.tsx)
// can point its own "sign in with Google" button/link at the exact same
// path resolveLoginUrl's "google" branch resolves to - one source of
// truth for the literal string.
export const GOOGLE_LOGIN_START_PATH = "/api/auth/google/start";
const IN_APP_LOGIN_PAGE_PATH = "/login";

export type ManusLoginUrlParams = { oauthPortalUrl: string; appId: string; redirectUri: string };

/**
 * Pure function building the Manus OAuth authorization URL - unchanged
 * byte-for-byte from before this file supported multiple providers
 * (appId, redirectUri, state, type=signIn all built exactly as before).
 * Extracted into its own named function (rather than left inline in
 * resolveLoginUrl) so it's independently referenceable - the in-app
 * /login page's "เข้าสู่ระบบด้วยวิธีเดิม" (sign in the old way) button
 * calls this directly to build its own `href`, the exact same URL
 * resolveLoginUrl's "manus" branch returns.
 */
export function buildManusLoginUrl(manus: ManusLoginUrlParams): string {
  const state = btoa(manus.redirectUri);
  const url = new URL(`${manus.oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", manus.appId);
  url.searchParams.set("redirectUri", manus.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");
  return url.toString();
}

/**
 * Login-page-safe wrapper for transition deployments. A Preview may enable
 * Google while intentionally omitting the legacy Manus portal variables;
 * rendering /login must still succeed so the Google button remains usable.
 * The strict builder above is preserved for callers that REQUIRE Manus and
 * should still fail loudly on invalid configuration.
 */
export function tryBuildManusLoginUrl(manus: ManusLoginUrlParams): string | undefined {
  if (!manus.oauthPortalUrl || !manus.appId || !manus.redirectUri) return undefined;
  try {
    return buildManusLoginUrl(manus);
  } catch {
    return undefined;
  }
}

/**
 * Pure decision: which literal path/URL getLoginUrl() should return for a
 * given VITE_AUTH_PROVIDER value, given the pieces needed to build the
 * Manus URL. Exported and independently testable (no `import.meta.env`,
 * no `window`) - see const.test.ts - so every flag value (unset, "manus",
 * "google", "transition", a typo, empty, wrong case) is assertable
 * without needing to stub Vite's `import.meta.env` in a test.
 *
 * Three recognized values, each an exact-literal match:
 *  - "google"     -> the in-app Google start path (server builds the real
 *                    Google authorization URL - state/nonce/PKCE must
 *                    never be generated or exposed in client code).
 *  - "transition" -> the in-app /login page, which itself offers BOTH a
 *                    "Sign in with Google" button (-> the same Google
 *                    start path) and a "Sign in the old way" button
 *                    (-> buildManusLoginUrl, unchanged) - see LoginPage.tsx.
 *  - anything else (unset, "manus", a typo, empty string, wrong case)
 *                 -> the Manus URL, exactly as before this flag existed.
 * This is the ONLY way to opt into a non-Manus flow - a deploy that
 * forgets to set this variable, or sets it to something unexpected, can
 * never silently change existing production login behavior.
 */
export function resolveLoginUrl(authProvider: string | undefined, manus: ManusLoginUrlParams): string {
  if (authProvider === "google") {
    return GOOGLE_LOGIN_START_PATH;
  }
  if (authProvider === "transition") {
    return IN_APP_LOGIN_PAGE_PATH;
  }
  return buildManusLoginUrl(manus);
}

// Generate login URL at runtime so the Manus redirect URI reflects the
// current origin. Branches on VITE_AUTH_PROVIDER (build-time client flag,
// independent of the server's own AUTH_PROVIDER - see
// server/_core/env.ts) via resolveLoginUrl above. There is no more
// separate local admin login (see
// security/remove-local-admin-password-login) - an admin signs in through
// this exact same flow as everyone else, and the server checks
// `ctx.user.role === "admin"` afterward. An unauthenticated visitor on
// /admin/* is instead sent to the literal /login route (see
// unauthorizedRedirect.ts's "admin_login" target), never through this
// function.
export const getLoginUrl = (): string => {
  return resolveLoginUrl(import.meta.env.VITE_AUTH_PROVIDER, {
    oauthPortalUrl: import.meta.env.VITE_OAUTH_PORTAL_URL,
    appId: import.meta.env.VITE_APP_ID,
    redirectUri: `${window.location.origin}/api/oauth/callback`,
  });
};
