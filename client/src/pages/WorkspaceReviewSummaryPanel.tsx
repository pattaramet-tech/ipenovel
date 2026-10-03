// IPE-062 — compact review summary (right pane). Shows the selected pack's
// per-chapter check progress as four operator counters, an issues-only toggle
// that drives the chapter list filter, and collapsed per-chapter issue groups
// with jump buttons. Long finding lists stay collapsed by default.
import { Card } from "@/components/ui/card";

export interface ReviewChapterStatus {
  sourceTabId: string;
  title: string;
  issueCount: number;
  progressState: "passed" | "pending" | "confirmed" | "unchecked";
}

interface WorkspaceReviewSummaryPanelProps {
  packLabel: string;
  chapters: ReviewChapterStatus[];
  /** Structural anomalies from the current checker evidence. */
  anomalyCount: number;
  issuesOnly: boolean;
  onToggleIssuesOnly: () => void;
  onJumpToChapter: (sourceTabId: string) => void;
  checkerCurrent: boolean;
  checkerStale: boolean;
  notRun: boolean;
}

export function WorkspaceReviewSummaryPanel({
  packLabel,
  chapters,
  anomalyCount,
  issuesOnly,
  onToggleIssuesOnly,
  onJumpToChapter,
  checkerCurrent,
  checkerStale,
  notRun,
}: WorkspaceReviewSummaryPanelProps) {
  const passed = chapters.filter((chapter) => chapter.progressState === "passed" || chapter.progressState === "confirmed").length;
  const needsFix = chapters.filter((chapter) => chapter.progressState === "pending").length;
  const anomalous = anomalyCount;
  const outstanding = chapters.filter((chapter) => chapter.progressState === "unchecked").length;
  const issueChapters = chapters.filter((chapter) => chapter.issueCount > 0);
  const visibleChapters = issuesOnly ? issueChapters : chapters;

  return (
    <Card className="space-y-3 p-3" data-testid="workspace-review-summary">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">สรุปผลตรวจ</div>
          <div className="truncate text-sm font-semibold" title={packLabel}>
            {packLabel}
          </div>
        </div>
        {checkerCurrent && !notRun ? (
          <span className="rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700">
            ผลตรวจ current
          </span>
        ) : checkerStale ? (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            ผลตรวจเก่า
          </span>
        ) : (
          <span className="rounded-full border bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">ยังไม่ตรวจ</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2" data-testid="workspace-review-counters">
        <div className="rounded-md border bg-teal-50/60 p-2 text-center">
          <div className="text-lg font-semibold text-teal-700">{passed}</div>
          <div className="text-[11px] text-muted-foreground">ผ่าน</div>
        </div>
        <div className="rounded-md border bg-orange-50/60 p-2 text-center">
          <div className="text-lg font-semibold text-orange-700">{needsFix}</div>
          <div className="text-[11px] text-muted-foreground">ต้องแก้</div>
        </div>
        <div className="rounded-md border bg-red-50/60 p-2 text-center">
          <div className="text-lg font-semibold text-red-700">{anomalous}</div>
          <div className="text-[11px] text-muted-foreground">ผิดปกติ</div>
        </div>
        <div className="rounded-md border bg-slate-50 p-2 text-center">
          <div className="text-lg font-semibold text-slate-600">{outstanding}</div>
          <div className="text-[11px] text-muted-foreground">ค้างแก้</div>
        </div>
      </div>

      <label className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-sm" data-testid="workspace-review-issues-toggle">
        <span>แสดงเฉพาะที่มีปัญหา</span>
        <input
          type="checkbox"
          checked={issuesOnly}
          onChange={onToggleIssuesOnly}
          className="h-4 w-4"
          aria-label="แสดงเฉพาะบทที่มีปัญหา"
        />
      </label>

      <details className="rounded-md border bg-background" data-testid="workspace-review-issues">
        <summary className="cursor-pointer select-none px-2 py-1.5 text-sm">
          บทที่มีปัญหา ({issueChapters.length})
        </summary>
        <div className="max-h-56 space-y-1 overflow-auto border-t p-2">
          {visibleChapters.length ? (
            visibleChapters.map((chapter) => (
              <div
                key={chapter.sourceTabId}
                data-testid="workspace-review-issue-row"
                className="flex items-center justify-between gap-2 rounded border p-1.5 text-xs"
              >
                <span className="min-w-0 truncate" title={chapter.title}>
                  {chapter.title}
                </span>
                <span
                  className={`inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    chapter.issueCount > 0
                      ? "bg-orange-100 text-orange-900"
                      : chapter.progressState === "unchecked"
                        ? "bg-muted text-muted-foreground"
                        : "bg-emerald-100 text-emerald-800"
                  }`}
                >
                  {chapter.issueCount > 0
                    ? `ต้องแก้ ${chapter.issueCount}`
                    : chapter.progressState === "unchecked"
                      ? "ยังไม่ตรวจ"
                      : "ผ่าน"}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded border px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/5"
                  onClick={() => onJumpToChapter(chapter.sourceTabId)}
                >
                  แก้
                </button>
              </div>
            ))
          ) : (
            <div className="p-2 text-center text-xs text-muted-foreground">
              {issuesOnly ? "ไม่มีบทที่มีปัญหา — ผ่านทั้งแพ็ก" : "ยังไม่มีข้อมูลตอน"}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}
