// Pure logic backing LoginPage - kept out of the component itself (same
// pattern as profileGoogleConnectStatus.ts/upgradeLoginPresentation.ts
// elsewhere in this codebase) so it's directly testable without a DOM
// harness (this repo has none - no @testing-library/jsdom installed).

const GOOGLE_CONNECT_STATUS_PARAM = "googleConnect";

/**
 * Reads the one-shot ?googleConnect=session_expired query param the
 * server's /api/auth/google/callback (connect intent) redirects here with
 * when the user's session expired/became invalid between starting the
 * connect flow and Google redirecting back (see
 * server/_core/googleOAuth.ts's resolveConnectCallbackDestination). Exact-
 * literal match only - any other value (missing, "success", "error", a
 * typo) must never be treated as this, since this page's copy specifically
 * tells the user their SESSION expired, which would be misleading for any
 * other status.
 */
export function isSessionExpiredStatus(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get(GOOGLE_CONNECT_STATUS_PARAM) === "session_expired";
}
