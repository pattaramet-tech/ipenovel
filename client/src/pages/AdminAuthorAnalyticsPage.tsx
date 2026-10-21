import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { resolveCatalogFetchState } from "@/_core/hooks/catalogAccess";
import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { BookOpen, Heart, ShoppingCart, Users, Wallet } from "lucide-react";

// IPE-070: custom_range joins the presets — two calendar date inputs
// (start/end) replace the preset bounds while period/month stay available
// for the legacy presets.
type Period = "all" | "today" | "7d" | "30d" | "month" | "custom_month" | "custom_range";

const periodLabels: Array<{ value: Exclude<Period, "custom_month">; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
  { value: "custom_range", label: "Custom range" },
];

function money(value: number) {
  return value.toLocaleString("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 2,
  });
}

// Client-side mirror of the server's strict YYYY-MM-DD validation: JS Date
// silently normalizes impossible dates (2024-02-30 → March), so each part
// is re-checked against a UTC probe. The server re-validates everything.
function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

export default function AdminAuthorAnalyticsPage() {
  const { user, loading: authLoading, authMeError } = useAuth();
  const isAdmin = user?.role === "admin";
  const [period, setPeriod] = useState<Period>("month");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  // IPE-070: admin-only cross-author selector. "all" shows the grouped
  // report; a number drills into one author's per-novel detail. Author-role
  // users never see this control and never send a target id — their scope
  // is derived server-side from the session.
  const [selectedAuthor, setSelectedAuthor] = useState<"all" | number>("all");

  const shouldFetch =
    resolveCatalogFetchState({ loading: authLoading, user, authMeError }) === "allowed";

  const customRangeActive = period === "custom_range";
  const customRangeReady =
    customRangeActive && isValidYmd(rangeStart) && isValidYmd(rangeEnd) && rangeStart <= rangeEnd;
  const customRangeInvalid =
    customRangeActive &&
    (!isValidYmd(rangeStart) || !isValidYmd(rangeEnd) || rangeStart > rangeEnd);
  // Both bounds are only sent as a complete, locally-valid pair; the server
  // re-validates as real Bangkok calendar days and rejects bad ranges.
  const dateInput = customRangeReady
    ? { startDate: rangeStart, endDate: rangeEnd }
    : { startDate: undefined, endDate: undefined };
  const monthInput = period === "custom_month" && /^\d{4}-\d{2}$/.test(month) ? month : undefined;
  const rangeGateOpen = !customRangeActive || customRangeReady;

  // Self-scoped Author sales (author-role view). Identity comes from the
  // session server-side; the client never sends an author id here.
  const {
    data,
    isLoading,
    isError,
    error: summaryError,
    refetch: refetchSummary,
  } = trpc.admin.authorAnalytics.summary.useQuery(
    {
      period,
      month: monthInput,
      startDate: dateInput.startDate,
      endDate: dateInput.endDate,
    },
    { enabled: shouldFetch && !isAdmin && rangeGateOpen }
  );

  // IPE-070: admin cross-author report — grouped by novel owner id, with a
  // per-author drill-down for the selected author.
  const authorsReportQuery = trpc.admin.authorSales.authors.useQuery(
    {
      period,
      month: monthInput,
      startDate: dateInput.startDate,
      endDate: dateInput.endDate,
    },
    { enabled: shouldFetch && isAdmin && rangeGateOpen }
  );
  const authorDetailQuery = trpc.admin.authorSales.author.useQuery(
    {
      authorUserId: selectedAuthor as number,
      period,
      month: monthInput,
      startDate: dateInput.startDate,
      endDate: dateInput.endDate,
    },
    { enabled: shouldFetch && isAdmin && selectedAuthor !== "all" && rangeGateOpen }
  );

  // IPE-063R1: self-scoped Author profile — the identity is the signed-in
  // admin; the server derives everything, the client only edits the pen name.
  const profileQuery = trpc.admin.authorProfile.get.useQuery(undefined, {
    enabled: shouldFetch,
  });
  const [authorNameInput, setAuthorNameInput] = useState("");
  useEffect(() => {
    if (profileQuery.data) {
      setAuthorNameInput(profileQuery.data.authorName ?? "");
    }
  }, [profileQuery.data]);

  const updateProfileMutation = trpc.admin.authorProfile.update.useMutation({
    onSuccess: async (result) => {
      toast.success(
        `บันทึกชื่อ Author แล้ว — sync นิยาย ${result.updatedNovels} เรื่อง`
      );
      await Promise.all([profileQuery.refetch(), refetchSummary()]);
    },
    onError: (error) => {
      toast.error(error.message || "บันทึกชื่อ Author ไม่สำเร็จ");
    },
  });

  const trimmedAuthorNameInput = authorNameInput.trim();
  const authorNameUnchanged =
    trimmedAuthorNameInput === (profileQuery.data?.authorName ?? "");
  const canSaveAuthorName = !authorNameUnchanged && !updateProfileMutation.isPending;

  const saveAuthorName = () => {
    updateProfileMutation.mutate({
      authorName: trimmedAuthorNameInput.length > 0 ? trimmedAuthorNameInput : null,
    });
  };

  const selectedAuthorRow =
    selectedAuthor === "all"
      ? null
      : authorsReportQuery.data?.authors.find((author) => author.authorUserId === selectedAuthor) ??
        null;

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Author Analysis</h1>
          <p className="mt-1 text-muted-foreground">
            Performance for novels owned by{" "}
            {profileQuery.data?.effectiveAuthorName || data?.author.displayName || user?.name || "this Author"}
          </p>
        </div>

        {/* IPE-063R1: self-service Author profile — the pen name propagates
            to every novel owned by this account on save. */}
        <Card data-testid="author-profile">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Author Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Account</p>
              <p className="text-sm font-semibold">
                {profileQuery.data?.accountName || user?.name || "—"}
              </p>
            </div>
            <div>
              <label htmlFor="author-name-input" className="text-sm font-medium text-muted-foreground">
                Author Name / Pen Name
              </label>
              <Input
                id="author-name-input"
                value={authorNameInput}
                onChange={(event) => setAuthorNameInput(event.target.value)}
                placeholder="เว้นว่างเพื่อใช้ชื่อบัญชี"
                maxLength={255}
                className="mt-1 max-w-md"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                ชื่อ Author นี้จะแสดงกับนิยายทั้งหมดที่เป็นของบัญชีนี้
              </p>
            </div>
            <p className="text-sm">
              Effective name:{" "}
              <strong data-testid="author-effective-name">
                {profileQuery.data?.effectiveAuthorName || "—"}
              </strong>
              {profileQuery.data && !profileQuery.data.authorName && (
                <span className="text-muted-foreground"> (using account name)</span>
              )}
            </p>
            <Button
              type="button"
              onClick={saveAuthorName}
              disabled={!canSaveAuthorName}
              data-testid="save-author-name"
            >
              {updateProfileMutation.isPending ? "Saving…" : "Save Author Name"}
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          {periodLabels.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={period === value ? "default" : "outline"}
              onClick={() => setPeriod(value)}
              data-testid={`period-${value}`}
            >
              {label}
            </Button>
          ))}
          <Input
            type="month"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              setPeriod("custom_month");
            }}
            className="h-9 w-[160px]"
            aria-label="Select author analytics month"
          />
          {customRangeActive && (
            <div className="flex flex-wrap items-center gap-2" data-testid="custom-range-inputs">
              <Input
                type="date"
                value={rangeStart}
                onChange={(event) => setRangeStart(event.target.value)}
                className="h-9 w-[160px]"
                aria-label="Custom range start date"
                data-testid="custom-range-start"
              />
              <span className="text-sm text-muted-foreground">ถึง</span>
              <Input
                type="date"
                value={rangeEnd}
                onChange={(event) => setRangeEnd(event.target.value)}
                className="h-9 w-[160px]"
                aria-label="Custom range end date"
                data-testid="custom-range-end"
              />
            </div>
          )}
        </div>
        {customRangeInvalid && (
          <p className="text-sm text-destructive" data-testid="custom-range-invalid">
            ช่วงวันที่ไม่ถูกต้อง — ต้องเป็นวันปฏิทินจริง (YYYY-MM-DD) และวันเริ่มต้นต้องไม่อยู่หลังวันสิ้นสุด
          </p>
        )}

        {/* IPE-070: admin-only cross-author selector. The options come from
            the grouped report; each row stays keyed by owner id so shared
            pen names never merge. */}
        {isAdmin && (
          <Card data-testid="author-sales-selector">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="h-4 w-4" /> Sales by Author
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Select
                value={selectedAuthor === "all" ? "all" : String(selectedAuthor)}
                onValueChange={(value) =>
                  setSelectedAuthor(value === "all" ? "all" : Number(value))
                }
              >
                <SelectTrigger className="w-[280px]" data-testid="author-sales-select-trigger">
                  <SelectValue placeholder="เลือก Author" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="author-sales-option-all">
                    ทุก Author (ยอดรวมทั้งหมด)
                  </SelectItem>
                  {(authorsReportQuery.data?.authors ?? []).map((author) => (
                    <SelectItem
                      key={author.authorUserId}
                      value={String(author.authorUserId)}
                      data-testid={`author-sales-option-${author.authorUserId}`}
                    >
                      {author.displayName} (#{author.authorUserId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        )}

        {customRangeActive && !customRangeReady ? (
          // IPE-070: with an incomplete custom range the queries stay
          // disabled — render an explicit gate instead of falling through
          // to zero metrics that would look like a successful empty query.
          <Card data-testid="custom-range-pending" className="border-dashed">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">
                ระบุวันที่เริ่มต้นและวันสิ้นสุดให้ครบถ้วนเพื่อโหลดยอดขายตามช่วงวันที่เลือก
              </p>
            </CardContent>
          </Card>
        ) : isAdmin && selectedAuthor === "all" ? (
          authorsReportQuery.isError ? (
            <Card data-testid="author-sales-authors-error" className="border-destructive bg-destructive/5">
              <CardContent className="space-y-3 p-5">
                <p className="font-medium text-destructive">โหลดยอดขายแยกตาม Author ไม่สำเร็จ</p>
                <p className="text-sm text-muted-foreground">
                  {authorsReportQuery.error instanceof Error
                    ? authorsReportQuery.error.message
                    : "เกิดข้อผิดพลาดชั่วคราว — ระบบไม่สามารถอ่านข้อมูลได้ในขณะนี้"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => authorsReportQuery.refetch()}
                  data-testid="author-sales-authors-retry"
                >
                  ลองใหม่
                </Button>
              </CardContent>
            </Card>
          ) : authorsReportQuery.isLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-28 rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-lg" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <Wallet className="h-4 w-4" /> Total Revenue
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {money(authorsReportQuery.data?.totals.totalRevenue ?? 0)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <ShoppingCart className="h-4 w-4" /> Purchases
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorsReportQuery.data?.totals.totalPurchases ?? 0}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <Users className="h-4 w-4" /> Authors
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorsReportQuery.data?.totals.totalAuthors ?? 0}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <BookOpen className="h-4 w-4" /> Novels
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorsReportQuery.data?.totals.totalNovels ?? 0}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Sales channels</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">Order / payment</p>
                    <p className="mt-1 text-xl font-semibold">
                      {money(authorsReportQuery.data?.totals.salesChannels.orderRevenue ?? 0)}
                    </p>
                    <p className="text-sm">
                      {authorsReportQuery.data?.totals.salesChannels.orderPurchases ?? 0} purchases
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">Wallet direct</p>
                    <p className="mt-1 text-xl font-semibold">
                      {money(authorsReportQuery.data?.totals.salesChannels.walletRevenue ?? 0)}
                    </p>
                    <p className="text-sm">
                      {authorsReportQuery.data?.totals.salesChannels.walletPurchases ?? 0} purchases
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Sales by author</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">Author</th>
                          <th className="px-4 py-3 text-right font-semibold">Novels</th>
                          <th className="px-4 py-3 text-right font-semibold">Order revenue</th>
                          <th className="px-4 py-3 text-right font-semibold">Wallet revenue</th>
                          <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                          <th className="px-4 py-3 text-right font-semibold">Purchases</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(authorsReportQuery.data?.authors ?? []).map((author) => (
                          <tr key={author.authorUserId}>
                            <td className="px-4 py-3 font-medium">
                              {author.displayName}{" "}
                              <span className="text-xs text-muted-foreground">#{author.authorUserId}</span>
                            </td>
                            <td className="px-4 py-3 text-right">{author.novelCount}</td>
                            <td className="px-4 py-3 text-right">{money(author.salesChannels.orderRevenue)}</td>
                            <td className="px-4 py-3 text-right">{money(author.salesChannels.walletRevenue)}</td>
                            <td className="px-4 py-3 text-right font-medium">{money(author.revenue)}</td>
                            <td className="px-4 py-3 text-right">{author.purchases}</td>
                          </tr>
                        ))}
                        {(authorsReportQuery.data?.authors ?? []).length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                              ไม่มีนิยายที่ผูกกับ Author ใดในระบบ
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <p className="text-xs text-muted-foreground">
                ยอดรวมคำนวณจากทุก Author ในตาราง (ไม่ใช่ Top-N) ตามช่วงวันที่เลือก
              </p>
            </>
          )
        ) : isAdmin && selectedAuthor !== "all" ? (
          authorDetailQuery.isError ? (
            <Card data-testid="author-sales-author-error" className="border-destructive bg-destructive/5">
              <CardContent className="space-y-3 p-5">
                <p className="font-medium text-destructive">โหลดยอดขายของ Author ที่เลือกไม่สำเร็จ</p>
                <p className="text-sm text-muted-foreground">
                  {authorDetailQuery.error instanceof Error
                    ? authorDetailQuery.error.message
                    : "เกิดข้อผิดพลาดชั่วคราว — ระบบไม่สามารถอ่านข้อมูลได้ในขณะนี้"}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => authorDetailQuery.refetch()}
                  data-testid="author-sales-author-retry"
                >
                  ลองใหม่
                </Button>
              </CardContent>
            </Card>
          ) : authorDetailQuery.isLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-28 rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-64 rounded-lg" />
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                กำลังดู: <strong>{authorDetailQuery.data?.author.displayName ?? selectedAuthorRow?.displayName ?? `#${selectedAuthor}`}</strong>
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <BookOpen className="h-4 w-4" /> Novels
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorDetailQuery.data?.totalNovels ?? 0}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <Wallet className="h-4 w-4" /> Revenue
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {money(authorDetailQuery.data?.totalRevenue ?? 0)}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <ShoppingCart className="h-4 w-4" /> Purchases
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorDetailQuery.data?.totalPurchases ?? 0}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <Heart className="h-4 w-4" /> Current Wishlists
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {authorDetailQuery.data?.currentWishlistCount ?? 0}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Sales channels</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">Order / payment</p>
                    <p className="mt-1 text-xl font-semibold">
                      {money(authorDetailQuery.data?.salesChannels.orderRevenue ?? 0)}
                    </p>
                    <p className="text-sm">
                      {authorDetailQuery.data?.salesChannels.orderPurchases ?? 0} purchases
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">Wallet direct</p>
                    <p className="mt-1 text-xl font-semibold">
                      {money(authorDetailQuery.data?.salesChannels.walletRevenue ?? 0)}
                    </p>
                    <p className="text-sm">
                      {authorDetailQuery.data?.salesChannels.walletPurchases ?? 0} purchases
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Novels of this author</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-muted/50">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold">Novel</th>
                          <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                          <th className="px-4 py-3 text-right font-semibold">Purchases</th>
                          <th className="px-4 py-3 text-right font-semibold">Current Wishlists</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(authorDetailQuery.data?.novels ?? []).map((novel) => (
                          <tr key={novel.novelId}>
                            <td className="px-4 py-3">
                              <p className="font-medium">{novel.title}</p>
                              <p className="text-xs text-muted-foreground">
                                {novel.publicationStatus} · {novel.storyStatus}
                              </p>
                            </td>
                            <td className="px-4 py-3 text-right font-medium">{money(novel.revenue)}</td>
                            <td className="px-4 py-3 text-right">{novel.purchases}</td>
                            <td className="px-4 py-3 text-right">{novel.currentWishlistCount}</td>
                          </tr>
                        ))}
                        {(authorDetailQuery.data?.novels ?? []).length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                              Author นี้ไม่มีนิยายผูกกับบัญชี
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </>
          )
        ) : isError ? (
          // IPE-063R3 (P2): a query failure is an operational error, not an
          // empty dataset — never render fake zero metrics here.
          <Card data-testid="author-analytics-error" className="border-destructive bg-destructive/5">
            <CardContent className="space-y-3 p-5">
              <p className="font-medium text-destructive">โหลดข้อมูล Author Analytics ไม่สำเร็จ</p>
              <p className="text-sm text-muted-foreground">
                {summaryError instanceof Error
                  ? summaryError.message
                  : "เกิดข้อผิดพลาดชั่วคราว — ระบบไม่สามารถอ่านข้อมูลได้ในขณะนี้"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => refetchSummary()}
                data-testid="author-analytics-retry"
              >
                ลองใหม่
              </Button>
            </CardContent>
          </Card>
        ) : isLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <BookOpen className="h-4 w-4" /> My Novels
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold">{data?.totalNovels ?? 0}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <Wallet className="h-4 w-4" /> Revenue
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold">{money(data?.totalRevenue ?? 0)}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <ShoppingCart className="h-4 w-4" /> Purchases
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold">{data?.totalPurchases ?? 0}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <Heart className="h-4 w-4" /> Current Wishlists
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold">{data?.currentWishlistCount ?? 0}</CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Sales channels</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Order / payment</p>
                  <p className="mt-1 text-xl font-semibold">{money(data?.salesChannels.orderRevenue ?? 0)}</p>
                  <p className="text-sm">{data?.salesChannels.orderPurchases ?? 0} purchases</p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-sm text-muted-foreground">Wallet direct</p>
                  <p className="mt-1 text-xl font-semibold">{money(data?.salesChannels.walletRevenue ?? 0)}</p>
                  <p className="text-sm">{data?.salesChannels.walletPurchases ?? 0} purchases</p>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>My novels</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold">Novel</th>
                        <th className="px-4 py-3 text-right font-semibold">Revenue</th>
                        <th className="px-4 py-3 text-right font-semibold">Purchases</th>
                        <th className="px-4 py-3 text-right font-semibold">Current Wishlists</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {(data?.novels ?? []).map((novel) => (
                        <tr key={novel.novelId}>
                          <td className="px-4 py-3">
                            <p className="font-medium">{novel.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {novel.publicationStatus} · {novel.storyStatus}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-right font-medium">{money(novel.revenue)}</td>
                          <td className="px-4 py-3 text-right">{novel.purchases}</td>
                          <td className="px-4 py-3 text-right">{novel.currentWishlistCount}</td>
                        </tr>
                      ))}
                      {(data?.novels ?? []).length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                            You do not have any novels assigned to this Author account yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Revenue and purchases follow the selected period. Current Wishlists is a current-state count and is not period-filtered.
          {" "}Custom range ใช้วันปฏิทินไทย (Asia/Bangkok) รวมวันเริ่มต้นและวันสิ้นสุด — เลือกวันเดียวได้ด้วยวันเริ่มเท่ากับวันสิ้นสุด
        </p>
      </div>
    </AdminLayout>
  );
}
