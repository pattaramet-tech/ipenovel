// IPE-064 — right-pane finding workflow card. The full issue queue,
// Full Checker preview and Safe Transform preview cards were retired; what
// remains is the single finding the operator is standing on: go to issue,
// skip (ignore), allow the word, confirm an author source note, and save
// the draft. The canvas in the center stays the only editing surface.
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

export interface WorkspaceFindingIssueInfo {
  kind: "finding" | "structural";
  // finding
  token?: string;
  ruleKey?: string;
  sentenceText?: string;
  paragraphOrder?: number;
  disposition?: string;
  // structural
  anomalyType?: string;
  message?: string;
  severity?: string;
  guidance?: string;
  confirmedSourceNote?: boolean;
}

export interface WorkspaceRelatedTab {
  sourceTabId: string;
  title: string;
}

interface WorkspaceFindingActionsProps {
  active: boolean;
  issueCount: number;
  findingsCount: number;
  structuralCount: number;
  index: number;
  currentIssue: WorkspaceFindingIssueInfo | null;
  relatedTabs: WorkspaceRelatedTab[];
  checkerStale: boolean;
  /** True while the automatic full recheck (draft save / allowlist change) is in flight. */
  rechecking: boolean;
  canIgnore: boolean;
  canAllow: boolean;
  canConfirmSourceNote: boolean;
  /** IPE-064R4B R32 (P2): an ignored/fixed finding can be reopened. */
  canReopen: boolean;
  ignorePending: boolean;
  allowPending: boolean;
  confirmNotePending: boolean;
  unallowPending: boolean;
  reopenPending: boolean;
  dirty: boolean;
  savePending: boolean;
  allowWords: Array<{ id: number; displayWord: string; normalizedWord: string }>;
  onPrev: () => void;
  onNext: () => void;
  onIgnore: () => void;
  onAllow: () => void;
  onReopen: () => void;
  onUnallow: (word: { normalizedWord: string }) => void;
  onToggleConfirmSourceNote: () => void;
  onOpenRelatedTab: (tab: WorkspaceRelatedTab) => void;
  onSave: () => void;
}

export function WorkspaceFindingActions({
  active,
  issueCount,
  findingsCount,
  structuralCount,
  index,
  currentIssue,
  relatedTabs,
  checkerStale,
  rechecking,
  canIgnore,
  canAllow,
  canConfirmSourceNote,
  canReopen,
  ignorePending,
  allowPending,
  confirmNotePending,
  unallowPending,
  reopenPending,
  dirty,
  savePending,
  allowWords,
  onPrev,
  onNext,
  onIgnore,
  onAllow,
  onReopen,
  onUnallow,
  onToggleConfirmSourceNote,
  onOpenRelatedTab,
  onSave,
}: WorkspaceFindingActionsProps) {
  const position = issueCount > 0 ? `${Math.min(index + 1, issueCount)}/${issueCount}` : "0";
  return (
    <Card className="space-y-3 p-3" data-testid="workspace-finding-actions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">จุดที่ต้องแก้ ({issueCount})</div>
          <div className="text-xs text-muted-foreground">
            คำต่างประเทศ {findingsCount} · structural {structuralCount}
            {rechecking ? " · กำลังตรวจซ้ำ…" : checkerStale ? " · ผลตรวจเก่า — ตรวจซ้ำก่อน" : ""}
          </div>
        </div>
        <span className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground">
          {position}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="workspace-finding-prev"
          disabled={!active || !issueCount || index <= 0}
          onClick={onPrev}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          จุดก่อนหน้า
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="workspace-finding-next"
          disabled={!active || !issueCount || index >= issueCount - 1}
          onClick={onNext}
        >
          ไปจุดต้องแก้ไข
          <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>

      {active && currentIssue ? (
        <div className="space-y-2 rounded-md border bg-muted/20 p-2">
          {currentIssue.kind === "finding" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{currentIssue.token}</span>
                <span className="text-xs text-muted-foreground">
                  {currentIssue.ruleKey} · ย่อหน้า {currentIssue.paragraphOrder}
                </span>
              </div>
              {currentIssue.sentenceText ? (
                <div className="rounded bg-background p-2 text-xs leading-6">
                  {currentIssue.sentenceText}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="workspace-finding-ignore"
                  disabled={!canIgnore || ignorePending || reopenPending}
                  onClick={onIgnore}
                >
                  {ignorePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  ข้าม
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="workspace-finding-allow"
                  disabled={!canAllow || allowPending || reopenPending}
                  onClick={onAllow}
                >
                  {allowPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  เพิ่มอนุญาต
                </Button>
                {/* IPE-064R4B R32 (P2): undo path — an accidentally skipped
                    (ignored) or resolved-fixed finding carries a reversible
                    disposition that survives checker reruns; reopen it via
                    the existing resolve mutation with disposition "open". */}
                {canReopen ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="workspace-finding-reopen"
                    disabled={reopenPending || ignorePending || allowPending}
                    onClick={onReopen}
                  >
                    {reopenPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    คืนสถานะ
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Structural · {currentIssue.anomalyType}</span>
                <span
                  className={
                    currentIssue.severity === "error"
                      ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800"
                      : "rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-900"
                  }
                >
                  {currentIssue.severity}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{currentIssue.message}</div>
              {currentIssue.guidance ? (
                <div className="rounded bg-background p-2 text-xs text-muted-foreground">
                  {currentIssue.guidance}
                </div>
              ) : null}
              {currentIssue.confirmedSourceNote ? (
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                  confirmed source note
                </span>
              ) : null}
              {canConfirmSourceNote ? (
                <Button
                  type="button"
                  size="sm"
                  variant={currentIssue.confirmedSourceNote ? "outline" : "default"}
                  data-testid="workspace-finding-confirm-note"
                  disabled={confirmNotePending || checkerStale}
                  onClick={onToggleConfirmSourceNote}
                >
                  {confirmNotePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {currentIssue.confirmedSourceNote
                    ? "ยกเลิกยืนยันหมายเหตุจากผู้เขียน"
                    : "ยืนยันหมายเหตุจากผู้เขียน"}
                </Button>
              ) : null}
              {relatedTabs.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {relatedTabs.map((tab) => (
                    <Button
                      key={tab.sourceTabId}
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenRelatedTab(tab)}
                    >
                      เปิดแท็บ {tab.title}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {active ? "ไม่มีจุดที่ต้องแก้ในบทนี้" : "เลือกตอนจากรายการด้านซ้ายเพื่อดูจุดที่ต้องแก้"}
        </div>
      )}

      {allowWords.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {allowWords.map((word) => (
            <button
              key={word.id}
              type="button"
              className="rounded-full border px-2 py-1 text-xs"
              disabled={unallowPending}
              onClick={() => onUnallow(word)}
              title="กดเพื่อถอนคำที่อนุญาต"
            >
              อนุญาต: {word.displayWord} ×
            </button>
          ))}
        </div>
      ) : null}

      <Button
        type="button"
        className="w-full"
        data-testid="workspace-finding-save-draft"
        disabled={!active || !dirty || savePending}
        onClick={onSave}
      >
        {savePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        บันทึก Draft
      </Button>
    </Card>
  );
}
