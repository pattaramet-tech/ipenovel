/**
 * IPE-058-F — Actionable Stage diagnostics.
 *
 * Groups Stage blockers by ROOT CAUSE (stable code buckets) with an affected
 * count, affected tabs/episodes, and a direct repair action — so the user
 * never has to read raw backend error prose. Inputs come from the IPE-058-B
 * reconciliation / anomalies (durable read model) and the IPE-058-E canonical
 * checker state; this module only presents, it never decides readiness.
 */

export type StageDiagnosticCode =
  | "CHECKER_STALE"
  | "QC_NOT_READY"
  | "APPROVAL_STALE"
  | "METADATA_MISSING"
  | "EPISODE_RANGE_INVALID"
  | "SOURCE_DRIFT"
  | "OWNERSHIP_MISMATCH";

export type StageDiagnosticAction =
  | { kind: "run_checker" }
  | { kind: "open_editor"; sourceTabId?: string }
  | { kind: "confirm_draft" }
  | { kind: "fix_metadata"; sourceTabId?: string }
  | { kind: "review_stage" };

export type StageDiagnosticGroup = {
  code: StageDiagnosticCode;
  /** Thai human-readable reason. */
  label: string;
  /** Thai actionable next step. */
  reason: string;
  /** Number of affected blockers/episodes/tabs in this group. */
  affectedCount: number;
  /** Affected tab titles / episode numbers (bounded display strings). */
  affected: string[];
  /** Direct repair action for the primary button of the group. */
  action: StageDiagnosticAction;
};

type StageAnomaly = {
  code?: string;
  severity?: string;
  message?: string;
  sourceTabId?: string;
  sourceTabTitle?: string;
  episodeNumber?: string;
};

const ANOMALY_CODE_TO_GROUP: Record<string, StageDiagnosticCode> = {
  TAB_NUMBER_MISSING: "METADATA_MISSING",
  RANGE_USED_AS_CHAPTER_IDENTITY: "METADATA_MISSING",
  TAB_NUMBER_CONFLICT: "METADATA_MISSING",
  TAB_NUMBER_OUT_OF_RANGE: "EPISODE_RANGE_INVALID",
  TAB_NUMBER_DUPLICATE: "EPISODE_RANGE_INVALID",
  EXPECTED_EPISODE_MISSING: "EPISODE_RANGE_INVALID",
  COUNT_MISMATCH: "EPISODE_RANGE_INVALID",
  TAB_EMPTY: "SOURCE_DRIFT",
  TAB_CONTENT_INVALID: "SOURCE_DRIFT",
};

function labelForCode(code: StageDiagnosticCode) {
  switch (code) {
    case "CHECKER_STALE":
      return "Checker stale";
    case "QC_NOT_READY":
      return "QC ยังไม่ผ่าน";
    case "APPROVAL_STALE":
      return "Approval เก่า";
    case "METADATA_MISSING":
      return "Chapter metadata อ่านไม่ได้";
    case "EPISODE_RANGE_INVALID":
      return "ช่วงตอนไม่ครบ/ซ้ำ/เกิน";
    case "SOURCE_DRIFT":
      return "เนื้อหาแท็บมีปัญหา";
    case "OWNERSHIP_MISMATCH":
      return "Episode ownership ไม่ตรง";
  }
}

function reasonForCode(code: StageDiagnosticCode) {
  switch (code) {
    case "CHECKER_STALE":
      return "เนื้อหาถูกแก้หลังตรวจครั้งล่าสุด — Run Checker ใหม่";
    case "QC_NOT_READY":
      return "มี findings ที่ยังไม่ resolve — แก้หรือยอมรับใน Issue drawer";
    case "APPROVAL_STALE":
      return "Approval เป็นของ Draft ก่อนหน้า — ตรวจและ Confirm ใหม่";
    case "METADATA_MISSING":
      return "อ่านเลขตอนจากหัวบทไม่ได้ — แก้หัวบท/เลขตอนใน Editor";
    case "EPISODE_RANGE_INVALID":
      return "ตอนที่หาย/ซ้ำ/นอกช่วง — แก้ตามรายการใน reconciliation";
    case "SOURCE_DRIFT":
      return "แท็บบางแท็บไม่มีเนื้อหาที่ stage ได้ — เปิด Editor เพื่อซ่อม";
    case "OWNERSHIP_MISMATCH":
      return "Episode ถูก Stage โดย work item อื่น — ตรวจ ownership ก่อน";
  }
}

function actionForCode(
  code: StageDiagnosticCode,
  sourceTabId?: string
): StageDiagnosticAction {
  switch (code) {
    case "CHECKER_STALE":
    case "QC_NOT_READY":
      return { kind: "run_checker" };
    case "APPROVAL_STALE":
      return { kind: "confirm_draft" };
    case "METADATA_MISSING":
      return { kind: "fix_metadata", sourceTabId };
    default:
      return { kind: "open_editor", sourceTabId };
  }
}

function affectedLabel(
  anomaly: StageAnomaly,
  tabTitleById: Map<string, string>
) {
  if (anomaly.episodeNumber) return `ตอน ${anomaly.episodeNumber}`;
  if (anomaly.sourceTabTitle) return anomaly.sourceTabTitle;
  if (anomaly.sourceTabId) {
    return tabTitleById.get(anomaly.sourceTabId) ?? anomaly.sourceTabId;
  }
  return anomaly.message?.slice(0, 60) ?? "";
}

/**
 * Build root-cause-grouped Stage diagnostics.
 */
export function groupStageDiagnostics(input: {
  /** Canonical checker state from IPE-058-E. */
  checkerState:
    | "NOT_RUN"
    | "RUNNING"
    | "STALE"
    | "ERROR"
    | "CURRENT_HAS_FINDINGS"
    | "CURRENT_READY"
    | null
    | undefined;
  unresolvedCount: number | null | undefined;
  /** Approval status reason from the read model (e.g. DRAFT_CHANGED). */
  approvalStatusReason: string | null | undefined;
  approvalValid: boolean | null | undefined;
  /** stagePlan.anomalies (IPE-058-B blockers/warnings). */
  anomalies: readonly StageAnomaly[];
  /** Optional tab-title lookup for affected labels. */
  tabTitleById?: Record<string, string>;
}): StageDiagnosticGroup[] {
  const groups = new Map<StageDiagnosticCode, StageDiagnosticGroup>();
  const tabTitleById = new Map(Object.entries(input.tabTitleById ?? {}));
  const push = (group: StageDiagnosticGroup) => {
    const existing = groups.get(group.code);
    if (existing) {
      existing.affectedCount += group.affectedCount;
      existing.affected.push(...group.affected);
      return;
    }
    groups.set(group.code, { ...group, affected: [...group.affected] });
  };

  // State-machine-level blockers (IPE-058-E authority).
  if (input.checkerState === "STALE" || input.checkerState === "ERROR") {
    push({
      code: "CHECKER_STALE",
      label: labelForCode("CHECKER_STALE"),
      reason: reasonForCode("CHECKER_STALE"),
      affectedCount: 1,
      affected: [],
      action: { kind: "run_checker" },
    });
  } else if (input.checkerState === "CURRENT_HAS_FINDINGS") {
    const count = input.unresolvedCount ?? 0;
    push({
      code: "QC_NOT_READY",
      label: labelForCode("QC_NOT_READY"),
      reason: `มี ${count} findings ที่ยังไม่ resolve — แก้หรือยอมรับใน Issue drawer`,
      affectedCount: count,
      affected: [],
      action: { kind: "run_checker" },
    });
  } else if (input.checkerState === "NOT_RUN") {
    push({
      code: "CHECKER_STALE",
      label: labelForCode("CHECKER_STALE"),
      reason: "ยังไม่ได้ตรวจ Draft นี้ — Run Checker ก่อน Stage",
      affectedCount: 1,
      affected: [],
      action: { kind: "run_checker" },
    });
  }
  if (input.approvalValid === false && input.approvalStatusReason) {
    const code: StageDiagnosticCode =
      input.approvalStatusReason === "DRAFT_CHANGED" ||
      input.approvalStatusReason === "QC_CHANGED"
        ? "APPROVAL_STALE"
        : "APPROVAL_STALE";
    push({
      code,
      label: labelForCode("APPROVAL_STALE"),
      reason: reasonForCode("APPROVAL_STALE"),
      affectedCount: 1,
      affected: [input.approvalStatusReason],
      action: actionForCode(code),
    });
  }

  // Per-tab/per-episode blockers from the IPE-058-B plan.
  for (const anomaly of input.anomalies) {
    if (anomaly.severity !== "blocker") continue;
    const mapped = anomaly.code
      ? ANOMALY_CODE_TO_GROUP[anomaly.code]
      : undefined;
    if (!mapped) continue;
    push({
      code: mapped,
      label: labelForCode(mapped),
      reason: reasonForCode(mapped),
      affectedCount: 1,
      affected: [affectedLabel(anomaly, tabTitleById)].filter(Boolean),
      action: actionForCode(mapped, anomaly.sourceTabId),
    });
  }

  return Array.from(groups.values());
}
