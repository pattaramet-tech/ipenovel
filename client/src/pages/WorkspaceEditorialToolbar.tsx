import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deriveEditorialPrimaryAction,
  type EditorialCheckerStateName,
} from "./workspaceEditorialActionState";

/**
 * IPE-058-F — compact sticky editor toolbar.
 *
 * ONE primary CTA derived from the canonical server state machine
 * (IPE-058-E) plus local dirty/saving editor state. Prev/Next chapter,
 * checker/QC status with actionable reason, unsaved indicator, issue count
 * and the Confirm/Stage progression live here so the user never hunts for
 * the next action. Low-level debug info (hashes/ids) is NOT shown here.
 */
export function WorkspaceEditorialToolbar({
  dirty,
  saving,
  checkerState,
  unresolvedCount,
  issueCount,
  hasDraft,
  approvalValid,
  readyToPublish,
  positionLabel,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
  onSaveCheck,
  onRunChecker,
  onConfirm,
  onStage,
  onGoToIssue,
  confirmDisabled,
  stageDisabled,
}: {
  dirty: boolean;
  saving: boolean;
  checkerState: EditorialCheckerStateName | null | undefined;
  unresolvedCount: number | null | undefined;
  issueCount: number;
  hasDraft: boolean;
  approvalValid: boolean | null | undefined;
  readyToPublish: boolean | null | undefined;
  positionLabel: string;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  onSaveCheck: () => void;
  onRunChecker: () => void;
  onConfirm: () => void;
  onStage: () => void;
  /** IPE-062R4E: makes the fix_findings CTA actionable — jumps to the
      current finding instead of sitting disabled. */
  onGoToIssue?: () => void;
  confirmDisabled: boolean;
  stageDisabled: boolean;
}): ReactNode {
  const action = deriveEditorialPrimaryAction({
    hasDraft,
    saving,
    dirty,
    checkerState,
    unresolvedCount,
    approvalValid,
    readyToPublish,
  });
  const onPrimary = () => {
    switch (action.kind) {
      case "save_check":
        onSaveCheck();
        return;
      case "run_checker":
        onRunChecker();
        return;
      case "fix_findings":
        onGoToIssue?.();
        return;
      case "confirm":
        onConfirm();
        return;
      case "stage":
        onStage();
        return;
      case "fix_findings":
      case "none":
      case "import":
      case "publish":
        return;
    }
  };
  const primaryDisabled =
    saving ||
    action.kind === "none" ||
    action.kind === "import" ||
    action.kind === "publish" ||
    // IPE-062R4E: fix_findings is actionable when the page supplies a jump
    // handler (goes to the current finding) — only disabled without one.
    (action.kind === "fix_findings" && !onGoToIssue) ||
    (action.kind === "confirm" && confirmDisabled) ||
    (action.kind === "stage" && stageDisabled);

  const checkerLabel =
    checkerState === "STALE"
      ? "checker stale"
      : checkerState === "ERROR"
        ? "checker error"
        : checkerState === "NOT_RUN"
          ? "ยังไม่ตรวจ"
          : checkerState === "RUNNING"
            ? "กำลังตรวจ"
            : checkerState === "CURRENT_HAS_FINDINGS"
              ? `findings ${unresolvedCount ?? 0}`
              : checkerState === "CURRENT_READY"
                ? "QC ผ่าน"
                : "—";

  return (
    <div
      data-testid="workspace-editorial-toolbar"
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2 py-2"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPrev}
        disabled={prevDisabled || saving}
      >
        ก่อนหน้า
      </Button>
      <span className="text-xs text-muted-foreground">{positionLabel}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onNext}
        disabled={nextDisabled || saving}
      >
        ถัดไป
      </Button>

      {dirty && (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs text-red-700">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          ยังไม่บันทึก
        </span>
      )}
      <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
        {checkerLabel}
        {issueCount > 0 ? ` · issue ${issueCount}` : ""}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{action.reason}</span>
        {action.kind !== "none" && action.kind !== "import" && (
          <Button
            type="button"
            size="sm"
            onClick={onPrimary}
            disabled={primaryDisabled}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {action.label}
          </Button>
        )}
      </span>
    </div>
  );
}
