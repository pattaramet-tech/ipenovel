import { describe, expect, it } from "vitest";
import { groupStageDiagnostics } from "./workspaceStageDiagnostics";

describe("IPE-058-F Stage diagnostics grouping", () => {
  it("groups stale checker as CHECKER_STALE with Run Checker action", () => {
    const groups = groupStageDiagnostics({
      checkerState: "STALE",
      unresolvedCount: 0,
      approvalStatusReason: null,
      approvalValid: false,
      anomalies: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      code: "CHECKER_STALE",
      action: { kind: "run_checker" },
    });
    expect(groups[0].reason).toContain("Run Checker ใหม่");
  });

  it("groups unresolved findings as QC_NOT_READY with affected count", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_HAS_FINDINGS",
      unresolvedCount: 3,
      approvalStatusReason: null,
      approvalValid: false,
      anomalies: [],
    });
    expect(groups[0]).toMatchObject({
      code: "QC_NOT_READY",
      affectedCount: 3,
      action: { kind: "run_checker" },
    });
    expect(groups[0].reason).toContain("3 findings");
  });

  it("groups DRAFT_CHANGED approval as APPROVAL_STALE with Confirm action", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_READY",
      unresolvedCount: 0,
      approvalStatusReason: "DRAFT_CHANGED",
      approvalValid: false,
      anomalies: [],
    });
    expect(groups[0]).toMatchObject({
      code: "APPROVAL_STALE",
      action: { kind: "confirm_draft" },
    });
    expect(groups[0].reason).toContain("Confirm ใหม่");
  });

  it("groups per-tab metadata blockers with affected tab and repair target", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_READY",
      unresolvedCount: 0,
      approvalStatusReason: null,
      approvalValid: true,
      anomalies: [
        {
          code: "TAB_NUMBER_MISSING",
          severity: "blocker",
          sourceTabId: "tab-9",
          sourceTabTitle: "ตอนที่ 9",
        },
        {
          code: "RANGE_USED_AS_CHAPTER_IDENTITY",
          severity: "blocker",
          sourceTabId: "tab-range",
          sourceTabTitle: "ช่วงพิเศษ",
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe("METADATA_MISSING");
    expect(groups[0].affectedCount).toBe(2);
    expect(groups[0].affected).toEqual(["ตอนที่ 9", "ช่วงพิเศษ"]);
    expect(groups[0].action).toEqual({
      kind: "fix_metadata",
      sourceTabId: "tab-9",
    });
  });

  it("groups range reconciliation blockers as EPISODE_RANGE_INVALID", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_READY",
      unresolvedCount: 0,
      approvalStatusReason: null,
      approvalValid: true,
      anomalies: [
        { code: "EXPECTED_EPISODE_MISSING", severity: "blocker", episodeNumber: "104" },
        { code: "TAB_NUMBER_DUPLICATE", severity: "blocker", episodeNumber: "103" },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe("EPISODE_RANGE_INVALID");
    expect(groups[0].affectedCount).toBe(2);
    expect(groups[0].affected).toEqual(["ตอน 104", "ตอน 103"]);
  });

  it("groups empty/invalid tabs as SOURCE_DRIFT with open-editor action", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_READY",
      unresolvedCount: 0,
      approvalStatusReason: null,
      approvalValid: true,
      anomalies: [
        {
          code: "TAB_EMPTY",
          severity: "blocker",
          sourceTabId: "tab-empty",
          sourceTabTitle: "แท็บว่าง",
        },
      ],
    });
    expect(groups[0].code).toBe("SOURCE_DRIFT");
    expect(groups[0].action).toEqual({
      kind: "open_editor",
      sourceTabId: "tab-empty",
    });
  });

  it("never reports groups when everything is ready", () => {
    const groups = groupStageDiagnostics({
      checkerState: "CURRENT_READY",
      unresolvedCount: 0,
      approvalStatusReason: null,
      approvalValid: true,
      anomalies: [
        { code: "TAB_CONTENT_SHORT", severity: "warning", message: "สั้น" },
      ],
    });
    expect(groups).toEqual([]);
  });
});
