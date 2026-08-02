// Pure logic backing AccountRecoveryPage - kept out of the component itself
// (same pattern as upgradeLoginPresentation.ts/checkoutOutcome.ts elsewhere
// in this codebase) so it's directly testable without a DOM harness (this
// repo has none - no @testing-library/jsdom installed).

export type AccountRecoveryRequestSummary = {
  id: number;
  status: "pending" | "approved" | "rejected" | "cancelled" | "blocked";
  createdAt: Date | string;
  reviewReason?: string | null;
};

/**
 * The CURRENT session's `auth.googleConnectionCutoffStatus` query state -
 * exactly the three signals a React Query result actually exposes
 * (isLoading/isError/data), passed through verbatim rather than
 * pre-collapsed by the caller, so this file (not AccountRecoveryPage.tsx)
 * owns the one true priority order below.
 */
export type GoogleConnectionQueryStatus = {
  loading: boolean;
  error: boolean;
  /** `statusQuery.data?.googleConnected` - only meaningful when neither `loading` nor `error` is true. */
  connected: boolean | undefined;
};

/**
 * The single, mutually-exclusive state AccountRecoveryPage renders -
 * replaces the old pair of independent `showForm`/`showGuidance` booleans
 * specifically because independent booleans left a real gap: neither one
 * accounted for `statusQuery.isError`, so a failed connection-status query
 * silently fell through to "show nothing" (empty space, no explanation, no
 * way forward). A single discriminated view makes every case explicit and
 * exhaustive - see deriveAccountRecoveryViewState's priority order.
 */
export type AccountRecoveryView = "approved" | "pending" | "connection_loading" | "connection_error" | "form" | "guidance";

export type AccountRecoveryViewState<T extends AccountRecoveryRequestSummary> = {
  pendingRequest: T | undefined;
  mostRecentRequest: T | undefined;
  /**
   * True when the most recently created request was approved - i.e. THIS
   * session's account was just moved as a recovery source. Post-approval
   * session UX rule: the current session must never automatically become
   * the target account, so this drives showing a prominent "log out and
   * log back in with Google" instruction instead of silently doing
   * anything on the caller's behalf. Deliberately never gated on the
   * connection status (loading/error/connected) - the whole point of this
   * state is that the session's Google identity was JUST moved away, so
   * `connected` is expected to already read false here, and a connection-
   * status query failure must never hide it either; the approved banner
   * (and its logout/re-login button) always wins, see `view` below.
   */
  justApproved: boolean;
  /**
   * The one field AccountRecoveryPage should actually switch on. Priority
   * order (each step only reached if every earlier one doesn't apply):
   *   1. "approved"           - justApproved, regardless of connection status
   *   2. "pending"            - a pending request exists, regardless of connection status
   *   3. "connection_loading" - no blocking request, but the connection-status query hasn't resolved yet
   *   4. "connection_error"   - no blocking request, and the connection-status query failed
   *   5. "form"                - no blocking request, query succeeded, googleConnected === true
   *   6. "guidance"            - no blocking request, query succeeded, googleConnected !== true
   * A connection-status query failure can therefore never hide an approved
   * or pending request (steps 1-2 are checked first and never consult the
   * connection status at all), and the form is never shown without a
   * confirmed successful `true` read.
   */
  view: AccountRecoveryView;
};

/**
 * `requests` must already be ordered most-recent-first (see
 * db.listAccountRecoveryRequestsForUser's orderBy(desc(createdAt))) - this
 * function does not re-sort, it trusts requests[0] is the latest.
 *
 * `connection` is the CURRENT session's own `auth.googleConnectionCutoffStatus`
 * query state (see server/_core/env.ts's evaluateGoogleConnectionCutoff,
 * the existing endpoint this is sourced from - no new endpoint needed).
 */
export function deriveAccountRecoveryViewState<T extends AccountRecoveryRequestSummary>(
  requests: T[],
  connection: GoogleConnectionQueryStatus
): AccountRecoveryViewState<T> {
  const pendingRequest = requests.find((r) => r.status === "pending");
  const mostRecentRequest = requests[0];
  const justApproved = mostRecentRequest?.status === "approved";

  let view: AccountRecoveryView;
  if (justApproved) {
    view = "approved";
  } else if (pendingRequest) {
    view = "pending";
  } else if (connection.loading) {
    view = "connection_loading";
  } else if (connection.error) {
    view = "connection_error";
  } else if (connection.connected === true) {
    view = "form";
  } else {
    view = "guidance";
  }

  return { pendingRequest, mostRecentRequest, justApproved, view };
}
