// IPE-062 — compact pack list for the focused story (left pane of the
// multi-story work area). IPE-062R4D: expandable pack/chapter tree — each
// pack row can expand to its chapter navigation rows (metadata only, never
// an editing surface; the single active editor lives in the center).
// IPE-064R3: the selected pack auto-expands and a "แพ็กที่ต้องแก้ถัดไป"
// button jumps across packs in episode order.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { EditorialPackRowActionsMenu } from "./EditorialPackRowActionsMenu";
import {
  derivePackCardStatus,
  filterPacksByQuery,
  sortPacksByEpisode,
  STORY_PACK_STATUS_LABEL,
  type StoryEvidence,
  type StoryEvidenceState,
  type StoryPackStatus,
} from "./workspaceMultiStory";

const STATUS_BADGE_CLASS: Record<StoryPackStatus, string> = {
  published: "border-emerald-300 bg-emerald-50 text-emerald-700",
  passed: "border-teal-300 bg-teal-50 text-teal-700",
  needs_fix: "border-orange-300 bg-orange-50 text-orange-700",
  anomalous: "border-red-300 bg-red-50 text-red-700",
  not_checked: "border-slate-300 bg-slate-50 text-slate-600",
  // IPE-065: neutral states — visually quiet, never rendered like a pass.
  loading: "border-slate-300 bg-slate-50 text-slate-500 animate-pulse",
  unknown: "border-amber-300 bg-amber-50 text-amber-700",
};

const CHAPTER_STATE_LABEL: Record<string, string> = {
  passed: "ผ่าน",
  pending: "ต้องแก้",
  confirmed: "ยืนยันแล้ว",
  unchecked: "ยังไม่ตรวจ",
};

const CHAPTER_STATE_CLASS: Record<string, string> = {
  passed: "border-teal-200 bg-teal-50 text-teal-700",
  pending: "border-orange-200 bg-orange-50 text-orange-700",
  confirmed: "border-blue-200 bg-blue-50 text-blue-800",
  unchecked: "border-slate-200 bg-slate-50 text-slate-600",
};

export interface WorkspacePackChapterRow {
  sourceTabId: string;
  title: string;
  issueCount: number;
  foreignFindingCount: number;
  structuralIssueCount: number;
  progressState: "passed" | "pending" | "confirmed" | "unchecked";
  empty: boolean;
}

export interface WorkspacePackListCard {
  id?: number | string | null;
  workItemId?: number | null;
  workItemVersion?: number | null;
  workItemType?: string;
  episodeNumber?: string | null;
  episodeTitle?: string | null;
  note?: string | null;
  columnKey?: string;
  columnName?: string;
  isFree?: boolean | null;
  price?: string | number | null;
  evidence?: StoryEvidence | null;
  /** IPE-065: progressive-loading signal — absent row is loading/unknown, never not_checked. */
  evidenceState?: StoryEvidenceState;
}

interface WorkspacePackListPanelProps {
  storyTitle: string;
  packs: WorkspacePackListCard[];
  selectedWorkItemId: number | null | undefined;
  bulkSelectedWorkItemIds: Set<number>;
  bulkBusy?: boolean;
  /** IPE-064: master "เลือกทั้งหมด" checkbox over this story's packs. */
  allSelected?: boolean;
  onToggleAll?: () => void;
  /** IPE-064R3: next needs-fix pack (episode order) for the jump button. */
  nextNeedsFixPackId?: number | null;
  onJumpToPack?: (workItemId: number) => void;
  onSelectPack: (workItemId: number) => void;
  onToggleBulk: (workItemId: number) => void;
  onOpenEditor: (card: any) => void;
  onEditRange: (card: any, next: string) => void;
  onEditSale: (card: any, mode: "free" | "paid", price?: string) => void;
  onEditNote: (card: any, next: string) => void;
  onRemove: (card: any) => void;
  /** Chapter navigation rows for the SELECTED pack (metadata only). */
  chapters?: WorkspacePackChapterRow[];
  activeChapterTabId?: string | null;
  onSelectChapter?: (row: WorkspacePackChapterRow) => void;
  editRangePending?: boolean;
  editSalePending?: boolean;
  editNotePending?: boolean;
  removePending?: boolean;
}

export function WorkspacePackListPanel({
  storyTitle,
  packs,
  selectedWorkItemId,
  bulkSelectedWorkItemIds,
  bulkBusy,
  allSelected,
  onToggleAll,
  nextNeedsFixPackId,
  onJumpToPack,
  onSelectPack,
  onToggleBulk,
  onOpenEditor,
  onEditRange,
  onEditSale,
  onEditNote,
  onRemove,
  chapters,
  activeChapterTabId,
  onSelectChapter,
  editRangePending,
  editSalePending,
  editNotePending,
  removePending,
}: WorkspacePackListPanelProps) {
  const [query, setQuery] = useState("");
  // IPE-062R4D: transient expand/collapse per pack row. Expanding a
  // non-selected pack also selects it so its chapter tabs load; chapter
  // rows render ONLY for the pack whose tabs are loaded, and they carry
  // navigation metadata — never an editor surface.
  const [expandedPackIds, setExpandedPackIds] = useState<Set<string>>(new Set());
  const visiblePacks = useMemo(
    () => sortPacksByEpisode(filterPacksByQuery(packs, query)),
    [packs, query]
  );
  // IPE-064R3: the selected pack auto-expands so jump navigation (and any
  // pack switch) lands on its chapter rows immediately.
  const selectedRowKey = useMemo(() => {
    const selected = packs.find(
      (card) => card.workItemId != null && card.workItemId === selectedWorkItemId
    );
    return selected ? String(selected.id ?? selected.workItemId ?? "pack") : null;
  }, [packs, selectedWorkItemId]);
  useEffect(() => {
    if (!selectedRowKey) return;
    setExpandedPackIds((current) =>
      current.has(selectedRowKey) ? current : new Set(current).add(selectedRowKey)
    );
  }, [selectedRowKey]);

  return (
    <Card className="space-y-2 p-3" data-testid="workspace-pack-list-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">แพ็กของเรื่อง</div>
          <div className="truncate text-sm font-semibold" title={storyTitle}>
            {storyTitle}
          </div>
        </div>
        <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
          {visiblePacks.length}/{packs.length} แพ็ก
        </span>
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ค้นหาช่วงตอน / ชื่อตอน / หมายเหตุ"
        aria-label="ค้นหาแพ็กในเรื่องนี้"
        className="h-8 text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-medium" data-testid="workspace-pack-select-all-row">
          <input
            type="checkbox"
            aria-label="เลือกทั้งหมด (ทุกแพ็กในเรื่องนี้)"
            data-testid="workspace-pack-select-all"
            checked={Boolean(allSelected)}
            disabled={bulkBusy || !packs.length}
            onChange={() => onToggleAll?.()}
          />
          เลือกทั้งหมด
        </label>
        {onJumpToPack ? (
          <button
            type="button"
            data-testid="workspace-next-needs-fix-pack"
            className="rounded border px-2 py-1 text-xs font-medium text-orange-800 hover:bg-orange-50 disabled:opacity-50"
            disabled={nextNeedsFixPackId == null}
            title="ไปยังแพ็กที่ต้องแก้ถัดไป (เรียงตามเลขตอน)"
            onClick={() => nextNeedsFixPackId != null && onJumpToPack(nextNeedsFixPackId)}
          >
            แพ็กที่ต้องแก้ถัดไป ›
          </button>
        ) : null}
      </div>
      <div className="max-h-[28rem] space-y-1 overflow-auto pr-1" data-testid="workspace-pack-list">
        {visiblePacks.length ? (
          visiblePacks.map((card) => {
            // IPE-065: card-level derivation — a loaded row maps exactly as
            // before; a missing row is loading/unknown, never a checked state.
            const status = derivePackCardStatus(card);
            const workItemId = card.workItemId ?? null;
            const selected = workItemId != null && workItemId === selectedWorkItemId;
            const rowKey = String(card.id ?? card.workItemId ?? "pack");
            const expanded = expandedPackIds.has(rowKey);
            const showChapters = expanded && selected && workItemId != null && !!chapters?.length;
            return (
              <div
                key={rowKey}
                data-testid="workspace-pack-row"
                data-selected={selected ? "true" : undefined}
                data-expanded={expanded ? "true" : undefined}
                className={`rounded-md border p-2 ${selected ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "hover:bg-muted/20"}`}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`เลือก Episode Pack ${card.episodeNumber || workItemId}`}
                    checked={workItemId != null && bulkSelectedWorkItemIds.has(workItemId)}
                    disabled={!workItemId || bulkBusy}
                    onChange={() => workItemId != null && onToggleBulk(workItemId)}
                    className="mt-0.5"
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    disabled={!workItemId}
                    onClick={() => workItemId != null && onSelectPack(workItemId)}
                    title="คลิกเพื่อเปิด Episode Pack Detail"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-primary hover:underline">
                        {card.workItemType === "NEW_EPISODE"
                          ? card.episodeNumber || "ตอนใหม่"
                          : "เรื่องใหม่ / Draft แรก"}
                      </span>
                      <span
                        data-testid="workspace-pack-status"
                        className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE_CLASS[status]}`}
                      >
                        {STORY_PACK_STATUS_LABEL[status]}
                      </span>
                    </div>
                    {card.episodeTitle ? (
                      <div className="truncate text-xs text-muted-foreground" title={card.episodeTitle}>
                        {card.episodeTitle}
                      </div>
                    ) : null}
                    {card.note ? (
                      <div className="truncate text-[11px] text-muted-foreground/80" title={card.note}>
                        📝 {card.note}
                      </div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={expanded ? "ย่อรายการบท" : "แสดงรายการบท"}
                    aria-expanded={expanded}
                    data-testid="workspace-pack-expand"
                    className="rounded border px-1.5 py-1 text-muted-foreground hover:bg-muted/30"
                    disabled={!workItemId}
                    onClick={() => {
                      setExpandedPackIds((current) => {
                        const next = new Set(current);
                        if (next.has(rowKey)) next.delete(rowKey);
                        else next.add(rowKey);
                        return next;
                      });
                      // Chapter tabs load only for the selected pack —
                      // expanding a non-selected pack selects it first.
                      if (!selected && workItemId != null) onSelectPack(workItemId);
                    }}
                  >
                    {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  <EditorialPackRowActionsMenu
                    card={card}
                    onOpenEditor={onOpenEditor}
                    onEditRange={onEditRange}
                    onEditSale={onEditSale}
                    onEditNote={onEditNote}
                    onRemove={onRemove}
                    editRangePending={editRangePending}
                    editSalePending={editSalePending}
                    editNotePending={editNotePending}
                    removePending={removePending}
                  />
                </div>
                {expanded ? (
                  showChapters ? (
                    <div className="mt-1 space-y-0.5 border-t pt-1" data-testid="workspace-pack-chapters">
                      {(chapters ?? []).map((chapter) => {
                        const active = chapter.sourceTabId === activeChapterTabId;
                        return (
                          <button
                            key={chapter.sourceTabId}
                            type="button"
                            data-testid="workspace-chapter-row"
                            data-active={active ? "true" : undefined}
                            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs ${active ? "bg-primary/10 font-medium" : "hover:bg-muted/30"}`}
                            onClick={() => onSelectChapter?.(chapter)}
                            title="คลิกเพื่อเปิดบทนี้ใน Editor"
                          >
                            <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                            {chapter.empty ? (
                              <span className="inline-flex shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
                                เติมเนื้อหา
                              </span>
                            ) : null}
                            {chapter.foreignFindingCount > 0 ? (
                              <span className="inline-flex shrink-0 rounded-full border border-yellow-200 bg-yellow-50 px-1.5 py-0.5 text-[10px] text-yellow-900">
                                คำต่างประเทศ {chapter.foreignFindingCount}
                              </span>
                            ) : null}
                            {chapter.structuralIssueCount > 0 ? (
                              <span className="inline-flex shrink-0 rounded-full border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] text-orange-900">
                                structural {chapter.structuralIssueCount}
                              </span>
                            ) : null}
                            <span
                              className={`inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${CHAPTER_STATE_CLASS[chapter.progressState]}`}
                            >
                              {CHAPTER_STATE_LABEL[chapter.progressState]}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-1 border-t pt-1 text-[11px] text-muted-foreground" data-testid="workspace-pack-chapters-empty">
                      {selected
                        ? "ยังไม่มีรายการบท — ต้องมี Draft ก่อน"
                        : "กำลังโหลดรายการบทของแพ็กนี้…"}
                    </div>
                  )
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {packs.length ? "ไม่มีแพ็กที่ตรงกับการค้นหา" : "เรื่องนี้ยังไม่มีแพ็ก — เพิ่มผ่านเครื่องมือนำเข้า"}
          </div>
        )}
      </div>
    </Card>
  );
}
