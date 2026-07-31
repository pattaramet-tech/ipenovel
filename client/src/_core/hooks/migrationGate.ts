// Pure decision logic behind the global "mandatory Google connection"
// migration gate (App.tsx's <MigrationGate>) - kept out of the component
// itself (same pattern as unauthorizedRedirect.ts/
// globalUnauthorizedRedirect.ts elsewhere in this codebase) so it's
// directly testable without a DOM harness (this repo has none - no
// @testing-library/jsdom installed).
//
// This is a UX convenience only, never the actual security boundary - a
// user can always call the tRPC API directly, bypassing any client-side
// route gate. The real enforcement is server/_core/googleMigrationGate.ts,
// wired into every protectedProcedure centrally. This gate exists so a
// gated user sees a clear, in-app explanation instead of a wall of failed
// API calls.

/**
 * Exact-literal match, same discipline as resolveLoginUrl/
 * shouldShowGoogleConnectSection - only "transition" + exactly "true"
 * activates the gate. Any other combination (including AUTH_PROVIDER=google
 * with the flag left on from an earlier deploy) never blocks anyone.
 */
export function isMandatoryGoogleConnectionEnabled(
  viteAuthProvider: string | undefined,
  viteRequireGoogleConnection: string | undefined
): boolean {
  return viteAuthProvider === "transition" && viteRequireGoogleConnection === "true";
}

const GATE_EXEMPT_EXACT_PATHS = new Set(["/account/upgrade-login", "/login"]);

/**
 * Paths the gate must never redirect away from, regardless of connection
 * status - the upgrade page and the login page itself (redirecting away
 * from either would be a redirect loop), and the entire admin surface
 * (admin sessions/actions are never subject to this customer-facing
 * migration gate - see server/_core/trpc.ts's adminProcedure, which is
 * built on authenticatedProcedure, never protectedProcedure, for the exact
 * same reason on the server side).
 */
export function isMigrationGateExemptPath(pathname: string): boolean {
  if (GATE_EXEMPT_EXACT_PATHS.has(pathname)) return true;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  return false;
}

export type MigrationGateAction = "allow" | "block_loading" | "block_error" | "redirect_upgrade";

export type MigrationGateInput = {
  mandatoryEnabled: boolean;
  pathname: string;
  isAuthenticated: boolean;
  authLoading: boolean;
  /** undefined = not yet resolved either way - distinct from a real `false`. */
  googleConnected: boolean | undefined;
  googleConnectedLoading: boolean;
  /**
   * True when the auth.googleConnected query itself failed (an
   * infrastructure error, not "not connected"). Must NEVER be treated as
   * "connected" (fail open) NOR silently redirected to the upgrade page as
   * if it were confirmed "not connected" (that would tell a possibly-already
   * -connected user they need to upgrade, based on a guess) - resolves to
   * its own distinct "block_error" action, never "allow" and never
   * "redirect_upgrade".
   */
  googleConnectedError: boolean;
};

/**
 * The single decision point for what <MigrationGate> should render for the
 * current route/auth state. Anonymous visitors and every exempt path are
 * always "allow" (public pages, /login, /account/upgrade-login itself, and
 * the whole /admin surface) - the gate only ever engages for an
 * authenticated, non-admin-route user once the flag is on.
 */
export function resolveMigrationGateAction(input: MigrationGateInput): MigrationGateAction {
  if (!input.mandatoryEnabled) return "allow";
  if (isMigrationGateExemptPath(input.pathname)) return "allow";
  // Auth state itself hasn't settled yet - never redirect based on a
  // guess; let the page render normally until useAuth() resolves one way
  // or the other (mirrors useAuth's own redirectOnUnauthenticated effect,
  // which waits for the same signal before acting).
  if (input.authLoading) return "allow";
  if (!input.isAuthenticated) return "allow";
  if (input.googleConnectedLoading) return "block_loading";
  if (input.googleConnectedError) return "block_error";
  if (input.googleConnected === true) return "allow";
  return "redirect_upgrade";
}
