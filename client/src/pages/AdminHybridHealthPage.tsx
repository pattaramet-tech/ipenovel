import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, Info, Loader2, RefreshCw, Search } from "lucide-react";

/**
 * Hybrid Content Health Dashboard. Strictly read-only: no mutation buttons
 * anywhere on this page - only navigation to the Episodes/Import Episodes
 * pages where an admin can actually fix a gap. Lets an admin see, per novel
 * and per episode, exactly which ones are missing plaintext web reader
 * content vs. only having a legacy file.
 *
 * Hotfix (TiDB errno=8176 memory-limit incident): the Overview table and the
 * KPI summary cards are two independent queries now, loaded and retried
 * separately - a slow/failed summary scan can never block or break the
 * novel table. Both (plus Detail) disable react-query's default retry and
 * window-focus refetch, since a hung/erroring query retrying itself against
 * an already-overloaded database is exactly the "client retry storm" half
 * of the incident.
 */

type HealthStatus = "all" | "missing_plaintext" | "legacy_only" | "missing_both" | "has_plaintext";
type PublicationStatusFilter = "all" | "published" | "archived";
type SaleModeFilter = "all" | "chapter" | "package";
/** Sort by aggregate counts is temporarily suspended - see server/services/hybridHealthQueries.ts's OverviewSortBy docstring. */
type OverviewSortBy = "title" | "novelId";

const PAGE_SIZE = 50;
const DETAIL_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

/** Applied to every Hybrid Health query: no automatic retry (avoids piling more load on an already-struggling DB) and no refetch just because the browser tab regained focus. */
const NO_RETRY_QUERY_OPTIONS = { retry: false as const, refetchOnWindowFocus: false as const };

const STATUS_LABELS: Record<HealthStatus, string> = {
  all: "ทั้งหมด",
  missing_plaintext: "ไม่มี Plaintext",
  legacy_only: "Legacy Only",
  missing_both: "Missing Both",
  has_plaintext: "มี Plaintext",
};

const CONTENT_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  PLAINTEXT_ONLY: { label: "Plaintext Ready", className: "bg-green-100 text-green-800 border-green-200" },
  HYBRID: { label: "Hybrid", className: "bg-blue-100 text-blue-800 border-blue-200" },
  LEGACY_ONLY: { label: "Legacy Only", className: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  MISSING_BOTH: { label: "Missing Both", className: "bg-red-100 text-red-800 border-red-200" },
};

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-800 border-red-200",
  HIGH: "bg-orange-100 text-orange-800 border-orange-200",
  MEDIUM: "bg-amber-100 text-amber-800 border-amber-200",
  HEALTHY: "bg-green-100 text-green-800 border-green-200",
};

function ContentStatusBadge({ status }: { status: string }) {
  const cfg = CONTENT_STATUS_BADGE[status] ?? { label: status, className: "" };
  return <Badge className={cfg.className}>{cfg.label}</Badge>;
}

function SummaryCard({
  label,
  value,
  tone,
  isLoading,
}: {
  label: string;
  value: number | undefined;
  tone?: "default" | "warning" | "danger";
  isLoading: boolean;
}) {
  const toneClass = tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-900";
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      {isLoading || value === undefined ? (
        <Skeleton className="mt-2 h-7 w-16" />
      ) : (
        <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value.toLocaleString()}</p>
      )}
    </Card>
  );
}

function PaginationBar({
  page,
  totalPages,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2 sm:gap-4">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
        ก่อนหน้า
      </Button>
      <span className="text-sm text-slate-600">
        หน้า {page} / {totalPages} (ทั้งหมด {total.toLocaleString()} รายการ)
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
      >
        ถัดไป
      </Button>
    </div>
  );
}

export default function AdminHybridHealthPage() {
  const [, navigate] = useLocation();
  const [selectedNovelId, setSelectedNovelId] = useState<number | null>(null);

  // ---- Overview filter state ----
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<HealthStatus>("missing_plaintext");
  const [publicationStatus, setPublicationStatus] = useState<PublicationStatusFilter>("all");
  const [saleMode, setSaleMode] = useState<SaleModeFilter>("all");
  const [purchasedOnly, setPurchasedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<OverviewSortBy>("novelId");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, publicationStatus, saleMode, purchasedOnly, sortBy, sortOrder]);

  const overviewInput = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: debouncedSearch.trim() || undefined,
      status,
      publicationStatus,
      saleMode,
      purchasedOnly: purchasedOnly || undefined,
      sortBy,
      sortOrder,
    }),
    [page, debouncedSearch, status, publicationStatus, saleMode, purchasedOnly, sortBy, sortOrder]
  );

  // Novel table - its own query, independent of the summary cards below.
  const {
    data: overview,
    isLoading: isOverviewLoading,
    isError: isOverviewError,
    refetch: refetchOverview,
  } = trpc.admin.hybridHealth.overview.useQuery(overviewInput, {
    enabled: selectedNovelId === null,
    ...NO_RETRY_QUERY_OPTIONS,
  });

  // Summary cards - a separate, independently loading/failing/retryable
  // request. Never awaited by the overview query above, and never blocks it.
  const {
    data: summary,
    isLoading: isSummaryLoading,
    isError: isSummaryError,
    refetch: refetchSummary,
    isRefetching: isSummaryRefetching,
  } = trpc.admin.hybridHealth.summary.useQuery(undefined, {
    enabled: selectedNovelId === null,
    ...NO_RETRY_QUERY_OPTIONS,
  });

  // ---- Detail filter state (scoped to the currently open novel) ----
  const [detailSearch, setDetailSearch] = useState("");
  const [debouncedDetailSearch, setDebouncedDetailSearch] = useState("");
  const [detailStatus, setDetailStatus] = useState<HealthStatus>("missing_plaintext");
  const [detailPublished, setDetailPublished] = useState<"all" | "published" | "draft">("all");
  const [detailSaleMode, setDetailSaleMode] = useState<SaleModeFilter>("all");
  const [detailPurchasedOnly, setDetailPurchasedOnly] = useState(false);
  const [detailPage, setDetailPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDetailSearch(detailSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [detailSearch]);

  useEffect(() => {
    setDetailPage(1);
  }, [debouncedDetailSearch, detailStatus, detailPublished, detailSaleMode, detailPurchasedOnly, selectedNovelId]);

  const detailInput = useMemo(() => {
    if (selectedNovelId === null) return null;
    return {
      novelId: selectedNovelId,
      page: detailPage,
      pageSize: DETAIL_PAGE_SIZE,
      search: debouncedDetailSearch.trim() || undefined,
      status: detailStatus,
      isPublished: detailPublished === "all" ? undefined : detailPublished === "published",
      saleMode: detailSaleMode === "all" ? undefined : detailSaleMode,
      purchasedOnly: detailPurchasedOnly || undefined,
    };
  }, [selectedNovelId, detailPage, debouncedDetailSearch, detailStatus, detailPublished, detailSaleMode, detailPurchasedOnly]);

  const { data: detail, isLoading: isDetailLoading } = trpc.admin.hybridHealth.detail.useQuery(detailInput as any, {
    enabled: detailInput !== null,
    ...NO_RETRY_QUERY_OPTIONS,
  });

  function openDetail(novelId: number) {
    setSelectedNovelId(novelId);
    setDetailSearch("");
    setDebouncedDetailSearch("");
    setDetailStatus("missing_plaintext");
    setDetailPublished("all");
    setDetailSaleMode("all");
    setDetailPurchasedOnly(false);
    setDetailPage(1);
  }

  // ============ DETAIL VIEW ============
  if (selectedNovelId !== null) {
    const novel = detail?.novel;
    return (
      <AdminLayout>
        <div className="space-y-4">
          <Button variant="outline" size="sm" onClick={() => setSelectedNovelId(null)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            กลับไปหน้า Overview
          </Button>

          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{novel?.title ?? `Novel #${selectedNovelId}`}</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  รายการนี้เป็น read-only สำหรับตรวจสุขภาพข้อมูลเท่านั้น ไม่มีการแก้ไขข้อมูลจากหน้านี้
                </p>
                {novel && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {novel.totalEpisodes.toLocaleString()} ตอน · Plaintext {novel.plaintextCoveragePercent}% · ขาด{" "}
                    {novel.missingPlaintextCount.toLocaleString()} ตอน
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => navigate(`/admin/episodes/${selectedNovelId}`)}>
                  จัดการตอน
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/admin/import-episodes")}>
                  Import Plaintext
                </Button>
              </div>
            </div>
          </Card>

          {/* Filters */}
          <Card className="p-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="min-w-0 flex-1 sm:min-w-64">
                <Label className="text-xs mb-1 block">ค้นหา (เลขตอน/ชื่อตอน)</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={detailSearch}
                    onChange={(e) => setDetailSearch(e.target.value)}
                    placeholder="ค้นหาตอน..."
                    className="pl-10"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs mb-1 block">สถานะ</Label>
                <select
                  value={detailStatus}
                  onChange={(e) => setDetailStatus(e.target.value as HealthStatus)}
                  className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
                >
                  {(Object.keys(STATUS_LABELS) as HealthStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Published</Label>
                <select
                  value={detailPublished}
                  onChange={(e) => setDetailPublished(e.target.value as "all" | "published" | "draft")}
                  className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
                >
                  <option value="all">ทั้งหมด</option>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Sale Mode</Label>
                <select
                  value={detailSaleMode}
                  onChange={(e) => setDetailSaleMode(e.target.value as SaleModeFilter)}
                  className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
                >
                  <option value="all">ทั้งหมด</option>
                  <option value="chapter">รายบท (chapter)</option>
                  <option value="package">แพ็ก (package)</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <input
                  type="checkbox"
                  id="detailPurchasedOnly"
                  checked={detailPurchasedOnly}
                  onChange={(e) => setDetailPurchasedOnly(e.target.checked)}
                />
                <Label htmlFor="detailPurchasedOnly" className="cursor-pointer text-sm">
                  มีลูกค้าซื้อแล้วเท่านั้น
                </Label>
              </div>
            </div>
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
                    <th className="text-left py-2 px-2">ตอน</th>
                    <th className="text-left py-2 px-2">Title</th>
                    <th className="text-left py-2 px-2">saleMode</th>
                    <th className="text-left py-2 px-2">สถานะ</th>
                    <th className="text-left py-2 px-2">Published</th>
                    <th className="text-left py-2 px-2">Purchased</th>
                    <th className="text-left py-2 px-2">Priority</th>
                    <th className="text-left py-2 px-2">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {detail?.episodes.map((ep: any) => (
                    <tr key={ep.episodeId} className="border-b hover:bg-slate-50 align-top">
                      <td className="py-2 px-2 text-muted-foreground">
                        <div className="font-medium text-foreground">{ep.episodeNumber}</div>
                        <div>{ep.normalizedRange}</div>
                      </td>
                      <td className="py-2 px-2">{ep.episodeTitle}</td>
                      <td className="py-2 px-2">{ep.saleMode}</td>
                      <td className="py-2 px-2">
                        <ContentStatusBadge status={ep.contentStatus} />
                      </td>
                      <td className="py-2 px-2">
                        {ep.isPublished ? (
                          <Badge variant="outline">Published</Badge>
                        ) : (
                          <Badge variant="outline" className="bg-slate-100">
                            Draft
                          </Badge>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {ep.isPurchased ? <Badge variant="outline">Purchased</Badge> : <span className="text-muted-foreground">-</span>}
                      </td>
                      <td className="py-2 px-2">
                        <Badge className={PRIORITY_BADGE[ep.priority] ?? ""}>{ep.priority}</Badge>
                      </td>
                      <td className="py-2 px-2">
                        {ep.warnings.length === 0 ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          <div className="space-y-1">
                            {ep.warnings.map((w: any, idx: number) => (
                              <div
                                key={idx}
                                className={`flex items-start gap-1 ${w.severity === "info" ? "text-slate-500" : "text-amber-800"}`}
                              >
                                {w.severity === "info" ? (
                                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                ) : (
                                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                                )}
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
              {detail?.episodes.length === 0 && (
                <p className="text-center text-muted-foreground py-8">ไม่พบตอนที่ตรงกับเงื่อนไข</p>
              )}
              {detail && detail.total > 0 && (
                <PaginationBar page={detail.page} totalPages={detail.totalPages} total={detail.total} onPageChange={setDetailPage} />
              )}
            </Card>
          )}
        </div>
      </AdminLayout>
    );
  }

  // ============ OVERVIEW VIEW ============
  return (
    <AdminLayout>
      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="text-lg font-semibold">Hybrid Content Health - Overview</h2>
          <p className="text-xs text-muted-foreground mt-1">
            ตรวจว่านิยายเรื่องใดและตอนไหนยังไม่มี Plaintext/Web Reader Content - read-only ไม่มีการแก้ไขข้อมูล
          </p>
        </Card>

        {/* Summary Cards - independent request from the table below; a
            failure here never breaks the table. */}
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <SummaryCard label="ตอนทั้งหมด" value={summary?.totalEpisodes} isLoading={isSummaryLoading} />
            <SummaryCard label="มี Plaintext" value={summary?.plaintextCount} isLoading={isSummaryLoading} />
            <SummaryCard label="ไม่มี Plaintext" value={summary?.missingPlaintextCount} tone="warning" isLoading={isSummaryLoading} />
            <SummaryCard label="Legacy Only" value={summary?.legacyOnlyCount} tone="warning" isLoading={isSummaryLoading} />
            <SummaryCard label="Missing Both" value={summary?.missingBothCount} tone="danger" isLoading={isSummaryLoading} />
            <SummaryCard
              label="Published Missing"
              value={summary?.publishedMissingPlaintextCount}
              tone="danger"
              isLoading={isSummaryLoading}
            />
            <SummaryCard
              label="Purchased Missing"
              value={summary?.purchasedMissingPlaintextCount}
              tone="danger"
              isLoading={isSummaryLoading}
            />
          </div>

          {isSummaryError && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>คำนวณภาพรวม (Summary) ไม่สำเร็จ - ตารางนิยายด้านล่างยังใช้งานได้ตามปกติ</span>
              <Button variant="outline" size="sm" onClick={() => refetchSummary()} disabled={isSummaryRefetching}>
                {isSummaryRefetching ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                )}
                ลองคำนวณภาพรวมอีกครั้ง
              </Button>
            </div>
          )}

          {!isSummaryError && summary && (
            <p className="text-xs text-muted-foreground">
              นิยายทั้งหมด {summary.totalNovels.toLocaleString()} เรื่อง · ขาด Plaintext {summary.novelsMissingPlaintext.toLocaleString()} เรื่อง
              {summary.cached ? " · จากแคช" : ""}
              {!summary.isComplete && " · ผลบางส่วน (ยังสแกนไม่ครบ)"}
            </p>
          )}
        </div>

        {/* Filters */}
        <Card className="p-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="min-w-0 flex-1 sm:min-w-64">
              <Label className="text-xs mb-1 block">ค้นหา (ชื่อเรื่อง/Novel ID)</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหานิยาย..." className="pl-10" />
              </div>
            </div>
            <div>
              <Label className="text-xs mb-1 block">สถานะ</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as HealthStatus)}
                className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
              >
                {(Object.keys(STATUS_LABELS) as HealthStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Publication Status</Label>
              <select
                value={publicationStatus}
                onChange={(e) => setPublicationStatus(e.target.value as PublicationStatusFilter)}
                className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
              >
                <option value="all">ทั้งหมด</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">Sale Mode</Label>
              <select
                value={saleMode}
                onChange={(e) => setSaleMode(e.target.value as SaleModeFilter)}
                className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
              >
                <option value="all">ทั้งหมด</option>
                <option value="chapter">รายบท (chapter)</option>
                <option value="package">แพ็ก (package)</option>
              </select>
            </div>
            <div className="flex items-center gap-2 pb-1.5">
              <input
                type="checkbox"
                id="purchasedOnly"
                checked={purchasedOnly}
                onChange={(e) => setPurchasedOnly(e.target.checked)}
              />
              <Label htmlFor="purchasedOnly" className="cursor-pointer text-sm">
                มีลูกค้าซื้อแล้วเท่านั้น
              </Label>
            </div>
            <div>
              <Label className="text-xs mb-1 block">เรียงตาม</Label>
              <div className="flex gap-2">
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as OverviewSortBy)}
                  className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
                >
                  <option value="novelId">Novel ID</option>
                  <option value="title">ชื่อเรื่อง</option>
                </select>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
                  className="min-h-9 rounded-md border px-3 py-1.5 text-sm"
                >
                  <option value="desc">มาก → น้อย / Z → A</option>
                  <option value="asc">น้อย → มาก / A → Z</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-muted-foreground max-w-64">
                การเรียงตามจำนวนตอนจะเปิดใช้อีกครั้งหลังเพิ่ม Content Health Metadata
              </p>
            </div>
          </div>
        </Card>

        {isOverviewError ? (
          <Card className="p-8 text-center space-y-3">
            <p className="text-sm text-amber-700">โหลดรายการนิยายไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</p>
            <Button variant="outline" size="sm" onClick={() => refetchOverview()}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              ลองอีกครั้ง
            </Button>
          </Card>
        ) : isOverviewLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Card className="p-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left py-2 px-2">Novel ID</th>
                  <th className="text-left py-2 px-2">ชื่อเรื่อง</th>
                  <th className="text-left py-2 px-2">Total</th>
                  <th className="text-left py-2 px-2">Plaintext</th>
                  <th className="text-left py-2 px-2">Missing Plaintext</th>
                  <th className="text-left py-2 px-2">Legacy Only</th>
                  <th className="text-left py-2 px-2">Missing Both</th>
                  <th className="text-left py-2 px-2">Published Missing</th>
                  <th className="text-left py-2 px-2">Purchased Missing</th>
                  <th className="text-left py-2 px-2">Coverage</th>
                  <th className="text-left py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {overview?.novels.map((novel: any) => (
                  <tr key={novel.novelId} className="border-b hover:bg-slate-50">
                    <td className="py-2 px-2 text-muted-foreground">{novel.novelId}</td>
                    <td className="py-2 px-2 font-medium">{novel.title}</td>
                    <td className="py-2 px-2">{novel.totalEpisodes}</td>
                    <td className="py-2 px-2">{novel.plaintextCount}</td>
                    <td className="py-2 px-2">
                      {novel.missingPlaintextCount > 0 ? (
                        <Badge className="bg-amber-100 text-amber-800">{novel.missingPlaintextCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">{novel.legacyOnlyCount}</td>
                    <td className="py-2 px-2">
                      {novel.missingBothCount > 0 ? (
                        <Badge className="bg-red-100 text-red-800">{novel.missingBothCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {novel.publishedMissingPlaintextCount > 0 ? (
                        <Badge className="bg-red-100 text-red-800">{novel.publishedMissingPlaintextCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">
                      {novel.purchasedMissingPlaintextCount > 0 ? (
                        <Badge className="bg-red-100 text-red-800">{novel.purchasedMissingPlaintextCount}</Badge>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="py-2 px-2">{novel.plaintextCoveragePercent}%</td>
                    <td className="py-2 px-2">
                      <Button variant="outline" size="sm" onClick={() => openDetail(novel.novelId)}>
                        รายละเอียด
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overview?.novels.length === 0 && (
              <p className="text-center text-muted-foreground py-8">
                {status === "missing_plaintext" ? "ไม่มีนิยายที่ขาด Plaintext ตามเงื่อนไขนี้" : "ไม่พบนิยายที่ตรงกับเงื่อนไข"}
              </p>
            )}
            {overview && overview.total > 0 && (
              <PaginationBar page={overview.page} totalPages={overview.totalPages} total={overview.total} onPageChange={setPage} />
            )}
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
