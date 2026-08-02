import { describe, expect, it } from "vitest";
import {
  deriveAccountRecoveryViewState,
  type AccountRecoveryRequestSummary,
  type GoogleConnectionQueryStatus,
} from "./accountRecoveryPresentation";

function req(overrides: Partial<AccountRecoveryRequestSummary> & { id: number }): AccountRecoveryRequestSummary {
  return {
    status: "pending",
    createdAt: new Date(),
    reviewReason: null,
    ...overrides,
  };
}

function connection(overrides: Partial<GoogleConnectionQueryStatus> = {}): GoogleConnectionQueryStatus {
  return {
    loading: false,
    error: false,
    connected: undefined,
    ...overrides,
  };
}

describe("deriveAccountRecoveryViewState", () => {
  it('no requests, Google connected -> view "form", nothing pending, nothing just-approved', () => {
    const result = deriveAccountRecoveryViewState([], connection({ connected: true }));
    expect(result.view).toBe("form");
    expect(result.pendingRequest).toBeUndefined();
    expect(result.justApproved).toBe(false);
  });

  it('no requests, Google NOT connected -> view "guidance" (the not-connected guidance state)', () => {
    const result = deriveAccountRecoveryViewState([], connection({ connected: false }));
    expect(result.view).toBe("guidance");
  });

  it('no requests, connection status still loading -> view "connection_loading" - never guesses form or guidance', () => {
    const result = deriveAccountRecoveryViewState([], connection({ loading: true }));
    expect(result.view).toBe("connection_loading");
  });

  it('no requests, connection status query failed -> view "connection_error"', () => {
    const result = deriveAccountRecoveryViewState([], connection({ error: true }));
    expect(result.view).toBe("connection_error");
  });

  it('a pending request -> view "pending", pendingRequest returned, not justApproved - regardless of connection status (loading/error/connected/not-connected)', () => {
    const pending = req({ id: 1, status: "pending" });
    for (const status of [
      connection({ connected: true }),
      connection({ connected: false }),
      connection({ loading: true }),
      connection({ error: true }),
    ]) {
      const result = deriveAccountRecoveryViewState([pending], status);
      expect(result.view).toBe("pending");
      expect(result.pendingRequest).toBe(pending);
      expect(result.justApproved).toBe(false);
    }
  });

  it("[pending + connection status query error] the pending state is still shown - a connection-status failure must never hide it", () => {
    const pending = req({ id: 1, status: "pending" });
    const result = deriveAccountRecoveryViewState([pending], connection({ error: true }));
    expect(result.view).toBe("pending");
  });

  it('[post-approval session UX] most recent request is approved -> justApproved true, view "approved" (never silently resubmit, auto-switch, or show guidance/error instead of the approval banner)', () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved], connection({ connected: true }));
    expect(result.justApproved).toBe(true);
    expect(result.view).toBe("approved");
    expect(result.mostRecentRequest).toBe(approved);
  });

  it("[approved + Google identity already moved away] view stays \"approved\" even though connected now reads false - the approved banner (and its logout/re-login button) must never be replaced by the not-connected guidance state", () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved], connection({ connected: false }));
    expect(result.justApproved).toBe(true);
    expect(result.view).toBe("approved");
  });

  it("[approved + connection status query error] view stays \"approved\" - a connection-status failure must never hide the approval banner", () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved], connection({ error: true }));
    expect(result.justApproved).toBe(true);
    expect(result.view).toBe("approved");
  });

  it('most recent request is rejected, Google still connected -> not justApproved, view "form" again (a rejected request never blocks resubmission)', () => {
    const rejected = req({ id: 3, status: "rejected" });
    const result = deriveAccountRecoveryViewState([rejected], connection({ connected: true }));
    expect(result.justApproved).toBe(false);
    expect(result.view).toBe("form");
  });

  it('most recent request is rejected, Google NOT connected -> view "guidance" instead of a form that would just be rejected server-side', () => {
    const rejected = req({ id: 3, status: "rejected" });
    const result = deriveAccountRecoveryViewState([rejected], connection({ connected: false }));
    expect(result.justApproved).toBe(false);
    expect(result.view).toBe("guidance");
  });

  it('most recent request is cancelled, Google still connected -> view "form" again', () => {
    const cancelled = req({ id: 4, status: "cancelled" });
    const result = deriveAccountRecoveryViewState([cancelled], connection({ connected: true }));
    expect(result.view).toBe("form");
  });

  it('most recent request is cancelled, Google NOT connected -> view "guidance" instead', () => {
    const cancelled = req({ id: 4, status: "cancelled" });
    const result = deriveAccountRecoveryViewState([cancelled], connection({ connected: false }));
    expect(result.view).toBe("guidance");
  });

  it('most recent request is blocked -> not justApproved; view "form" when connected (blocked ≠ approved, this component makes no further claim about blocked UX beyond not showing the approval banner)', () => {
    const blocked = req({ id: 5, status: "blocked" });
    const result = deriveAccountRecoveryViewState([blocked], connection({ connected: true }));
    expect(result.justApproved).toBe(false);
    expect(result.view).toBe("form");
  });

  it("history ordering is trusted, not re-derived: an OLDER approved request behind a newer pending one does not trigger justApproved (requests[0] must be the most recent)", () => {
    const pending = req({ id: 10, status: "pending" });
    const olderApproved = req({ id: 9, status: "approved" });
    const result = deriveAccountRecoveryViewState([pending, olderApproved], connection({ connected: true }));
    expect(result.justApproved).toBe(false);
    expect(result.pendingRequest).toBe(pending);
    expect(result.view).toBe("pending");
  });

  it("a newer approved request in front of an older pending one (should be structurally impossible - at most 1 pending at a time - but proves the function trusts index 0 regardless) -> justApproved true", () => {
    const newerApproved = req({ id: 11, status: "approved" });
    const olderPending = req({ id: 8, status: "pending" });
    const result = deriveAccountRecoveryViewState([newerApproved, olderPending], connection({ connected: true }));
    expect(result.justApproved).toBe(true);
    expect(result.view).toBe("approved");
  });

  it("reviewReason is passed through on mostRecentRequest for display", () => {
    const approved = req({ id: 6, status: "approved", reviewReason: "ยืนยันตัวตนสำเร็จ" });
    const result = deriveAccountRecoveryViewState([approved], connection({ connected: true }));
    expect(result.mostRecentRequest?.reviewReason).toBe("ยืนยันตัวตนสำเร็จ");
  });

  it('the "connection_error" view carries no error detail of any kind on the returned state - callers can only ever render the fixed, safe copy the component owns, never anything from the failed query itself', () => {
    const result = deriveAccountRecoveryViewState([], connection({ error: true }));
    expect(result.view).toBe("connection_error");
    expect(Object.keys(result).sort()).toEqual(["justApproved", "mostRecentRequest", "pendingRequest", "view"]);
  });
});
