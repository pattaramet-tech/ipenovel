// Pure decision logic behind the global Google-connection migration gate
// (App.tsx's <MigrationGate>) - kept out of the component itself (same
// pattern as unauthorizedRedirect.ts/globalUnauthorizedRedirect.ts
// elsewhere in this codebase) so it's directly testable without a DOM
// harness (this repo has none - no @testing-library/jsdom installed).
//
// This is a UX convenience only, never the actual security boundary - a
// user can always call the tRPC API directly, bypassing any client-side
// route gate. The real enforcement is server/_core/googleMigrationGate.ts,
// wired into every protectedProcedure centrally. This gate exists so a
// gated user sees a clear, in-app explanation instead of a wall of failed
// API calls.
//
// As of the targeted-cutoff feature, this file deliberately does NOT
// decide "is the gate active" from the client's own clock or its own copy
// of VITE_AUTH_PROVIDER/VITE_AUTH_REQUIRE_GOOGLE_CONNECTION - that
// three-way decision (enabled/cutoffAt/activeNow) is now made exclusively
// by the server (server/_core/env.ts's evaluateGoogleConnectionCutoff) and
// fetched via the auth.googleConnectionCutoffStatus query;
// resolveMigrationGateAction below only ever branches on that response's
// own `needsConnection` field. The client's build-time env vars are still
// used, but ONLY by isMandatoryGoogleConnectionEnabled, for the
// lower-stakes /login button-ordering decision (LoginPage.tsx) - never for
// deciding whether to redirect an already-authenticated user away from a
// page.

/**
 * Exact-literal match, same discipline as resolveLoginUrl/
 * shouldShowGoogleConnectSection - only "transition" + exactly "true"
 * activates the /login button-ordering behavior. Any other combination
 * (including AUTH_PROVIDER=google with the flag left on from an earlier
 * deploy) never changes /login's button order. NOT used to decide the
 * actual redirect gate - see this file's top-of-file docstring.
 */
export function isMandatoryGoogleConnectionEnabled(
  viteAuthProvider: string | undefined,
  viteRequireGoogleConnection: string | undefined
): boolean {
  return (
    viteAuthProvider === "transition" && viteRequireGoogleConnection === "true"
  );
}

const GATE_EXEMPT_EXACT_PATHS = new Set([
  "/account/upgrade-login",
  "/login",
  "/account/recovery",
]);

/**
 * Paths the gate must never redirect away from, regardless of connection
 * status - the upgrade page and the login page itself (redirecting away
 * from either would be a redirect loop), and the entire admin surface
 * (admin sessions/actions are never subject to this customer-facing
 * migration gate - see server/_core/trpc.ts's adminProcedure, which is
 * built on authenticatedProcedure, never protectedProcedure, for the exact
 * same reason on the server side).
 *
 * /account/recovery is exempt for the SAME reason as /account/upgrade-login
 * - a user whose Google identity was just moved AWAY from their current
 * session by an approved recovery request (see
 * server/services/accountRecoveryService.ts's executeAccountRecovery) has,
 * by definition, no linked Google identity anymore. Once a targeted cutoff
 * is active, that would otherwise make needsConnection=true and bounce
 * them to /account/upgrade-login before they ever see the "your request
 * was approved - log out and log back in with Google" message and button
 * on /account/recovery (client/src/pages/AccountRecoveryPage.tsx) - a
 * redirect loop away from the one page that explains what to do next.
 *
 * Deliberately an EXACT match, not a startsWith("/account/recovery")
 * prefix - only the one real route (see client/src/App.tsx) is exempt;
 * there is no other page in this codebase that route prefix would
 * currently match, and none should become exempt by accident just by
 * sharing that prefix in the future without its own deliberate decision.
 * Every other /account/* page (e.g. /account/upgrade-login is separately
 * listed above; a future /account/profile or similar) remains fully
 * gated - this exemption is scoped to this one page's specific job, not a
 * blanket "the whole /account surface is exempt" rule.
 */
export function isMigrationGateExemptPath(pathname: string): boolean {
  if (GATE_EXEMPT_EXACT_PATHS.has(pathname)) return true;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
  return false;
}

export type MigrationGateAction =
  | "allow"
  | "block_loading"
  | "block_error"
  | "block_merged"
  | "redirect_upgrade";

export type MigrationGateInput = {
  pathname: string;
  isAuthenticated: boolean;
  authLoading: boolean;
  /** Loading state of the auth.googleConnectionCutoffStatus query - only meaningful once authenticated and on a non-exempt path (see this function's only call site's `enabled` guard). */
  statusLoading: boolean;
  /**
   * True when the auth.googleConnectionCutoffStatus query itself failed
   * (an infrastructure error). Must NEVER be treated as "no connection
   * needed" (fail open) NOR silently redirected to the upgrade page as if
   * the server had confirmed connection is required (that would tell a
   * possibly-exempt or already-connected user they need to upgrade, based
   * on a guess) - resolves to its own distinct "block_error" action, never
   * "allow" and never "redirect_upgrade".
   */
  statusError: boolean;
  /** True only when this authenticated user is the retained Source row of a completed Advanced Account Merge. */
  accountMerged?: boolean;
  /** The server's own `needsConnection` field (server/_core/env.ts's evaluateGoogleConnectionCutoff, combined with this user's own connected/exempt status) - the ONE field this function branches on to decide redirect_upgrade. `undefined` = not yet resolved (distinct from a real `false`). */
  needsConnection: boolean | undefined;
};

/**
 * The single decision point for what <MigrationGate> should render for the
 * current route/auth state. Anonymous visitors and every exempt path are
 * always "allow" (public pages, /login, /account/upgrade-login itself, and
 * the whole /admin surface) - the gate only ever engages for an
 * authenticated, non-exempt-path user, and even then only once the
 * server's own status response says `needsConnection: true`.
 */
export function resolveMigrationGateAction(
  input: MigrationGateInput
): MigrationGateAction {
  // A confirmed anonymous state must win over any cached status-query payload.
  // TanStack Query can retain the previous accountMerged=true data after a
  // successful logout disables the query; once auth.me says there is no
  // session, that stale payload must never trap the browser on block_merged.
  if (!input.isAuthenticated) return "allow";

  // Completed merge Sources retain their historical users row/openId, so a
  // stale JWT may still authenticate. For an authenticated Source this state
  // stays blocked even while logout is pending, and has priority over the
  // Google migration-path exemptions such as /account/recovery.
  if (input.accountMerged === true) return "block_merged";
  if (isMigrationGateExemptPath(input.pathname)) return "allow";
  // Auth state itself hasn't settled yet - never redirect based on a guess.
  // This runs after the authenticated merged-session check so a logout that
  // is merely pending cannot briefly reveal the underlying protected page.
  if (input.authLoading) return "allow";
  if (input.statusLoading) return "block_loading";
  if (input.statusError) return "block_error";
  if (input.needsConnection === true) return "redirect_upgrade";
  return "allow";
}

export type UpcomingCutoffBannerInput = {
  /** server/_core/env.ts's evaluateGoogleConnectionCutoff().enabled - the feature is switched on at all. */
  enabled: boolean;
  /** server/_core/env.ts's evaluateGoogleConnectionCutoff().activeNow - the cutoff has already been reached (in which case the banner is moot - the user is either already redirected to /account/upgrade-login, or exempt/connected). */
  activeNow: boolean;
  googleConnected: boolean | undefined;
  exempt: boolean | undefined;
};

/**
 * Whether the visible-but-non-disruptive "an upcoming cutoff will require
 * connecting Google" banner (rule 13) should show on the current page. Only
 * true in the narrow window where the feature is on, the cutoff hasn't
 * happened YET (once it has, <MigrationGate> itself takes over via
 * redirect_upgrade instead), the user isn't exempt, and they haven't
 * already connected - connecting immediately hides the banner on next
 * refetch, without any separate dismiss/hide state to manage.
 */
export function shouldShowUpcomingCutoffBanner(
  input: UpcomingCutoffBannerInput
): boolean {
  return (
    input.enabled &&
    !input.activeNow &&
    input.exempt === false &&
    input.googleConnected === false
  );
}
