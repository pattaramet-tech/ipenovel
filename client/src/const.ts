export { COOKIE_NAME } from "@shared/const";

const GOOGLE_LOGIN_START_PATH = "/api/auth/google/start";

/**
 * Pure decision: which literal path/URL getLoginUrl() should return for a
 * given VITE_AUTH_PROVIDER value, given the pieces needed to build the
 * Manus URL. Exported and independently testable (no `import.meta.env`,
 * no `window`) - see const.test.ts - so "flag unset -> Manus",
 * "flag=manus -> Manus", and "flag=google -> Google start path" are all
 * assertable without needing to stub Vite's `import.meta.env` in a test.
 *
 * Any value other than the exact literal "google" (unset, "manus", a
 * typo, empty string) resolves to Manus - the ONLY way to opt into the
 * Google flow is an exact match, so a deploy that forgets to set this
 * variable, or sets it to something unexpected, can never silently change
 * existing production login behavior.
 */
export function resolveLoginUrl(
  authProvider: string | undefined,
  manus: { oauthPortalUrl: string; appId: string; redirectUri: string }
): string {
  if (authProvider === "google") {
    // An in-app path, not a fully-formed external authorization URL like
    // the Manus branch returns - the server route itself
    // (server/_core/googleOAuth.ts's /api/auth/google/start) builds the
    // real Google authorization URL, including state/nonce/PKCE, which
    // must never be generated or exposed in client code.
    return GOOGLE_LOGIN_START_PATH;
  }

  const state = btoa(manus.redirectUri);
  const url = new URL(`${manus.oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", manus.appId);
  url.searchParams.set("redirectUri", manus.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");
  return url.toString();
}

// Generate login URL at runtime so the Manus redirect URI reflects the
// current origin. Branches on VITE_AUTH_PROVIDER (build-time client flag,
// independent of the server's own AUTH_PROVIDER - see
// server/_core/env.ts) via resolveLoginUrl above. Admin login (/admin,
// /admin/*, /admin/login) never calls this function at all - it
// authenticates via the separate admin.login tRPC mutation and a local,
// server-verified session, both entirely unaffected by this flag.
export const getLoginUrl = (): string => {
  return resolveLoginUrl(import.meta.env.VITE_AUTH_PROVIDER, {
    oauthPortalUrl: import.meta.env.VITE_OAUTH_PORTAL_URL,
    appId: import.meta.env.VITE_APP_ID,
    redirectUri: `${window.location.origin}/api/oauth/callback`,
  });
};
