import { describe, expect, it } from "vitest";
import {
  deriveApprovalPresentationState,
} from "./workspaceChapterCanvas";

/**
 * IPE-058-E review fix truth table: pending_confirm is ONLY reachable via
 * hasDraft + qcState CURRENT_READY + qcReady, and never as a fallback.
 */
describe("deriveApprovalPresentationState truth table", () => {
  const base = {
    hasDraft: true,
    qcState: "CURRENT_READY" as const,
    qcReady: true,
    approvalValid: false,
    readyToPublish: false,
  };

  it.each([
    ["no_draft", { hasDraft: false }],
    ["ready_to_publish", { readyToPublish: true }],
    ["approved", { approvalValid: true }],
    ["checker_stale", { qcState: "STALE" }],
    ["checker_error", { qcState: "ERROR" }],
    ["checking", { qcState: "RUNNING" }],
    ["checker_not_run", { qcState: "NOT_RUN" }],
    ["checker_not_run", { qcState: undefined }],
    ["checker_not_run", { qcState: null }],
    [
      "qc_blocked",
      { qcState: "CURRENT_HAS_FINDINGS", qcReady: false },
    ],
    // Defensive: CURRENT_READY but qc.ready false is blocked, never fallback.
    ["qc_blocked", { qcReady: false }],
    ["pending_confirm", {}],
  ] as const)("%s", (expected, overrides) => {
    expect(deriveApprovalPresentationState({ ...base, ...overrides })).toBe(
      expected
    );
  });
});
