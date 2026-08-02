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

/**
 * Whether ProfilePage's small "เข้าสู่ระบบแล้วพบว่าเป็นบัญชีใหม่?" (Account
 * Recovery) callout should render inside the Connected Accounts card. Only
 * once `auth.googleConnected` has resolved to a real, confirmed `true` -
 * the callout's own copy ("หากชั้นหนังสือ ยอดเงิน หรือประวัติการซื้อเดิม
 * ไม่แสดง...") presumes the visitor already signed in with Google (that is
 * literally the scenario Account Recovery exists for - see
 * server/services/accountRecoveryService.ts's own "must have really logged
 * in via Google" rule), so showing it to a `false`/`undefined` (still
 * loading, or genuinely never connected) visitor would be confusing rather
 * than helpful - they would hit accountRecovery.create's NOT_GOOGLE_LINKED
 * rejection immediately. `/account/recovery` itself still has its own
 * separate, more general guidance state for a not-yet-connected visitor
 * who navigates there directly (see accountRecoveryPresentation.ts) - this
 * callout is only the ProfilePage-specific discoverability affordance for
 * the common case.
 */
export function shouldShowAccountRecoveryCallout(googleConnected: boolean | undefined): boolean {
  return googleConnected === true;
}
