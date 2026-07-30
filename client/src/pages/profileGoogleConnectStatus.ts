// Pure logic backing ProfilePage's "Connected Accounts" section - kept out
// of the component itself (same pattern as checkoutOutcome.ts/
// dailyCheckinPresentation.ts elsewhere in this codebase) so it's directly
// testable without a DOM harness (this repo has none - no
// @testing-library/jsdom installed).

/**
 * The Google-connect section (a "Connect your Google account" or
 * "Google account connected" card) is only ever shown in google/transition
 * mode - in manus mode there is no Google login/connect flow at all, so
 * showing the section there would offer a button that 404s. Exact-literal
 * match, same discipline as resolveLoginUrl in const.ts - any other value
 * (unset, "manus", a typo) hides the section, never shows it by accident.
 */
export function shouldShowGoogleConnectSection(authProvider: string | undefined): boolean {
  return authProvider === "google" || authProvider === "transition";
}

export type GoogleConnectStatus = "success" | "error" | null;

const GOOGLE_CONNECT_STATUS_PARAM = "googleConnect";

/**
 * Reads the one-shot ?googleConnect=success|error query param the server's
 * /api/auth/google/callback (connect intent) redirects back to /profile
 * with (server/_core/googleOAuth.ts). Any other/missing/malformed value
 * resolves to null - never assumed to be a particular status.
 */
export function parseGoogleConnectStatus(search: string): GoogleConnectStatus {
  const params = new URLSearchParams(search);
  const value = params.get(GOOGLE_CONNECT_STATUS_PARAM);
  return value === "success" || value === "error" ? value : null;
}
