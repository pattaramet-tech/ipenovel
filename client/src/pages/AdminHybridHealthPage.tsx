import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Loader2, ArrowLeft, AlertTriangle } from "lucide-react";

/**
 * Phase 1 - Hybrid Content Health Dashboard. Strictly read-only: no mutation
 * buttons anywhere on this page. Lets an admin see, per novel and per
 * episode, whether hybrid entitlement data (content / legacy fileUrl /
 * normalized range) looks healthy before running a ZIP import or trusting a
 * customer support report.
 */
export default function AdminHybridHealthPage() {
  const [selectedNovelId, setSelectedNovelId] = useState<number | null>(null);

  const { data: overview, isLoading: isOverviewLoading } = trpc.admin.hybridHealth.overview.useQuery();
  const { data: detail, isLoading: isDetailLoading } = trpc.admin.hybridHealth.detail.useQuery(
    { novelId: selectedNovelId! },
    { enabled: selectedNovelId !== null }
  );

  const selectedNovel = overview?.find((n: any) => n.novelId === selectedNovelId);

  if (selectedNovelId !== null) {
    return (
      <AdminLayout>
        <div className="space-y-4">
          <Button variant="outline" size="sm" onClick={() => setSelectedNovelId(null)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            กลับไปหน้า Overview
          </Button>

          <Card className="p-4">
            <h2 className="text-lg font-semibold">{selectedNovel?.title ?? `Novel #${selectedNovelId}`}</h2>
            <p className="text-xs text-muted-foreground mt-1">
              รายการนี้เป็น read-only สำหรับตรวจสุขภาพข้อมูลเท่านั้น ไม่มีการแก้ไขข้อมูลจากหน้านี้
            </p>
          </Card>

          {isDetailLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Card className="p-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left py-2 px-2">episodeId</th>
                    <th className="text-left py-2 px-2">episodeNumber</th>
                    <th className="text-left py-2 px-2">normalizedRange</th>
                    <th className="text-left py-2 px-2">Title</th>
                    <th className="text-left py-2 px-2">saleMode</th>
                    <th className="text-left py-2 px-2">Published</th>
                    <th className="text-left py-2 px-2">hasContent</th>
                    <th className="text-left py-2 px-2">hasLegacyFile</th>
                    <th className="text-left py-2 px-2">Price</th>
                    <th className="text-left py-2 px-2">sortOrder</th>
                    <th className="text-left py-2 px-2">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {detail?.map((ep: any) => (
                    <tr
                      key={ep.episodeId}
                      className={`border-b hover:bg-slate-50 ${ep.warnings.length > 0 ? "bg-amber-50/60" : ""}`}
                    >
                      <td className="py-2 px-2 text-muted-foreground">{ep.episodeId}</td>
                      <td className="py-2 px-2 font-medium">{ep.episodeNumber}</td>
                      <td className="py-2 px-2 text-muted-foreground">{ep.normalizedRange}</td>
                      <td className="py-2 px-2">{ep.episodeTitle}</td>
                      <td className="py-2 px-2">{ep.saleMode}</td>
                      <td className="py-2 px-2">{ep.isPublished ? "ใช่" : "ไม่"}</td>
                      <td className="py-2 px-2">{ep.hasContent ? "✓" : "-"}</td>
                      <td className="py-2 px-2">{ep.hasLegacyFile ? "✓" : "-"}</td>
                      <td className="py-2 px-2">฿{ep.price}</td>
                      <td className="py-2 px-2">{ep.sortOrder ?? "-"}</td>
                      <td className="py-2 px-2">
                        {ep.warnings.length === 0 ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          <div className="space-y-1">
                            {ep.warnings.map((w: any, idx: number) => (
                              <div key={idx} className="flex items-start gap-1 text-amber-800">
                                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>{w.message}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail?.length === 0 && (
                <p className="text-center text-muted-foreground py-8">นิยายเรื่องนี้ยังไม่มีตอน</p>
              )}
            </Card>
          )}
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="text-lg font-semibold">Hybrid Content Health - Overview</h2>
          <p className="text-xs text-muted-foreground mt-1">
            ภาพรวมสุขภาพข้อมูล hybrid (content / legacy fileUrl) ต่อนิยายทั้งหมด - read-only ไม่มีการแก้ไขข้อมูล
          </p>
        </Card>

        {isOverviewLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Card className="p-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left py-2 px-2">novelId</th>
                  <th className="text-left py-2 px-2">Title</th>
                  <th className="text-left py-2 px-2">Total</th>
                  <th className="text-left py-2 px-2">content</th>
                  <th className="text-left py-2 px-2">legacyFile</th>
                  <th className="text-left py-2 px-2">hybrid</th>
                  <th className="text-left py-2 px-2">missingBoth</th>
                  <th className="text-left py-2 px-2">package</th>
                  <th className="text-left py-2 px-2">chapter</th>
                  <th className="text-left py-2 px-2">dupRange</th>
                  <th className="text-left py-2 px-2">risky</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {overview?.map((novel: any) => (
                  <tr key={novel.novelId} className="border-b hover:bg-slate-50">
                    <td className="py-2 px-2 text-muted-foreground">{novel.novelId}</td>
                    <td className="py-2 px-2 font-medium">{novel.title}</td>
                    <td className="py-2 px-2">{novel.totalEpisodes}</td>
                    <td className="py-2 px-2">{novel.contentCount}</td>
                    <td className="py-2 px-2">{novel.legacyFileCount}</td>
                    <td className="py-2 px-2">{novel.hybridCount}</td>
                    <td className="py-2 px-2">
                      {novel.missingBothCount > 0 ? (
                        <Badge className="bg-red-100 text-red-800">{novel.missingBothCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">{novel.packageCount}</td>
                    <td className="py-2 px-2">{novel.chapterCount}</td>
                    <td className="py-2 px-2">
                      {novel.duplicateNormalizedRangeCount > 0 ? (
                        <Badge className="bg-amber-100 text-amber-800">{novel.duplicateNormalizedRangeCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {novel.riskyEpisodeCount > 0 ? (
                        <Badge className="bg-red-100 text-red-800">{novel.riskyEpisodeCount}</Badge>
                      ) : (
                        <Badge className="bg-green-100 text-green-800">0</Badge>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <Button variant="outline" size="sm" onClick={() => setSelectedNovelId(novel.novelId)}>
                        รายละเอียด
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overview?.length === 0 && (
              <p className="text-center text-muted-foreground py-8">ยังไม่มีนิยายในระบบ</p>
            )}
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
