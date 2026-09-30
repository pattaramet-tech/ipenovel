import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

/**
 * IPE-058-E static contract: checker/QC state comes from ONE canonical pure
 * evaluator, surfaced through the durable read models; no `open===0 => ready`
 * shortcut; auto-recheck is exactly-once per draft identity.
 */
describe("Workspace QC state hardening static contract", () => {
  it("consolidates checker state derivation onto the pure evaluator", () => {
    const domain = source("server/workspace/editorialForeignChecker.domain.ts");
    const checkerService = source("server/workspace/editorialForeignChecker.service.ts");
    const approvalService = source("server/workspace/editorialApproval.service.ts");
    expect(domain).toContain("evaluateEditorialCheckerState");
    expect(domain).toContain('"CURRENT_READY"');
    expect(domain).toContain('"CURRENT_HAS_FINDINGS"');
    expect(domain).toContain('"STALE"');
    expect(domain).toContain('"ERROR"');
    expect(domain).toContain('"NOT_RUN"');
    expect(checkerService).toContain("evaluateEditorialCheckerState(");
    expect(approvalService).toContain("evaluateEditorialCheckerState(");
    // QC read model carries the canonical state for status chips.
    expect(approvalService).toContain('state: "NOT_RUN" as const');
    expect(approvalService).toContain('state: "STALE" as const');
  });

  it("keeps the fail-closed QC readiness derivation (never count-only)", () => {
    const approvalService = source("server/workspace/editorialApproval.service.ts");
    expect(approvalService).toContain('"CHECKER_STALE" as const');
    expect(approvalService).toContain('"CHECKER_REQUIRED" as const');
    expect(approvalService).toContain('"QC_UNRESOLVED" as const');
    // IPE-058-E review fix (Blocking 1): EVERY QC return branch carries the
    // canonical state — including the allow-list stale branch.
    expect(approvalService).toContain('state: "NOT_RUN" as const');
    expect(approvalService).toContain('state: "STALE" as const');
  });

  it('IPE-058-E review fix: effectiveStatus derives from the canonical state (STALE never passed)', () => {
    const checkerService = source('server/workspace/editorialForeignChecker.service.ts');
    // Count-only shortcut is gone (Blocking 5).
    expect(checkerService).not.toContain(
      'effectiveStatus: blockingIssueCount === 0 ? "passed" : "failed"'
    );
    expect(checkerService).toContain('state === "CURRENT_READY"');
    expect(checkerService).toContain('"stale" as const');
  });

  it("derives UI status chips from the server state machine", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("editorialCheckerState");
    // pending_confirm is derived from the presentation helper — never a fallback.
    expect(page).toContain('deriveApprovalPresentationState({');
    expect(page).toContain('hasDraft: Boolean(editorialApprovalData?.latestDraft)');
    expect(page).toContain("editorialQCReasonText");
    expect(page).toContain("Checker ERROR —");
  });

  it("deduplicates automatic recheck per draft identity (exactly once)", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("runEditorialForeignCheckerOnceForDraft");
    expect(page).toContain("editorialAutoRecheckInFlight");
    expect(page).toContain("editorialAutoRecheckDone");
  });

  it("keeps the guarded replace_tab save + approval/Stage protections", () => {
    const approvalService = source("server/workspace/editorialApproval.service.ts");
    expect(approvalService).toContain('"DRAFT_CHANGED" as const');
    expect(approvalService).toContain('"QC_CHANGED" as const');
    expect(approvalService).toContain('"APPROVAL_CHANGED" as const');
  });
});
