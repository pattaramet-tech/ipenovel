import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

/**
 * Admin: split legacy range packages into sellable chapter rows.
 *
 * scan (read-only) -> pick a package -> price/publish -> preview (read-only)
 * -> apply. Apply is enabled only for an applicable preview whose inputs are
 * unchanged since that preview, and is bound server-side to the preview's
 * planHash (STALE_PLAN on any drift). The package itself is never modified.
 */

const STATUS_LABELS: Record<string, string> = {
  splittable: "แบ่งได้",
  already_split: "แบ่งแล้ว",
  needs_attention: "ต้องแก้ไข",
  conflict: "ขัดแย้งกับบทเดิม",
  no_content: "ไม่มีเนื้อหา",
};

const ACTION_LABELS: Record<string, string> = {
  create: "สร้างใหม่",
  keep: "มีอยู่แล้ว",
  conflict: "ขัดแย้ง",
};

interface PreviewInputs {
  packageEpisodeId: number;
  chapterPrice: string;
  overridesText: string;
  publish: boolean;
}

/**
 * Parse per-chapter overrides: one "chapter: price" (or "chapter=price") per
 * line or comma-separated, e.g. "1: 0, 5: 9.50". Returns null + the first
 * bad entry so the panel can refuse to preview instead of guessing.
 */
export function parseChapterPriceOverrides(
  text: string
): { overrides: Record<string, string> } | { error: string } {
  const overrides: Record<string, string> = {};
  const entries = text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const match = entry.match(/^(\d+)\s*[:=]\s*(\d{1,8}(?:\.\d{1,2})?)$/);
    if (!match) return { error: `รูปแบบราคาเฉพาะบทไม่ถูกต้อง: "${entry}" (ใช้ เลขบท: ราคา)` };
    const chapter = String(Number(match[1]));
    if (overrides[chapter] != null) return { error: `กำหนดราคาบทที่ ${chapter} ซ้ำ` };
    overrides[chapter] = match[2];
  }
  return { overrides };
}

export function AdminPackageChapterSplitPanel({ novelId }: { novelId: number | undefined }) {
  const utils = trpc.useUtils();
  const scanQuery = trpc.admin.episodes.packageSplitScan.useQuery(
    { novelId: novelId ?? 0 },
    { enabled: !!novelId }
  );
  const applyMutation = trpc.admin.episodes.packageSplitApply.useMutation();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [chapterPrice, setChapterPrice] = useState("");
  const [overridesText, setOverridesText] = useState("");
  const [publish, setPublish] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [previewedWith, setPreviewedWith] = useState<PreviewInputs | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const parsedOverrides = parseChapterPriceOverrides(overridesText);
  const overridesError = "error" in parsedOverrides ? parsedOverrides.error : null;
  const inputsDirty =
    preview != null &&
    (previewedWith?.packageEpisodeId !== selectedId ||
      previewedWith?.chapterPrice !== chapterPrice ||
      previewedWith?.overridesText !== overridesText ||
      previewedWith?.publish !== publish);
  const canApply =
    preview != null && preview.applicable === true && !!preview.planHash && !inputsDirty && !applyMutation.isPending;

  const pricingFor = (inputs: { chapterPrice: string; overridesText: string }) => {
    const parsed = parseChapterPriceOverrides(inputs.overridesText);
    const overrides = "overrides" in parsed ? parsed.overrides : {};
    return Object.keys(overrides).length > 0
      ? { chapterPrice: inputs.chapterPrice, overrides }
      : { chapterPrice: inputs.chapterPrice };
  };

  const runPreview = async () => {
    if (!selectedId || overridesError) return;
    const inputs = { packageEpisodeId: selectedId, chapterPrice, overridesText, publish };
    setIsPreviewing(true);
    try {
      const result = await utils.admin.episodes.packageSplitPreview.fetch({
        packageEpisodeId: selectedId,
        pricing: pricingFor(inputs),
        publish,
      });
      setPreview(result);
      setPreviewedWith(inputs);
    } catch (error: any) {
      setPreview(null);
      toast.error(error?.message || "ตรวจผลการแบ่งบทไม่สำเร็จ");
    } finally {
      setIsPreviewing(false);
    }
  };

  const runApply = async () => {
    if (!canApply || !previewedWith) return;
    try {
      const result = await applyMutation.mutateAsync({
        packageEpisodeId: previewedWith.packageEpisodeId,
        pricing: pricingFor(previewedWith),
        publish: previewedWith.publish,
        planHash: preview.planHash,
      });
      toast.success(
        `แบ่งบทสำเร็จ: สร้างใหม่ ${result.createdEpisodeIds.length} บท, มีอยู่แล้ว ${result.keptEpisodeIds.length} บท`
      );
      setPreview(null);
      setPreviewedWith(null);
      await scanQuery.refetch();
    } catch (error: any) {
      if (error?.message === "STALE_PLAN") {
        toast.error("ข้อมูลเปลี่ยนไปหลังตรวจ กรุณากดตรวจผลการแบ่งบทใหม่");
        setPreview(null);
      } else {
        toast.error(error?.message || "แบ่งบทไม่สำเร็จ");
      }
    }
  };

  if (!novelId) {
    return (
      <Card className="p-6">
        <h3 className="font-semibold mb-2">แบ่งแพ็กเดิมเป็นรายบท</h3>
        <p className="text-sm text-muted-foreground">เลือกนิยายก่อน</p>
      </Card>
    );
  }

  const packages: any[] = scanQuery.data ?? [];

  return (
    <Card className="p-6 space-y-4" data-testid="package-split-panel">
      <div>
        <h3 className="font-semibold mb-1">แบ่งแพ็กเดิมเป็นรายบท</h3>
        <p className="text-xs text-muted-foreground">
          แพ็กเดิมจะไม่ถูกแก้ไขหรือลบ ผู้ซื้อแพ็กยังอ่านได้เหมือนเดิม และอ่านบทที่แบ่งออกมาได้โดยไม่ต้องซื้อซ้ำ
        </p>
      </div>

      {scanQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">กำลังสแกนแพ็ก…</p>
      ) : packages.length === 0 ? (
        <p className="text-sm text-muted-foreground">ไม่พบแพ็กแบบช่วงตอนในนิยายนี้</p>
      ) : (
        <div className="border rounded max-h-64 overflow-y-auto divide-y">
          {packages.map((pkg) => (
            <label key={pkg.packageEpisodeId} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="package-split-target"
                aria-label={`เลือกแพ็ก ${pkg.episodeNumber}`}
                checked={selectedId === pkg.packageEpisodeId}
                onChange={() => setSelectedId(pkg.packageEpisodeId)}
              />
              <span className="font-medium">{pkg.episodeNumber}</span>
              <span className="text-muted-foreground truncate flex-1">{pkg.title}</span>
              <Badge variant="outline">{STATUS_LABELS[pkg.status] ?? pkg.status}</Badge>
              {pkg.issueCodes.length > 0 && <span className="text-xs text-red-600">{pkg.issueCodes.join(", ")}</span>}
            </label>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 items-end">
        <div>
          <Label htmlFor="split-chapter-price" className="mb-1 block text-sm">
            ราคาต่อบท (บาท, 0 = ฟรี)
          </Label>
          <Input
            id="split-chapter-price"
            value={chapterPrice}
            onChange={(e) => setChapterPrice(e.target.value)}
            placeholder="เช่น 5"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
          เผยแพร่บทที่สร้างทันที (ค่าเริ่มต้น: ยังไม่เผยแพร่)
        </label>
      </div>

      <div>
        <Label htmlFor="split-price-overrides" className="mb-1 block text-sm">
          ราคาเฉพาะบท (ถ้ามี) - บรรทัดละ "เลขบท: ราคา" เช่น 1: 0
        </Label>
        <textarea
          id="split-price-overrides"
          value={overridesText}
          onChange={(e) => setOverridesText(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder={"1: 0\n10: 9.50"}
        />
        {overridesError && <p className="text-xs text-red-600 mt-1">{overridesError}</p>}
      </div>

      <Button
        onClick={runPreview}
        disabled={!selectedId || isPreviewing || overridesError != null}
        variant="outline"
        className="w-full"
      >
        {isPreviewing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
        ตรวจผลการแบ่งบท (Preview)
      </Button>

      {preview && (
        <div className="space-y-3" data-testid="package-split-preview">
          <p className="text-sm">
            แพ็ก {preview.episodeNumber} · พบ {preview.split.chapterCount} บท · สร้างใหม่ {preview.counts.create} · มีอยู่แล้ว{" "}
            {preview.counts.keep} · ขัดแย้ง {preview.counts.conflict}
          </p>
          {preview.issues.length > 0 && (
            <div className="p-3 bg-red-50 border border-red-200 rounded max-h-48 overflow-y-auto">
              {preview.issues.map((issue: any, idx: number) => (
                <p key={idx} className="text-sm text-red-800">
                  {issue.lineNumber ? `บรรทัด ${issue.lineNumber}: ` : ""}
                  {issue.message}
                </p>
              ))}
            </div>
          )}
          {preview.warnings.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded">
              {preview.warnings.map((w: string, idx: number) => (
                <p key={idx} className="text-sm text-amber-800">
                  {w}
                </p>
              ))}
            </div>
          )}
          {preview.rows.length > 0 && (
            <div className="border rounded max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left p-2">บท</th>
                    <th className="text-left p-2">ชื่อบท</th>
                    <th className="text-right p-2">ตัวอักษร</th>
                    <th className="text-right p-2">ราคา</th>
                    <th className="text-right p-2">ราคาเดิม</th>
                    <th className="text-left p-2">การดำเนินการ</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row: any) => (
                    <tr key={row.chapterNumber} className="border-t">
                      <td className="p-2">{row.chapterNumber}</td>
                      <td className="p-2">
                        {row.title}
                        {row.partCount > 1 ? ` (${row.partCount} ส่วน)` : ""}
                      </td>
                      <td className="p-2 text-right">{row.bodyCharCount}</td>
                      <td className="p-2 text-right">{row.isFree ? "ฟรี" : `฿${row.price}`}</td>
                      <td className="p-2 text-right">
                        {row.existingPrice == null ? "-" : row.existingIsFree ? "ฟรี" : `฿${row.existingPrice}`}
                      </td>
                      <td className="p-2">{ACTION_LABELS[row.action] ?? row.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {inputsDirty && (
            <p className="text-xs text-amber-600">มีการเปลี่ยนแพ็ก/ราคา/ราคาเฉพาะบท/การเผยแพร่ กรุณากดตรวจผลการแบ่งบทใหม่ก่อนยืนยัน</p>
          )}
          <Button onClick={runApply} disabled={!canApply} className="w-full">
            {applyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            ยืนยันแบ่งบท ({preview.counts.create} บทใหม่)
          </Button>
        </div>
      )}
    </Card>
  );
}

export default AdminPackageChapterSplitPanel;
