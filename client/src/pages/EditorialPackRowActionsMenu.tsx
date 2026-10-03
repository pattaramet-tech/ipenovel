// IPE-062 — the single overflow actions menu for an Episode Pack row.
// Extracted verbatim from the pack table (IPE-060) so the pack list panel and
// the full management table share one implementation of the guards:
// - เปิด Editor / แก้ไขช่วงตอน / แก้การขาย / นำออก keep their exact enabling
//   conditions (pre-Draft sale guard, workItemId null guards).

export interface EditorialPackCardLike {
  workItemId?: number | null;
  workItemVersion?: number | null;
  episodeNumber?: string | null;
  episodeTitle?: string | null;
  note?: string | null;
  columnKey?: string;
  isFree?: boolean | null;
  price?: string | number | null;
  evidence?: {
    stage?: boolean;
    published?: boolean;
    publishedSource?: string;
  } | null;
}

interface EditorialPackRowActionsMenuProps {
  card: EditorialPackCardLike;
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

export function EditorialPackRowActionsMenu({
  card,
  onOpenEditor,
  onEditRange,
  onEditSale,
  onEditNote,
  onRemove,
  editRangePending,
  editSalePending,
  editNotePending,
  removePending,
}: EditorialPackRowActionsMenuProps) {
  return (
    <details className="relative mt-1 inline-block text-left" data-testid="editorial-row-actions">
      <summary
        className="cursor-pointer list-none rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30"
        aria-label="การกระทำเพิ่มเติมของ Episode Pack"
      >
        ⋯
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border bg-background p-1 shadow-lg">
        <button
          type="button"
          className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/30"
          disabled={!card.workItemId}
          onClick={() => onOpenEditor(card)}
        >
          เปิด Editor (ตอนถัดไปที่มีปัญหา)
        </button>
        {card.columnKey === "new" && card.workItemId ? (
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/30"
            disabled={editRangePending}
            onClick={() => {
              const next = window.prompt("แก้ช่วงตอน", card.episodeNumber || "");
              if (next && next.trim() && next.trim() !== String(card.episodeNumber || "").trim()) {
                onEditRange(card, next.trim());
              }
            }}
          >
            แก้ไขช่วงตอน
          </button>
        ) : null}
        {card.workItemId &&
        !card.evidence?.stage &&
        (!card.evidence?.published || card.evidence?.publishedSource === "published_episode") ? (
          <button
            type="button"
            className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/30"
            disabled={editSalePending}
            onClick={() => {
              const current = card.isFree === true ? "free" : "paid";
              const mode = window
                .prompt("การขาย Episode Pack: พิมพ์ free = ฟรี หรือ paid = ขาย", current)
                ?.trim()
                .toLowerCase();
              if (mode !== "free" && mode !== "paid") return;
              if (mode === "free") {
                onEditSale(card, "free");
                return;
              }
              const price = window
                .prompt(
                  "ราคาแพ็ก (บาท)",
                  card.price && Number(card.price) > 0 ? String(card.price) : "100.00"
                )
                ?.trim();
              if (price) onEditSale(card, "paid", price);
            }}
          >
            แก้การขาย
          </button>
        ) : null}
        <button
          type="button"
          className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/30"
          disabled={!card.workItemId || !card.workItemVersion || editNotePending}
          onClick={() => {
            const next = window.prompt("หมายเหตุแพ็ก", card.note ?? "");
            if (next != null && next.trim() !== (card.note ?? "")) {
              onEditNote(card, next.trim());
            }
          }}
        >
          แก้หมายเหตุ
        </button>
        <button
          type="button"
          className="w-full rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
          disabled={!card.workItemId || removePending}
          onClick={() => {
            if (window.confirm(`นำ Episode Pack ${card.episodeNumber || ""} ออกจาก Workspace หรือไม่?`)) {
              onRemove(card);
            }
          }}
        >
          นำออก
        </button>
      </div>
    </details>
  );
}
