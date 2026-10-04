import { useEffect, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { resolveAdminAccessState } from "@/_core/hooks/adminAccess";
import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { BookOpen, Heart, ShoppingCart, Wallet } from "lucide-react";

type Period = "all" | "today" | "7d" | "30d" | "month" | "custom_month";

const periodLabels: Array<{ value: Exclude<Period, "custom_month">; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

function money(value: number) {
  return value.toLocaleString("th-TH", {
    style: "currency",
    currency: "THB",
    minimumFractionDigits: 2,
  });
}

export default function AdminAuthorAnalyticsPage() {
  const { user, loading: authLoading, authMeError } = useAuth();
  const [period, setPeriod] = useState<Period>("month");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  const shouldFetch =
    resolveAdminAccessState({ loading: authLoading, user, authMeError }) === "allowed";

  const {
    data,
    isLoading,
    refetch: refetchSummary,
  } = trpc.admin.authorAnalytics.summary.useQuery(
    {
      period,
      month: period === "custom_month" && /^\d{4}-\d{2}$/.test(month) ? month : undefined,
    },
    { enabled: shouldFetch }
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
        </div>

        {isLoading ? (
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

            <p className="text-xs text-muted-foreground">
              Revenue and purchases follow the selected period. Current Wishlists is a current-state count and is not period-filtered.
            </p>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
