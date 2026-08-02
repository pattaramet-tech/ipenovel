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
   * anything on the caller's behalf.
   */
  justApproved: boolean;
  /** Whether the "submit a new request" form should render at all - never
   *  alongside the just-approved banner (that banner's only sanctioned
   *  next action is logout+re-login, not filing another request from the
   *  same, now Google-identity-less session) and never while a request is
   *  already pending (see the "max 1 pending" rule). */
  showForm: boolean;
};

/**
 * `requests` must already be ordered most-recent-first (see
 * db.listAccountRecoveryRequestsForUser's orderBy(desc(createdAt))) - this
 * function does not re-sort, it trusts requests[0] is the latest.
 */
export function deriveAccountRecoveryViewState<T extends AccountRecoveryRequestSummary>(
  requests: T[]
): AccountRecoveryViewState<T> {
  const pendingRequest = requests.find((r) => r.status === "pending");
  const mostRecentRequest = requests[0];
  const justApproved = mostRecentRequest?.status === "approved";
  return {
    pendingRequest,
    mostRecentRequest,
    justApproved,
    showForm: !justApproved && !pendingRequest,
  };
}
