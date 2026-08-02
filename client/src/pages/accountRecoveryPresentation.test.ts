import { describe, expect, it } from "vitest";
import { deriveAccountRecoveryViewState, type AccountRecoveryRequestSummary } from "./accountRecoveryPresentation";

function req(overrides: Partial<AccountRecoveryRequestSummary> & { id: number }): AccountRecoveryRequestSummary {
  return {
    status: "pending",
    createdAt: new Date(),
    reviewReason: null,
    ...overrides,
  };
}

describe("deriveAccountRecoveryViewState", () => {
  it("no requests, Google connected -> showForm true, showGuidance false, nothing pending, nothing just-approved", () => {
    const result = deriveAccountRecoveryViewState([], true);
    expect(result.showForm).toBe(true);
    expect(result.showGuidance).toBe(false);
    expect(result.pendingRequest).toBeUndefined();
    expect(result.justApproved).toBe(false);
  });

  it("no requests, Google NOT connected -> showForm false, showGuidance true (the not-connected guidance state)", () => {
    const result = deriveAccountRecoveryViewState([], false);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(true);
  });

  it("no requests, Google connection status still loading (undefined) -> neither showForm nor showGuidance - never guesses", () => {
    const result = deriveAccountRecoveryViewState([], undefined);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(false);
  });

  it("a pending request -> showForm false, showGuidance false, pendingRequest returned, not justApproved - regardless of googleConnected", () => {
    const pending = req({ id: 1, status: "pending" });
    for (const googleConnected of [true, false, undefined]) {
      const result = deriveAccountRecoveryViewState([pending], googleConnected);
      expect(result.showForm).toBe(false);
      expect(result.showGuidance).toBe(false);
      expect(result.pendingRequest).toBe(pending);
      expect(result.justApproved).toBe(false);
    }
  });

  it("[post-approval session UX] most recent request is approved -> justApproved true, showForm false, showGuidance false (never silently resubmit, auto-switch, or show not-connected guidance instead of the approval banner)", () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved], true);
    expect(result.justApproved).toBe(true);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(false);
    expect(result.mostRecentRequest).toBe(approved);
  });

  it("[approved + Google identity already moved away] justApproved stays true and showGuidance stays false even though googleConnected now reads false - the approved banner (and its logout/re-login button) must never be replaced by the not-connected guidance state", () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved], false);
    expect(result.justApproved).toBe(true);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(false);
  });

  it("most recent request is rejected, Google still connected -> not justApproved, form IS shown again (a rejected request never blocks resubmission)", () => {
    const rejected = req({ id: 3, status: "rejected" });
    const result = deriveAccountRecoveryViewState([rejected], true);
    expect(result.justApproved).toBe(false);
    expect(result.showForm).toBe(true);
    expect(result.showGuidance).toBe(false);
  });

  it("most recent request is rejected, Google NOT connected -> not justApproved, guidance shown instead of a form that would just be rejected server-side", () => {
    const rejected = req({ id: 3, status: "rejected" });
    const result = deriveAccountRecoveryViewState([rejected], false);
    expect(result.justApproved).toBe(false);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(true);
  });

  it("most recent request is cancelled, Google still connected -> form shown again", () => {
    const cancelled = req({ id: 4, status: "cancelled" });
    const result = deriveAccountRecoveryViewState([cancelled], true);
    expect(result.showForm).toBe(true);
    expect(result.showGuidance).toBe(false);
  });

  it("most recent request is cancelled, Google NOT connected -> guidance shown instead", () => {
    const cancelled = req({ id: 4, status: "cancelled" });
    const result = deriveAccountRecoveryViewState([cancelled], false);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(true);
  });

  it("most recent request is blocked -> not justApproved; form still shown when connected (blocked ≠ approved, this component makes no further claim about blocked UX beyond not showing the approval banner)", () => {
    const blocked = req({ id: 5, status: "blocked" });
    const result = deriveAccountRecoveryViewState([blocked], true);
    expect(result.justApproved).toBe(false);
    expect(result.showForm).toBe(true);
  });

  it("history ordering is trusted, not re-derived: an OLDER approved request behind a newer pending one does not trigger justApproved (requests[0] must be the most recent)", () => {
    const pending = req({ id: 10, status: "pending" });
    const olderApproved = req({ id: 9, status: "approved" });
    const result = deriveAccountRecoveryViewState([pending, olderApproved], true);
    expect(result.justApproved).toBe(false);
    expect(result.pendingRequest).toBe(pending);
    expect(result.showForm).toBe(false);
    expect(result.showGuidance).toBe(false);
  });

  it("a newer approved request in front of an older pending one (should be structurally impossible - at most 1 pending at a time - but proves the function trusts index 0 regardless) -> justApproved true", () => {
    const newerApproved = req({ id: 11, status: "approved" });
    const olderPending = req({ id: 8, status: "pending" });
    const result = deriveAccountRecoveryViewState([newerApproved, olderPending], true);
    expect(result.justApproved).toBe(true);
    expect(result.showForm).toBe(false);
  });

  it("reviewReason is passed through on mostRecentRequest for display", () => {
    const approved = req({ id: 6, status: "approved", reviewReason: "ยืนยันตัวตนสำเร็จ" });
    const result = deriveAccountRecoveryViewState([approved], true);
    expect(result.mostRecentRequest?.reviewReason).toBe("ยืนยันตัวตนสำเร็จ");
  });
});
