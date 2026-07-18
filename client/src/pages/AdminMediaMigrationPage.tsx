import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useState } from "react";
import { Loader2, AlertCircle, Image as ImageIcon, ExternalLink } from "lucide-react";

const CONFIRM_TEXT = "MIGRATE_TO_R2";

type PreviewType = "banners" | "novels" | "all";
type LiveLimit = 5 | 10;

interface MigrationRowResult {
  type: "novel" | "banner";
  id: number;
  outcome: "migrated" | "would_migrate" | "failed";
  oldUrl: string;
  newUrl?: string;
  reason?: string;
}

interface MigrationBatchResult {
  dryRun: boolean;
  type: string;
  limit: number;
  startId: number;
  totalChecked: number;
  alreadyMigratedCount: number;
  eligibleCount: number;
  processedCount: number;
  remainingEligible: number;
  migratedCount: number;
  wouldMigrateCount: number;
  failedCount: number;
  results: MigrationRowResult[];
}

/**
 * Admin-only runner for the novels.coverImageUrl/banners.imageUrl -> R2
 * migration (server/services/mediaMigrationService.ts). Exists because Manus
 * production has no terminal - this is the only way to run the migration
 * there, in small controlled batches, without touching the old files or the
 * live upload path that already works.
 */
export default function AdminMediaMigrationPage() {
  const [previewType, setPreviewType] = useState<PreviewType>("all");
  const [previewLimit, setPreviewLimit] = useState<5 | 10 | 20>(5);
  const [liveLimit, setLiveLimit] = useState<LiveLimit>(5);
  const [startIdInput, setStartIdInput] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [lastResult, setLastResult] = useState<MigrationBatchResult | null>(null);
  const [lastActionLabel, setLastActionLabel] = useState<string | null>(null);

  const previewMutation = trpc.admin.mediaMigration.preview.useMutation();
  const runMutation = trpc.admin.mediaMigration.run.useMutation();

  const isBusy = previewMutation.isPending || runMutation.isPending;
  const startId = startIdInput.trim() ? parseInt(startIdInput.trim(), 10) : undefined;
  const startIdInvalid = startIdInput.trim().length > 0 && (!Number.isFinite(startId) || (startId ?? 0) < 0);
  const canConfirmLiveRun = confirmText === CONFIRM_TEXT;

  const describeError = (error: any): string => {
    return error?.message || "เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองใหม่อีกครั้ง";
  };

  const handleDryRun = async () => {
    try {
      const result = await previewMutation.mutateAsync({
        type: previewType,
        limit: previewLimit,
        startId: startIdInvalid ? undefined : startId,
      });
      setLastResult(result);
      setLastActionLabel(`Dry Run (type=${previewType}, limit=${previewLimit})`);
      toast.success(`Dry run เสร็จสิ้น: จะ migrate ${result.wouldMigrateCount} รายการ`);
    } catch (error: any) {
      toast.error(describeError(error));
    }
  };

  const handleLiveRun = async (type: "banners" | "novels") => {
    if (!canConfirmLiveRun) {
      toast.error(`กรุณาพิมพ์ "${CONFIRM_TEXT}" ให้ตรงก่อนยืนยัน`);
      return;
    }

    try {
      const result = await runMutation.mutateAsync({
        type,
        limit: liveLimit,
        startId: startIdInvalid ? undefined : startId,
        confirmText,
      });
      setLastResult(result);
      setLastActionLabel(`Migrate ${type === "banners" ? "Banners" : "Novel Covers"} (limit=${liveLimit})`);
      setConfirmText("");
      if (result.failedCount > 0) {
        toast.warning(`Migrate เสร็จสิ้น: สำเร็จ ${result.migratedCount}, ล้มเหลว ${result.failedCount}`);
      } else {
        toast.success(`Migrate เสร็จสิ้น: สำเร็จ ${result.migratedCount} รายการ`);
      }
    } catch (error: any) {
      toast.error(describeError(error));
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-4 md:space-y-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 flex items-center gap-2">
            <ImageIcon className="w-6 h-6" />
            Media Migration
          </h1>
          <p className="text-sm sm:text-base text-slate-600 mt-1 sm:mt-2">
            ย้ายรูปเก่าใน DB ไป Cloudflare R2
          </p>
        </div>

        <Card className="p-4 bg-blue-50 border-blue-200">
          <ul className="text-sm text-blue-900 space-y-1 list-disc list-inside">
            <li>ใช้กับ <code className="text-xs bg-white/60 px-1 rounded">novels.coverImageUrl</code> และ{" "}
              <code className="text-xs bg-white/60 px-1 rounded">banners.imageUrl</code> เท่านั้น</li>
            <li>ระบบจะไม่ลบไฟล์เดิม - แค่เปลี่ยน URL ในฐานข้อมูลหลังอัปโหลดไป R2 สำเร็จ</li>
            <li>รูปที่ migrate ไปแล้ว (URL ขึ้นต้นด้วย media.ipenovel.com) จะถูกข้ามอัตโนมัติ ไม่ migrate ซ้ำ</li>
            <li>ควรรันทีละ batch เล็ก ๆ (5-10 รายการ) แล้วตรวจว่า URL ใหม่เปิดได้จริงก่อนรันรอบถัดไป</li>
          </ul>
        </Card>

        {/* Controls */}
        <Card className="p-4 space-y-5">
          <div>
            <Label className="mb-2 block">Start ID (optional)</Label>
            <Input
              value={startIdInput}
              onChange={(e) => setStartIdInput(e.target.value)}
              placeholder="0"
              inputMode="numeric"
              className="max-w-[180px]"
            />
            {startIdInvalid && (
              <p className="text-xs text-red-600 mt-1">Start ID ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป</p>
            )}
            <p className="text-xs text-slate-500 mt-1">
              ใช้สำหรับรันต่อจาก id เดิม เมื่อ batch ก่อนหน้ายังไม่ครบทุกรายการ
            </p>
          </div>

          <div className="border-t pt-4">
            <h3 className="font-semibold text-sm mb-3">1. Dry Run - ดูก่อนว่าจะ migrate อะไรบ้าง (ไม่ upload ไม่แก้ DB)</h3>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <Label className="mb-1.5 block text-xs text-slate-600">Type</Label>
                <div className="flex gap-1">
                  {(["banners", "novels", "all"] as PreviewType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPreviewType(t)}
                      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                        previewType === t
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      {t === "banners" ? "Banners" : t === "novels" ? "Novels" : "All"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs text-slate-600">Limit</Label>
                <div className="flex gap-1">
                  {([5, 10, 20] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setPreviewLimit(n)}
                      className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                        previewLimit === n
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <Button onClick={handleDryRun} disabled={isBusy || startIdInvalid} className="gap-2">
                {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Dry Run
              </Button>
            </div>
          </div>

          <div className="border-t pt-4">
            <h3 className="font-semibold text-sm mb-1">2. Migrate จริง - upload ไป R2 และแก้ URL ใน DB</h3>
            <p className="text-xs text-slate-500 mb-3">
              เลือก limit ต่อครั้ง (สูงสุด 10) แล้วพิมพ์ข้อความยืนยันด้านล่างก่อนกดปุ่ม migrate
            </p>

            <div className="mb-3">
              <Label className="mb-1.5 block text-xs text-slate-600">Limit ต่อครั้ง</Label>
              <div className="flex gap-1">
                {([5, 10] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setLiveLimit(n)}
                    className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${
                      liveLimit === n
                        ? "bg-emerald-600 text-white border-emerald-600"
                        : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md">
              <Label className="mb-1.5 block text-xs text-amber-900">
                พิมพ์ <code className="bg-white px-1 rounded">{CONFIRM_TEXT}</code> เพื่อยืนยันการรัน migration จริง
              </Label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_TEXT}
                className="max-w-xs bg-white"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => handleLiveRun("banners")}
                disabled={isBusy || !canConfirmLiveRun || startIdInvalid}
                variant="default"
                className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              >
                {runMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Migrate Banners {liveLimit}
              </Button>
              <Button
                onClick={() => handleLiveRun("novels")}
                disabled={isBusy || !canConfirmLiveRun || startIdInvalid}
                variant="default"
                className="gap-2 bg-emerald-600 hover:bg-emerald-700"
              >
                {runMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Migrate Novel Covers {liveLimit}
              </Button>
            </div>
          </div>
        </Card>

        {/* Results */}
        {lastResult && (
          <Card className="p-4">
            <h3 className="font-semibold mb-1">
              ผลลัพธ์ล่าสุด{lastActionLabel ? `: ${lastActionLabel}` : ""}
            </h3>
            <p className="text-xs text-muted-foreground mb-4">
              {lastResult.dryRun
                ? "Dry run - ไม่มีการ upload หรือแก้ไขข้อมูลใด ๆ"
                : "รันจริงแล้ว - รายการที่สำเร็จถูกอัปเดต URL ใน DB แล้ว"}
            </p>

            <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 mb-4 text-center">
              <div>
                <p className="text-2xl font-bold">{lastResult.totalChecked}</p>
                <p className="text-xs text-muted-foreground">ทั้งหมดที่เช็ค</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-500">{lastResult.alreadyMigratedCount}</p>
                <p className="text-xs text-muted-foreground">migrate แล้ว (skip)</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">
                  {lastResult.dryRun ? lastResult.wouldMigrateCount : lastResult.migratedCount}
                </p>
                <p className="text-xs text-muted-foreground">{lastResult.dryRun ? "จะ migrate" : "migrated"}</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-red-600">{lastResult.failedCount}</p>
                <p className="text-xs text-muted-foreground">failed</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-amber-600">{lastResult.remainingEligible}</p>
                <p className="text-xs text-muted-foreground">เหลือรอ batch ถัดไป</p>
              </div>
            </div>

            {lastResult.remainingEligible > 0 && (
              <div className="mb-4 p-3 bg-slate-50 border rounded-md text-xs text-slate-600">
                ยังเหลืออีก {lastResult.remainingEligible} รายการที่ยังไม่ได้ประมวลผลรอบนี้ - กด batch ถัดไปได้เลย
                (ระบบจะข้ามรายการที่ migrate แล้วโดยอัตโนมัติ ไม่ต้องตั้ง Start ID เอง)
              </div>
            )}

            {lastResult.results.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left py-2 px-2">Type</th>
                      <th className="text-left py-2 px-2">ID</th>
                      <th className="text-left py-2 px-2">Outcome</th>
                      <th className="text-left py-2 px-2">Old URL</th>
                      <th className="text-left py-2 px-2">New URL</th>
                      <th className="text-left py-2 px-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lastResult.results.map((row) => {
                      const isFailed = row.outcome === "failed";
                      const isMigrated = row.outcome === "migrated";
                      return (
                        <tr
                          key={`${row.type}-${row.id}`}
                          className={`border-b hover:bg-slate-50 ${isFailed ? "bg-red-50/60" : isMigrated ? "bg-green-50/60" : ""}`}
                        >
                          <td className="py-2 px-2">{row.type}</td>
                          <td className="py-2 px-2 font-medium">#{row.id}</td>
                          <td className="py-2 px-2">
                            <span
                              className={`inline-block px-2 py-0.5 rounded font-medium ${
                                isFailed
                                  ? "bg-red-100 text-red-800"
                                  : isMigrated
                                    ? "bg-green-100 text-green-800"
                                    : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {row.outcome}
                            </span>
                          </td>
                          <td className="py-2 px-2 max-w-[220px] truncate" title={row.oldUrl}>
                            {row.oldUrl}
                          </td>
                          <td className="py-2 px-2 max-w-[220px] truncate">
                            {isMigrated && row.newUrl ? (
                              <a
                                href={row.newUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline inline-flex items-center gap-1"
                                title={row.newUrl}
                              >
                                {row.newUrl}
                                <ExternalLink className="w-3 h-3 shrink-0" />
                              </a>
                            ) : (
                              <span title={row.newUrl}>{row.newUrl || "-"}</span>
                            )}
                          </td>
                          <td className="py-2 px-2 text-red-700 max-w-xs">
                            {isFailed ? (
                              <span className="inline-flex items-start gap-1">
                                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                {row.reason}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-6">ไม่มีรายการที่ต้อง migrate ในเงื่อนไขนี้</p>
            )}
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
