/**
 * IPE-059-B — Workspace novel export dialog.
 *
 * Compact utility dialog (NOT part of the Draft → Checker → QC → Confirm →
 * Stage → Publish progression) exposing two clearly separated export modes:
 *
 * 1. Thai-Novel Upload — flat upload-ready TXT files (001.txt, ...) for the
 *    Thai-Novel portal, with start-number/prefix/append-filename options.
 * 2. IpeNovel Backup / Re-import — manifest.csv + contents/*.txt package
 *    compatible with the existing ZIP import (IPE-059-A contract).
 *
 * Preview is served by the same server serializer used for the download —
 * this component formats rows only and contains no serialization logic.
 * Export reads published episodes only; it never triggers any editorial
 * workflow action.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";

export interface ExportDialogNovel {
  novelId: number;
  novelTitle: string;
}

interface WorkspaceNovelExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  novels: ExportDialogNovel[];
}

type ExportMode = "thainovel" | "backup";
type ExportScope = "whole" | "subset";

/** Decode a bounded base64 payload and trigger a browser download. */
export function downloadBase64AsFile(contentBase64: string, filename: string, mimeType: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Reclaim the object URL once the download has been kicked off.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function WorkspaceNovelExportDialog({ open, onOpenChange, novels }: WorkspaceNovelExportDialogProps) {
  const [mode, setMode] = useState<ExportMode>("thainovel");
  const [scope, setScope] = useState<ExportScope>("whole");
  const [selectedNovelId, setSelectedNovelId] = useState<number | null>(novels.length === 1 ? novels[0].novelId : null);
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<number[]>([]);
  const [startEpisodeNumber, setStartEpisodeNumber] = useState("");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [appendFilenameToTitle, setAppendFilenameToTitle] = useState(false);
  // IPE-064R3: title/id search over the novel list — filtering only affects
  // what the selector shows, never the current selection or the export scope.
  const [novelSearch, setNovelSearch] = useState("");

  useEffect(() => {
    if (!open) setNovelSearch("");
  }, [open]);

  const novelId = selectedNovelId ?? (novels.length === 1 ? novels[0].novelId : null);
  const filteredNovels = useMemo(() => {
    const query = novelSearch.trim().toLocaleLowerCase("th");
    if (!query) return novels;
    return novels.filter(
      (novel) =>
        novel.novelTitle.toLocaleLowerCase("th").includes(query) ||
        String(novel.novelId).includes(query)
    );
  }, [novels, novelSearch]);
  // Keep the current selection visible even when the search filters it out.
  const selectableNovels = useMemo(() => {
    if (novelId && !filteredNovels.some((novel) => novel.novelId === novelId)) {
      const current = novels.find((novel) => novel.novelId === novelId);
      return current ? [current, ...filteredNovels] : filteredNovels;
    }
    return filteredNovels;
  }, [filteredNovels, novels, novelId]);
  const parsedStart = Number(startEpisodeNumber);
  const validStart = startEpisodeNumber.trim() === "" || (Number.isInteger(parsedStart) && parsedStart >= 1);
  const subsetActive = scope === "subset" && selectedEpisodeIds.length > 0;

  const debouncedStart = useDebouncedValue(startEpisodeNumber);
  const debouncedPrefix = useDebouncedValue(titlePrefix);
  const debouncedParsedStart = Number(debouncedStart);

  const selectionInput = useMemo(
    () => ({
      novelId: novelId ?? 0,
      ...(subsetActive ? { episodeIds: selectedEpisodeIds } : {}),
    }),
    [novelId, subsetActive, selectedEpisodeIds]
  );

  const thaiOptions = useMemo(
    () => ({
      ...(debouncedStart.trim() !== "" && Number.isInteger(debouncedParsedStart) && debouncedParsedStart >= 1 ? { startEpisodeNumber: debouncedParsedStart } : {}),
      ...(debouncedPrefix.trim() ? { titlePrefix: debouncedPrefix } : {}),
      ...(appendFilenameToTitle ? { appendFilenameToTitle: true } : {}),
    }),
    [debouncedStart, debouncedParsedStart, debouncedPrefix, appendFilenameToTitle]
  );

  // Serves both modes: sourceEpisodes powers the subset selector; entries
  // power the Thai-Novel preview table (same serializer as the download).
  const thaiPreview = trpc.admin.novelExport.thaiNovelPreview.useQuery(
    { ...selectionInput, ...thaiOptions },
    { enabled: open && Boolean(novelId), retry: false }
  );
  const backupPreview = trpc.admin.novelExport.preview.useQuery(selectionInput, {
    enabled: open && Boolean(novelId) && mode === "backup",
    retry: false,
  });

  const thaiDownload = trpc.admin.novelExport.thaiNovelDownloadZip.useMutation();
  const backupDownload = trpc.admin.novelExport.downloadZip.useMutation();

  const downloadPending = thaiDownload.isPending || backupDownload.isPending;
  const downloadError = mode === "thainovel" ? thaiDownload.error : backupDownload.error;
  const previewError = mode === "thainovel" ? thaiPreview.error : backupPreview.error;
  const previewLoading = mode === "thainovel" ? thaiPreview.isFetching : backupPreview.isFetching;
  const entryCount = mode === "thainovel" ? (thaiPreview.data?.entries.length ?? 0) : (backupPreview.data?.exportItemCount ?? 0);
  // IPE-064R3: whole-novel Thai export over MAX_EXPORT_ITEMS — the preview
  // still returns sourceEpisodes (per-pack subset is the way out), but the
  // whole-scope download stays disabled/fail-closed.
  const thaiOverLimit = thaiPreview.data?.overLimit ?? null;
  const wholeScopeOverLimit = Boolean(thaiOverLimit && scope === "whole");
  const downloadDisabled =
    !novelId ||
    !validStart ||
    previewLoading ||
    Boolean(previewError) ||
    entryCount === 0 ||
    downloadPending ||
    (scope === "subset" && !subsetActive) ||
    wholeScopeOverLimit;

  const handleDownload = () => {
    if (!novelId) return;
    const onSuccess = (result: { contentBase64: string; filename: string; mimeType: string }) => {
      downloadBase64AsFile(result.contentBase64, result.filename, result.mimeType);
    };
    if (mode === "thainovel") {
      thaiDownload.mutate({ ...selectionInput, ...thaiOptions }, { onSuccess });
    } else {
      backupDownload.mutate(selectionInput, { onSuccess });
    }
  };

  const toggleEpisode = (episodeId: number) => {
    setSelectedEpisodeIds((current) =>
      current.includes(episodeId) ? current.filter((id) => id !== episodeId) : [...current, episodeId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="workspace-novel-export-dialog">
        <DialogHeader>
          <DialogTitle>ส่งออกนิยาย</DialogTitle>
          <DialogDescription>ส่งออกเฉพาะตอนที่เผยแพร่แล้ว (canonical published content)</DialogDescription>
        </DialogHeader>

        {novels.length === 0 ? (
          <p className="text-sm text-muted-foreground">Workspace นี้ยังไม่ได้ผูกนิยาย</p>
        ) : (
          <div className="space-y-4">
            {novels.length > 1 && (
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="workspace-export-novel">
                  นิยาย
                </label>
                <input
                  type="search"
                  data-testid="export-novel-search"
                  aria-label="ค้นหาชื่อเรื่อง / Novel ID"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  placeholder="พิมพ์ค้นหาชื่อเรื่อง / Novel ID"
                  value={novelSearch}
                  onChange={(event) => setNovelSearch(event.target.value)}
                />
                {selectableNovels.length === 0 ? (
                  <p className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                    ไม่พบเรื่องที่ตรงกับการค้นหา
                  </p>
                ) : (
                  <select
                    id="workspace-export-novel"
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={novelId ?? ""}
                    onChange={(event) => setSelectedNovelId(Number(event.target.value) || null)}
                  >
                    {selectableNovels.map((novel) => (
                      <option key={novel.novelId} value={novel.novelId}>
                        {novel.novelTitle}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">รูปแบบการส่งออก</legend>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-mode"
                    data-testid="export-mode-thainovel"
                    checked={mode === "thainovel"}
                    onChange={() => setMode("thainovel")}
                  />
                  Thai-Novel Upload (ไฟล์ TXT แบบแบนสำหรับอัปโหลด)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-mode"
                    data-testid="export-mode-backup"
                    checked={mode === "backup"}
                    onChange={() => setMode("backup")}
                  />
                  IpeNovel Backup / Re-import (manifest.csv + contents/*.txt)
                </label>
              </div>
            </fieldset>

            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">ขอบเขต</legend>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-scope"
                    data-testid="export-scope-whole"
                    checked={scope === "whole"}
                    onChange={() => setScope("whole")}
                  />
                  ทั้งเรื่อง
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-scope"
                    data-testid="export-scope-subset"
                    checked={scope === "subset"}
                    onChange={() => setScope("subset")}
                  />
                  ตอนที่เลือก
                </label>
              </div>
              {scope === "subset" && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {(thaiPreview.data?.sourceEpisodes ?? []).map((episode) => (
                    <label key={episode.episodeId} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedEpisodeIds.includes(episode.episodeId)}
                        onChange={() => toggleEpisode(episode.episodeId)}
                      />
                      {episode.episodeNumber} · {episode.title}
                    </label>
                  ))}
                  {scope === "subset" && (thaiPreview.data?.sourceEpisodes ?? []).length === 0 && !thaiPreview.isFetching && (
                    <p className="text-sm text-muted-foreground">ไม่มีตอนที่เผยแพร่แล้ว</p>
                  )}
                </div>
              )}
            </fieldset>

            {mode === "thainovel" && (
              <fieldset className="space-y-2" data-testid="export-thainovel-options">
                <legend className="text-sm font-medium">ตัวเลือก Thai-Novel</legend>
                <div className="flex items-center gap-2 text-sm">
                  <label htmlFor="workspace-export-start">เริ่มเลขบทใหม่</label>
                  <input
                    id="workspace-export-start"
                    type="number"
                    min={1}
                    className="h-9 w-24 rounded-md border bg-background px-3 text-sm"
                    data-testid="export-option-start-number"
                    value={startEpisodeNumber}
                    placeholder="ตามต้นฉบับ"
                    onChange={(event) => setStartEpisodeNumber(event.target.value)}
                  />
                  {!validStart && <span className="text-xs text-destructive">ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป หรือเว้นว่างเพื่อใช้เลขบทต้นฉบับ</span>}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label htmlFor="workspace-export-prefix">คำนำหน้าชื่อตอน</label>
                  <input
                    id="workspace-export-prefix"
                    type="text"
                    className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                    placeholder="เช่น ตอนที่"
                    data-testid="export-option-title-prefix"
                    value={titlePrefix}
                    onChange={(event) => setTitlePrefix(event.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="export-option-append-filename"
                    checked={appendFilenameToTitle}
                    onChange={(event) => setAppendFilenameToTitle(event.target.checked)}
                  />
                  เพิ่มชื่อไฟล์ต่อท้ายชื่อตอน
                </label>
                <p className="text-xs text-muted-foreground">
                  ตอนแบบแพ็กจะถูกแยกเป็น 1 บทต่อ 1 TXT และตัดบรรทัด “แพ็กตอน …” ออก ชื่อไฟล์อิงหัวบทเหมือนไฟล์ตัวอย่าง Naruto; บรรทัดแรกเป็นหัวบท ตามด้วยบรรทัดว่าง แล้วเป็นเนื้อหา (UTF-8)
                </p>
              </fieldset>
            )}

            {mode === "backup" && (
              <p className="text-xs text-muted-foreground" data-testid="export-backup-explanation">
                แพ็กสำรองประกอบด้วย manifest.csv และโฟลเดอร์ contents/*.txt ซึ่งนำกลับเข้าระบบผ่าน ZIP Import เดิมได้
              </p>
            )}

            {mode === "thainovel" && thaiOverLimit && scope === "whole" && (
              <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="export-over-limit-banner">
                <p className="font-medium">
                  เรื่องนี้แยกแพ็กได้ {thaiOverLimit.itemCount.toLocaleString()} บท — เกินลิมิตต่อไฟล์ ({thaiOverLimit.maxItems} บท)
                </p>
                <p className="text-xs">
                  ส่งออกแบบ "ทั้งเรื่อง" ไม่ได้ — เลือกโหมด "เลือกบางตอน" แล้วติ๊กเลือกรายแพ็กที่ต้องการ (ต่อไฟล์ไม่เกิน {thaiOverLimit.maxItems} บท) แล้วส่งออกเป็นชุด
                </p>
              </div>
            )}

            <div className="space-y-1" data-testid="export-preview-table">
              <p className="text-sm font-medium">ตัวอย่างผลลัพธ์</p>
              {mode === "thainovel" ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2">ตอนต้นทาง</th>
                      <th className="py-1 pr-2">ชื่อไฟล์</th>
                      <th className="py-1">ชื่อในไฟล์</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(thaiPreview.data?.entries ?? []).map((entry) => (
                      <tr key={`${entry.episodeId}:${entry.sourceChapterNumber}:${entry.filename}`} className="border-t">
                        <td className="py-1 pr-2">
                          {entry.sourceEpisodeNumber === entry.sourceChapterNumber
                            ? entry.sourceChapterNumber
                            : `${entry.sourceEpisodeNumber} → ${entry.sourceChapterNumber}`}
                        </td>
                        <td className="py-1 pr-2">{entry.filename}</td>
                        <td className="py-1">{entry.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <p>
                    ตอนที่จะส่งออก: {backupPreview.data?.exportItemCount ?? 0}
                    {(backupPreview.data?.skippedItems.length ?? 0) > 0 && ` (ข้าม ${backupPreview.data?.skippedItems.length} ตอนที่ไม่มีเนื้อหา)`}
                  </p>
                  <p className="truncate">{(backupPreview.data?.filenames ?? []).join(", ") || "-"}</p>
                </div>
              )}
              {previewLoading && <p className="text-xs text-muted-foreground">กำลังโหลดตัวอย่าง…</p>}
              {previewError && <p className="text-xs text-destructive">{previewError.message}</p>}
              {!previewLoading && !previewError && entryCount === 0 && (
                <p className="text-xs text-muted-foreground">ไม่มีตอนที่เผยแพร่และมีเนื้อหาให้ส่งออก</p>
              )}
              {mode === "thainovel" && (thaiPreview.data?.skippedItems.length ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">ข้าม {thaiPreview.data?.skippedItems.length} ตอนที่ไม่มีเนื้อหา</p>
              )}
            </div>

            {downloadError && <p className="text-sm text-destructive">{downloadError.message}</p>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                ปิด
              </Button>
              <Button
                type="button"
                data-testid="export-download-zip"
                disabled={downloadDisabled}
                onClick={handleDownload}
              >
                {downloadPending ? "กำลังสร้างไฟล์…" : "ดาวน์โหลด ZIP"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
