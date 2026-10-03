// IPE-062 — compact pack list for the focused story (left pane of the
// multi-story work area). Replaces the full table as the daily surface:
// search, status badge per pack, bulk checkbox, and the shared actions menu.
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { EditorialPackRowActionsMenu } from "./EditorialPackRowActionsMenu";
import {
  derivePackStatus,
  filterPacksByQuery,
  sortPacksByEpisode,
  STORY_PACK_STATUS_LABEL,
  type StoryEvidence,
  type StoryPackStatus,
} from "./workspaceMultiStory";

const STATUS_BADGE_CLASS: Record<StoryPackStatus, string> = {
  published: "border-emerald-300 bg-emerald-50 text-emerald-700",
  passed: "border-teal-300 bg-teal-50 text-teal-700",
  needs_fix: "border-orange-300 bg-orange-50 text-orange-700",
  anomalous: "border-red-300 bg-red-50 text-red-700",
  not_checked: "border-slate-300 bg-slate-50 text-slate-600",
};

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
}

interface WorkspacePackListPanelProps {
  storyTitle: string;
  packs: WorkspacePackListCard[];
  selectedWorkItemId: number | null | undefined;
  bulkSelectedWorkItemIds: Set<number>;
  bulkBusy?: boolean;
  onSelectPack: (workItemId: number) => void;
  onToggleBulk: (workItemId: number) => void;
  onOpenEditor: (card: any) => void;
  onEditRange: (card: any, next: string) => void;
  onEditSale: (card: any, mode: "free" | "paid", price?: string) => void;
  onEditNote: (card: any, next: string) => void;
  onRemove: (card: any) => void;
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
  onSelectPack,
  onToggleBulk,
  onOpenEditor,
  onEditRange,
  onEditSale,
  onEditNote,
  onRemove,
  editRangePending,
  editSalePending,
  editNotePending,
  removePending,
}: WorkspacePackListPanelProps) {
  const [query, setQuery] = useState("");
  const visiblePacks = useMemo(
    () => sortPacksByEpisode(filterPacksByQuery(packs, query)),
    [packs, query]
  );

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
      <div className="max-h-[28rem] space-y-1 overflow-auto pr-1" data-testid="workspace-pack-list">
        {visiblePacks.length ? (
          visiblePacks.map((card) => {
            const status = derivePackStatus(card.evidence);
            const workItemId = card.workItemId ?? null;
            const selected = workItemId != null && workItemId === selectedWorkItemId;
            return (
              <div
                key={String(card.id ?? card.workItemId ?? "pack")}
                data-testid="workspace-pack-row"
                data-selected={selected ? "true" : undefined}
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
