// Pure logic backing AccountRecoveryPage - kept out of the component itself
// (same pattern as upgradeLoginPresentation.ts/checkoutOutcome.ts elsewhere
// in this codebase) so it's directly testable without a DOM harness (this
// repo has none - no @testing-library/jsdom installed).

export type AccountRecoveryRequestSummary = {
  id: number;
  status: "pending" | "approved" | "rejected" | "cancelled" | "blocked";
  createdAt: Date | string;
  reviewReason?: string | null;
  lifecycle?: {
    persistedStatus: "pending" | "approved" | "rejected" | "cancelled" | "blocked";
    effectiveStatus: "pending" | "approved" | "rejected" | "cancelled" | "blocked" | "resolved_via_advanced_merge";
    resolutionKind: "advanced_account_merge" | null;
    integrity: "not_applicable" | "unresolved" | "verified" | "inconsistent";
    mergeCaseId: number | null;
    mergeCaseStatus: string | null;
    completedAt: Date | string | null;
  };
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
export type AccountRecoveryView = "resolved_via_advanced_merge" | "approved" | "pending" | "connection_loading" | "connection_error" | "form" | "guidance";

export type AccountRecoveryViewState<T extends AccountRecoveryRequestSummary> = {
  pendingRequest: T | undefined;
  mostRecentRequest: T | undefined;
  /** Verified derived completion of the most-recent BLOCKED request through Advanced Merge. */
  resolvedViaAdvancedMerge: boolean;
  /**
   * True when the most recently created request was approved. The requester
   * is already the Survivor/canonical account and retains its Google identity,
   * so this flag selects the success presentation without any account switch
   * or fresh-login requirement.
   */
  justApproved: boolean;
  /**
   * The one field AccountRecoveryPage should actually switch on. Priority:
   *   1. "resolved_via_advanced_merge" - verified completed Advanced Merge
   *   2. "approved"                    - Simple Recovery approved
   *   3. "pending"                     - an active request exists
   *   4. "connection_loading"
   *   5. "connection_error"
   *   6. "form"
   *   7. "guidance"
   * Completed recovery outcomes always beat connection-status state. The
   * requester remains the Survivor and keeps Google ownership; a transient
   * connection-status read must not replace the verified success state.
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
  const mostRecentEffectiveStatus =
    mostRecentRequest?.lifecycle?.effectiveStatus ?? mostRecentRequest?.status;
  const resolvedViaAdvancedMerge =
    mostRecentEffectiveStatus === "resolved_via_advanced_merge";
  const justApproved = mostRecentEffectiveStatus === "approved";

  let view: AccountRecoveryView;
  if (resolvedViaAdvancedMerge) {
    view = "resolved_via_advanced_merge";
  } else if (justApproved) {
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

  return {
    pendingRequest,
    mostRecentRequest,
    resolvedViaAdvancedMerge,
    justApproved,
    view,
  };
}
