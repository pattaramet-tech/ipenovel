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
  it("no requests at all -> showForm true, nothing pending, nothing just-approved", () => {
    const result = deriveAccountRecoveryViewState([]);
    expect(result.showForm).toBe(true);
    expect(result.pendingRequest).toBeUndefined();
    expect(result.justApproved).toBe(false);
  });

  it("a pending request -> showForm false, pendingRequest returned, not justApproved", () => {
    const pending = req({ id: 1, status: "pending" });
    const result = deriveAccountRecoveryViewState([pending]);
    expect(result.showForm).toBe(false);
    expect(result.pendingRequest).toBe(pending);
    expect(result.justApproved).toBe(false);
  });

  it("[post-approval session UX] most recent request is approved -> justApproved true, showForm false (never silently resubmit or auto-switch)", () => {
    const approved = req({ id: 2, status: "approved" });
    const result = deriveAccountRecoveryViewState([approved]);
    expect(result.justApproved).toBe(true);
    expect(result.showForm).toBe(false);
    expect(result.mostRecentRequest).toBe(approved);
  });

  it("most recent request is rejected -> not justApproved, form IS shown again (a rejected request never blocks resubmission)", () => {
    const rejected = req({ id: 3, status: "rejected" });
    const result = deriveAccountRecoveryViewState([rejected]);
    expect(result.justApproved).toBe(false);
    expect(result.showForm).toBe(true);
  });

  it("most recent request is cancelled -> form shown again", () => {
    const cancelled = req({ id: 4, status: "cancelled" });
    const result = deriveAccountRecoveryViewState([cancelled]);
    expect(result.showForm).toBe(true);
  });

  it("most recent request is blocked -> not justApproved; form still shown (blocked ≠ approved, this component makes no further claim about blocked UX beyond not showing the approval banner)", () => {
    const blocked = req({ id: 5, status: "blocked" });
    const result = deriveAccountRecoveryViewState([blocked]);
    expect(result.justApproved).toBe(false);
    expect(result.showForm).toBe(true);
  });

  it("history ordering is trusted, not re-derived: an OLDER approved request behind a newer pending one does not trigger justApproved (requests[0] must be the most recent)", () => {
    const pending = req({ id: 10, status: "pending" });
    const olderApproved = req({ id: 9, status: "approved" });
    const result = deriveAccountRecoveryViewState([pending, olderApproved]);
    expect(result.justApproved).toBe(false);
    expect(result.pendingRequest).toBe(pending);
    expect(result.showForm).toBe(false);
  });

  it("a newer approved request in front of an older pending one (should be structurally impossible - at most 1 pending at a time - but proves the function trusts index 0 regardless) -> justApproved true", () => {
    const newerApproved = req({ id: 11, status: "approved" });
    const olderPending = req({ id: 8, status: "pending" });
    const result = deriveAccountRecoveryViewState([newerApproved, olderPending]);
    expect(result.justApproved).toBe(true);
    expect(result.showForm).toBe(false);
  });

  it("reviewReason is passed through on mostRecentRequest for display", () => {
    const approved = req({ id: 6, status: "approved", reviewReason: "ยืนยันตัวตนสำเร็จ" });
    const result = deriveAccountRecoveryViewState([approved]);
    expect(result.mostRecentRequest?.reviewReason).toBe("ยืนยันตัวตนสำเร็จ");
  });
});
