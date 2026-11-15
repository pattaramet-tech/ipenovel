import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import AdminLayout from "@/components/AdminLayout";
import { parseChapterPriceOverrides } from "@/components/AdminPackageChapterSplitPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

const CONFIRM_TEXT = "MIGRATE_PACKAGES";
const PRICE_RE = /^\d{1,8}(?:\.\d{1,2})?$/;
type StatusFilter = "all" | "splittable" | "already_split" | "needs_attention" | "conflict" | "source_required" | "no_content";

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "ทุกสถานะ",
  splittable: "พร้อมแยก",
  already_split: "แยกแล้ว",
  needs_attention: "ต้องแก้ไข",
  conflict: "ขัดแย้ง",
  source_required: "ต้องนำเข้าเนื้อหาต้นทาง",
  no_content: "ไม่มีเนื้อหา",
};

export default function AdminPackageSplitMigrationPage() {
  const utils = trpc.useUtils();
  const [novelText, setNovelText] = useState("");
  const [novelSearch, setNovelSearch] = useState("");
  const [selectedNovelName, setSelectedNovelName] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [previousCursors, setPreviousCursors] = useState<Array<number | null>>([]);
  const [selectionLimit, setSelectionLimit] = useState<5 | 10>(5);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [chapterPrice, setChapterPrice] = useState("");
  const [overridesText, setOverridesText] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [previewState, setPreviewState] = useState<{
    signature: string;
    data: Awaited<ReturnType<typeof previewMutation.mutateAsync>>;
  } | null>(null);
  const [lastResult, setLastResult] = useState<
    Awaited<ReturnType<typeof applyMutation.mutateAsync>> | null
  >(null);

  const novelFilterValid = !novelText.trim() || (/^[1-9]\d*$/.test(novelText.trim()) && Number.isSafeInteger(Number(novelText.trim())));
  const novelId = novelText.trim() && novelFilterValid ? Number(novelText.trim()) : undefined;
  const novelResults = trpc.admin.novels.list.useQuery(
    { q: novelSearch.trim(), limit: 10 },
    { enabled: novelSearch.trim().length >= 2, refetchOnWindowFocus: false }
  );
  const scanQuery = trpc.admin.episodes.packageSplitScanPage.useQuery(
    { novelId, cursor: cursor ?? undefined, limit: 20, status, attentionOnly },
    { enabled: novelFilterValid, refetchOnWindowFocus: false }
  );
  const previewMutation = trpc.admin.episodes.packageSplitBatchPreview.useMutation();
  const applyMutation = trpc.admin.episodes.packageSplitBatchApply.useMutation();

  const parsedOverrides = parseChapterPriceOverrides(overridesText);
  const overrideError = "error" in parsedOverrides ? parsedOverrides.error : null;
  const priceValid = PRICE_RE.test(chapterPrice.trim());
  const pricing = {
    chapterPrice: chapterPrice.trim(),
    overrides: "overrides" in parsedOverrides ? parsedOverrides.overrides : {},
  };
  const signature = JSON.stringify({
    ids: [...selectedIds].sort((a, b) => a - b),
    chapterPrice: pricing.chapterPrice,
    overrides: pricing.overrides,
  });
  const freshPreview = previewState?.signature === signature ? previewState.data : null;
  const readyItems = freshPreview?.results
    .filter((item) => item.status === "ready" && item.planHash !== null)
    .map((item) => ({ packageEpisodeId: item.packageEpisodeId, planHash: item.planHash! })) ?? [];
  const isBusy = previewMutation.isPending || applyMutation.isPending;

  function clearPageState() {
    setCursor(null);
    setPreviousCursors([]);
    setSelectedIds([]);
    setPreviewState(null);
    setConfirmText("");
  }

  function toggleSelect(id: number, enabled: boolean) {
    setPreviewState(null);
    setConfirmText("");
    setSelectedIds((old) =>
      enabled ? (old.includes(id) || old.length >= selectionLimit ? old : [...old, id]) : old.filter((x) => x !== id)
    );
  }

  async function runPreview() {
    if (!priceValid || overrideError || selectedIds.length < 1 || selectedIds.length > selectionLimit) {
      toast.error("เลือกรายการและกำหนดราคาต่อบทให้ถูกต้องก่อน Preview");
      return;
    }
    const atRequest = signature;
    try {
      const data = await previewMutation.mutateAsync({ packageEpisodeIds: selectedIds, pricing });
      setPreviewState({ signature: atRequest, data });
      setConfirmText("");
      setLastResult(null);
      toast.success("Dry Run เสร็จแล้ว: พร้อม " + data.ready + " แพ็ก, ข้าม " + data.skipped + ", มีปัญหา " + data.blocked);
    } catch (error: any) {
      setPreviewState(null);
      toast.error(error?.message || "Preview ไม่สำเร็จ");
    }
  }

  async function runApply() {
    if (!freshPreview || readyItems.length === 0 || confirmText !== CONFIRM_TEXT || isBusy) return;
    try {
      const result = await applyMutation.mutateAsync({
        items: readyItems,
        pricing,
        confirmation: CONFIRM_TEXT,
      });
      setLastResult(result);
      setPreviewState(null);
      setConfirmText("");
      setSelectedIds([]);
      await utils.admin.episodes.packageSplitScanPage.invalidate();
      toast[result.failed > 0 ? "warning" : "success"](
        "สำเร็จ " + result.migrated + " / ข้าม " + result.skipped + " / ล้มเหลว " + result.failed
      );
    } catch (error: any) {
      toast.error(error?.message || "Batch Apply ไม่สำเร็จ");
    }
  }

  const rows = scanQuery.data?.rows ?? [];
  return (
    <AdminLayout>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-bold">Package Split Migration</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            แปลงแพ็กนิยายเก่าเป็นรายบทอย่างปลอดภัย โดยคงแพ็กเดิม ราคาเดิม และสิทธิ์ผู้ซื้อทุกคนไว้
            บทที่สร้างใหม่จะเป็น Draft เสมอ ไม่มีการเผยแพร่หรือคิดเงินผู้อ่านอัตโนมัติ
          </p>
        </div>
        <Card className="p-5 space-y-3">
          <h2 className="font-semibold">1. Scan Legacy Packages (อ่านอย่างเดียว)</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="package-migration-novel">Novel ID (ว่าง = ทุกเรื่อง)</Label>
              <Input id="package-migration-novel" value={novelText} onChange={(e) => {setNovelText(e.target.value); setSelectedNovelName(""); clearPageState();}} placeholder="ทุกเรื่อง" />
              <Input aria-label="ค้นหาชื่อนิยาย" className="mt-2" placeholder="ค้นหาชื่อนิยาย (2 ตัวอักษรขึ้นไป)" value={novelSearch} onChange={(e) => setNovelSearch(e.target.value)} />
              {selectedNovelName && <p className="text-xs text-muted-foreground">เรื่องที่เลือก: {selectedNovelName}</p>}
              {novelSearch.trim().length >= 2 && (
                <div className="max-h-40 overflow-y-auto rounded border text-xs">
                  {novelResults.isFetching ? <p className="p-2">กำลังค้นหา...</p> :
                    (novelResults.data ?? []).map((novel: { id: number; title: string }) => (
                      <button type="button" key={novel.id} className="block w-full border-b p-2 text-left hover:bg-muted"
                        onClick={() => {
                          setNovelText(String(novel.id));
                          setSelectedNovelName(novel.title);
                          setNovelSearch("");
                          clearPageState();
                        }}>{novel.title} (#{novel.id})</button>
                    ))}
                </div>
              )}
              {!novelFilterValid && <p className="text-xs text-red-600">ใส่ Novel ID เป็นจำนวนเต็มบวก</p>}
            </div>
            <div>
              <Label htmlFor="package-migration-status">สถานะ</Label>
              <select id="package-migration-status" value={status} onChange={(e) => {setStatus(e.target.value as StatusFilter); clearPageState();}} className="w-full rounded border p-2 bg-background">
                {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((value) => (
                  <option key={value} value={value}>{STATUS_LABEL[value]}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input type="checkbox" id="package-migration-attention" checked={attentionOnly} onChange={(e) => {setAttentionOnly(e.target.checked); clearPageState();}} />
              <Label htmlFor="package-migration-attention">เฉพาะรายการที่ต้องตรวจแก้</Label>
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            สแกนผ่าน Cursor ทีละไม่เกิน 200 Candidate; แสดงสูงสุด 20 รายการต่อหน้า
            {scanQuery.data ? " · ตรวจ " + scanQuery.data.inspected + " แถวในรอบนี้" : ""}
          </div>
          {scanQuery.isLoading ? <p>กำลังสแกน...</p> : scanQuery.isError ? (
            <p className="text-red-600">สแกนไม่สำเร็จ: {scanQuery.error.message}</p>
          ) : rows.length === 0 ? <p className="text-sm">ไม่พบรายการในหน้านี้ (อาจมีรายการในหน้าถัดไป)</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left">
                  <th className="p-2">เลือก</th><th className="p-2">Novel ID</th><th className="p-2">แพ็ก</th>
                  <th className="p-2">ชื่อแพ็ก</th><th className="p-2">สถานะ</th><th className="p-2">บทใหม่</th><th className="p-2">ปัญหา</th>
                </tr></thead>
                <tbody>{rows.map((row) => (
                  <tr key={row.packageEpisodeId} className="border-b">
                    <td className="p-2">
                      <input type="checkbox" aria-label={"เลือกแพ็ก " + row.packageEpisodeId}
                        checked={selectedIds.includes(row.packageEpisodeId)}
                        disabled={row.status !== "splittable" || isBusy || (!selectedIds.includes(row.packageEpisodeId) && selectedIds.length >= selectionLimit)}
                        onChange={(e) => toggleSelect(row.packageEpisodeId, e.target.checked)} />
                    </td>
                    <td className="p-2">{row.novelId}</td><td className="p-2">{row.episodeNumber}</td>
                    <td className="p-2">{row.title}</td>
                    <td className="p-2">{STATUS_LABEL[row.status]}</td>
                    <td className="p-2">{row.createCount}</td>
                    <td className="p-2 text-red-600">{row.issueCodes.join(", ") || "-"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={previousCursors.length === 0 || isBusy} onClick={() => {
              setCursor(previousCursors[previousCursors.length - 1]);
              setPreviousCursors((list) => list.slice(0, -1));
            }}>ก่อนหน้า</Button>
            <Button variant="outline" disabled={!scanQuery.data?.hasMore || scanQuery.data?.nextCursor == null || isBusy}
              onClick={() => {
                if (scanQuery.data?.nextCursor != null) {
                  setPreviousCursors((list) => [...list, cursor]);
                  setCursor(scanQuery.data.nextCursor);
                }
              }}>ถัดไป</Button>
            <Button variant="outline" onClick={() => scanQuery.refetch()} disabled={isBusy || !novelFilterValid}>สแกนซ้ำ</Button>
          </div>
        </Card>

        <Card className="p-5 space-y-4">
          <h2 className="font-semibold">2. Dry Run / Preview (ไม่เขียนฐานข้อมูล)</h2>
          <p className="text-sm text-muted-foreground">เลือกแพ็กที่พร้อมแยกได้สูงสุด 5–10 แพ็กต่อ Batch การใช้ราคา 0 หมายถึงบทฟรี ต้องกำหนดราคาเองอย่างชัดเจน</p>
          <div className="flex gap-3 items-center">
            <Label htmlFor="migration-batch-size">Batch สูงสุด</Label>
            <select id="migration-batch-size" className="border rounded bg-background p-2" value={selectionLimit}
              onChange={(e) => {
                const next = Number(e.target.value) as 5 | 10;
                setSelectionLimit(next); setSelectedIds((ids) => ids.slice(0, next)); setPreviewState(null); setConfirmText("");
              }}>
              <option value={5}>5 แพ็ก</option><option value={10}>10 แพ็ก</option>
            </select>
            <span className="text-sm text-muted-foreground">เลือก {selectedIds.length} แพ็ก</span>
          </div>
          <p className="text-xs text-muted-foreground">ราคาเฉพาะบทจะใช้กับทุกแพ็กที่เลือก ถ้าเลขบทไม่อยู่ในแพ็กใด แพ็กนั้นจะถูกบล็อกใน Dry Run โดยไม่เขียนข้อมูล</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="migration-chapter-price">ราคาต่อบท (บาท)</Label>
              <Input id="migration-chapter-price" placeholder="เช่น 5.00 (0 = ฟรี)" value={chapterPrice}
                onChange={(e) => setChapterPrice(e.target.value)} />
              {chapterPrice.length > 0 && !priceValid && <p className="text-xs text-red-600">ราคาไม่ถูกต้อง</p>}
            </div>
            <div>
              <Label htmlFor="migration-price-overrides">ราคาเฉพาะบท (ถ้ามี)</Label>
              <textarea id="migration-price-overrides" className="w-full rounded border p-2 bg-background" rows={3}
                placeholder={"1: 0\n10: 9.50"} value={overridesText} onChange={(e) => setOverridesText(e.target.value)} />
              {overrideError && <p className="text-xs text-red-600">{overrideError}</p>}
            </div>
          </div>
          <Button onClick={runPreview} disabled={isBusy || !priceValid || Boolean(overrideError) || selectedIds.length === 0}>
            {previewMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            Dry Run / Preview
          </Button>
          {previewState && !freshPreview && <p className="text-amber-600 text-sm">รายการหรือราคาเปลี่ยนแล้ว ต้อง Preview ใหม่ก่อน Apply</p>}
          {freshPreview && (
            <div className="space-y-3">
              <p className="font-medium">พร้อม {freshPreview.ready} · ข้าม {freshPreview.skipped} · มีปัญหา {freshPreview.blocked}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b text-left"><th className="p-2">Package ID</th><th className="p-2">ผล</th>
                    <th className="p-2">สร้าง</th><th className="p-2">มีอยู่</th><th className="p-2">หมายเหตุ</th></tr></thead>
                  <tbody>{freshPreview.results.map((item) => (
                    <tr key={item.packageEpisodeId} className="border-b">
                      <td className="p-2">{item.packageEpisodeId}</td><td className="p-2">{item.status}</td>
                      <td className="p-2">{item.createCount}</td><td className="p-2">{item.keepCount}</td>
                      <td className="p-2">{[...item.issues, ...item.warnings].join(" · ") || "-"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="space-y-2 border-t pt-3">
                <h3 className="font-semibold">3. Controlled Migration (Draft เท่านั้น)</h3>
                <p className="text-sm text-muted-foreground">พร้อมยืนยัน {readyItems.length} แพ็ก · หนึ่ง Transaction ต่อแพ็ก · แพ็กเดิมไม่ถูกแก้ไข · ผลล้มเหลวไม่ขัดขวางแพ็กอื่น</p>
                <Label htmlFor="migration-confirm">พิมพ์ MIGRATE_PACKAGES เพื่อยืนยัน</Label>
                <Input id="migration-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={CONFIRM_TEXT} />
                <Button onClick={runApply} disabled={isBusy || readyItems.length === 0 || confirmText !== CONFIRM_TEXT}>
                  {applyMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                  ยืนยัน Migration {readyItems.length} แพ็ก
                </Button>
              </div>
            </div>
          )}
        </Card>

        {lastResult && (
          <Card className="p-5 space-y-3">
            <h2 className="font-semibold">4. ผล Batch ล่าสุด (Resume จาก Scan Cursor เดิมได้)</h2>
            <p>สำเร็จ {lastResult.migrated} · ข้าม {lastResult.skipped} · ล้มเหลว {lastResult.failed}</p>
            <div className="space-y-1">{lastResult.results.map((item) => (
              <p key={item.packageEpisodeId} className="text-sm">
                แพ็ก {item.packageEpisodeId}: {item.outcome} · สร้าง {item.createdCount} · มีอยู่ {item.keptCount}
                {item.errorCode ? " · " + item.errorCode : ""}
              </p>
            ))}</div>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
