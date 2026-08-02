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

export type AccountRecoveryViewState<T extends AccountRecoveryRequestSummary> = {
  pendingRequest: T | undefined;
  mostRecentRequest: T | undefined;
  /**
   * True when the most recently created request was approved - i.e. THIS
   * session's account was just moved as a recovery source. Post-approval
   * session UX rule: the current session must never automatically become
   * the target account, so this drives showing a prominent "log out and
   * log back in with Google" instruction instead of silently doing
   * anything on the caller's behalf. Deliberately never gated on
   * `googleConnected` - the whole point of this state is that the
   * session's Google identity was JUST moved away, so `googleConnected`
   * is expected to already read false here; the approved banner (and its
   * logout/re-login button) must never be hidden or replaced by the
   * not-connected guidance state for that reason.
   */
  justApproved: boolean;
  /**
   * Whether the "submit a new request" form should render at all - never
   * alongside the just-approved banner (that banner's only sanctioned next
   * action is logout+re-login, not filing another request from the same,
   * now Google-identity-less session), never while a request is already
   * pending (see the "max 1 pending" rule), and never unless the CURRENT
   * session is confirmed connected to Google (submitting otherwise would
   * only be rejected server-side with NOT_GOOGLE_LINKED - see
   * server/services/accountRecoveryService.ts's submitAccountRecoveryRequest).
   */
  showForm: boolean;
  /**
   * Whether the "you can't submit a request yet - connect Google first"
   * guidance state should render INSTEAD of the form - exactly the
   * complement of showForm within the "no blocking pending/approved
   * request" case: true only once `googleConnected` has resolved to a
   * confirmed `false`, never merely because it hasn't loaded yet
   * (`undefined`) - AccountRecoveryPage handles the still-loading case
   * with its own separate loading state, never by guessing here.
   */
  showGuidance: boolean;
};

/**
 * `requests` must already be ordered most-recent-first (see
 * db.listAccountRecoveryRequestsForUser's orderBy(desc(createdAt))) - this
 * function does not re-sort, it trusts requests[0] is the latest.
 *
 * `googleConnected` is the CURRENT session's own connection status (see
 * server/_core/env.ts's auth.googleConnectionCutoffStatus query, the
 * existing endpoint this is sourced from - no new endpoint needed) -
 * `undefined` means "not resolved yet" and is treated the same as `false`
 * for showForm (never optimistically shows a form the server would reject)
 * but is deliberately NOT treated as `false` for showGuidance (never shows
 * "you're not connected" guidance while the real answer is still unknown).
 */
export function deriveAccountRecoveryViewState<T extends AccountRecoveryRequestSummary>(
  requests: T[],
  googleConnected: boolean | undefined
): AccountRecoveryViewState<T> {
  const pendingRequest = requests.find((r) => r.status === "pending");
  const mostRecentRequest = requests[0];
  const justApproved = mostRecentRequest?.status === "approved";
  const noBlockingRequest = !justApproved && !pendingRequest;
  return {
    pendingRequest,
    mostRecentRequest,
    justApproved,
    showForm: noBlockingRequest && googleConnected === true,
    showGuidance: noBlockingRequest && googleConnected === false,
  };
}
