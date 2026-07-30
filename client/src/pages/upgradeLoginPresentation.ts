// Pure logic backing UpgradeLoginPage - kept out of the component itself
// (same pattern as profileGoogleConnectStatus.ts/checkoutOutcome.ts
// elsewhere in this codebase) so it's directly testable without a DOM
// harness (this repo has none - no @testing-library/jsdom installed).

const ALLOWED_SUPPORT_URL_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:"]);

/**
 * VITE_SUPPORT_URL is the only source for the "ติดต่อฝ่ายช่วยเหลือ" button's
 * link - there is no existing, already-wired-up support channel anywhere
 * else in this codebase (confirmed by inspection - AdminSettingsPage's
 * "contactEmail" field is local, unsaved UI state, never read by any other
 * page). Never a guessed/hardcoded URL: an empty/whitespace-only value, an
 * unparseable value, or a value using any scheme other than the explicit
 * allowlist (https/http/mailto/tel) means the button must not render at
 * all, rather than linking to a fabricated address or - since this value
 * ultimately becomes a raw `href`, rendered without further sanitization -
 * an XSS vector via `javascript:`/`data:`/`file:` or some other scheme this
 * page's author never anticipated.
 */
export function resolveSupportUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (!ALLOWED_SUPPORT_URL_SCHEMES.has(parsed.protocol)) return null;
  return trimmed;
}

export type UpgradeLoginPageAction =
  | "loading"
  | "redirect_login"
  | "redirect_home"
  | "render_upgrade"
  | "render_error";

export type UpgradeLoginPageInput = {
  authLoading: boolean;
  isAuthenticated: boolean;
  googleConnectedLoading: boolean;
  /**
   * True when the auth.googleConnected query itself failed (an
   * infrastructure error, not "not connected"). Must NEVER be treated as
   * "connected" (redirect_home) or "not connected" (render_upgrade) - both
   * would be a guess about a status this page does not actually know.
   */
  googleConnectedError: boolean;
  /** undefined = not yet resolved either way - distinct from a real `false`. */
  googleConnected: boolean | undefined;
};

/**
 * The single decision point for what UpgradeLoginPage should render/do.
 * Anonymous visitors are sent to /login (never stranded on an infinite
 * spinner, and never queried for a Google-connection status they cannot
 * have without a session in the first place - see the `enabled` guard at
 * this function's only call site).
 */
export function resolveUpgradeLoginPageAction(input: UpgradeLoginPageInput): UpgradeLoginPageAction {
  if (input.authLoading) return "loading";
  if (!input.isAuthenticated) return "redirect_login";
  if (input.googleConnectedLoading) return "loading";
  if (input.googleConnectedError) return "render_error";
  if (input.googleConnected === true) return "redirect_home";
  return "render_upgrade";
}
