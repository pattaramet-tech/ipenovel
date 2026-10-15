import { describe, expect, it } from "vitest";
import { analyzeEditorialEpisodeDraftBatch } from "./editorialApproval.domain";
import { authorCheckerEvidence, authorStageAction, projectAuthorCheckerFinding } from "./authorEditorial.service";

const readyPlan = {
  approvalValid: true,
  approvalReason: null,
  planReady: true,
  planReason: null,
  hasExistingStage: false,
  existingStageValid: false,
  existingStageReason: "STAGE_REQUIRED",
};

describe("author Stage action readiness", () => {
  it("allows the first Stage when approval and the plan are ready and no Stage exists", () => {
    expect(authorStageAction(readyPlan)).toEqual({ ready: true, reason: null });
  });

  it("allows replay when the existing Stage is still valid", () => {
    expect(authorStageAction({
      ...readyPlan,
      hasExistingStage: true,
      existingStageValid: true,
      existingStageReason: null,
    })).toEqual({ ready: true, reason: null });
  });

  it("blocks a stale approval even if an older Stage was valid", () => {
    const result = authorStageAction({
      ...readyPlan,
      approvalValid: false,
      approvalReason: "DRAFT_CHANGED",
      hasExistingStage: true,
      existingStageValid: false,
      existingStageReason: "APPROVAL_CHANGED",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("draft changed");
  });

  it("blocks an invalid Stage plan from the episode planner", () => {
    const plan = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "12",
      episodeTitle: "ชื่อจาก Intake",
      tabs: [],
    });
    expect(plan.ready).toBe(false);
    const result = authorStageAction({
      ...readyPlan,
      planReady: plan.ready,
      planReason: plan.blockers.map(item => item.message).join(" · "),
      existingStageReason: "STAGE_PLAN_INVALID",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe(plan.blockers.map(item => item.message).join(" · "));
    expect(result.reason?.length).toBeGreaterThan(0);
  });

  it("blocks a drifted existing Stage", () => {
    const result = authorStageAction({
      ...readyPlan,
      hasExistingStage: true,
      existingStageValid: false,
      existingStageReason: "EPISODE_DRIFTED",
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("no longer matches");
  });
});

describe("author checker evidence", () => {
  const finding = projectAuthorCheckerFinding({
    id: 4,
    token: "คำต่าง",
    disposition: "open",
    resolutionVersion: 1,
    sourceTabId: "tab-1",
    paragraphKey: "p-2",
    startOffset: 0,
    endOffset: 6,
  });

  it("keeps findings from the current run", () => {
    const evidence = authorCheckerEvidence({
      isCurrent: true,
      state: "CURRENT_HAS_FINDINGS",
      findings: [finding],
    });
    expect(evidence.isCurrent).toBe(true);
    expect(evidence.canResolveFindings).toBe(true);
    expect(evidence.findings).toEqual([finding]);
    expect(evidence.recheckMessage).toBeNull();
  });

  it("hides findings after the draft changes and asks for a new QC run", () => {
    const evidence = authorCheckerEvidence({
      isCurrent: false,
      state: "STALE",
      findings: [finding],
    });
    expect(evidence.canResolveFindings).toBe(false);
    expect(evidence.findings).toEqual([]);
    expect(evidence.recheckMessage).toContain("Run QC again");
  });

  it("asks for the first QC run when none exists", () => {
    expect(authorCheckerEvidence({
      isCurrent: false,
      state: "NOT_RUN",
      findings: [finding],
    }).recheckMessage).toContain("Run QC before");
  });
});

describe("author finding projection", () => {
  it("keeps paragraphKey with the paragraph-relative offsets", () => {
    expect(projectAuthorCheckerFinding({
      id: 4,
      token: "คำต่าง",
      disposition: "open",
      resolutionVersion: 1,
      sourceTabId: "tab-1",
      paragraphKey: "p-2",
      startOffset: 0,
      endOffset: 6,
    })).toMatchObject({
      paragraphKey: "p-2",
      startOffset: 0,
      endOffset: 6,
      sourceTabId: "tab-1",
    });
  });
});
