import { useState } from "react";
import AdminLayout from "@/components/AdminLayout";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TrendingUp, DollarSign, ShoppingCart, BookOpen } from "lucide-react";

type Period = "all" | "today" | "7d" | "month";

export default function AdminAnalyticsPage() {
  const [period, setPeriod] = useState<Period>("all");

  const { data, isLoading } = trpc.admin.analytics.topSellingNovels.useQuery({
    period,
    limit: 20,
  });

  const periodLabels: Record<Period, string> = {
    all: "All Time",
    today: "Today",
    "7d": "Last 7 Days",
    month: "This Month",
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Analytics Dashboard</h1>
            <p className="text-muted-foreground mt-1">Top 20 Best-Selling Novels</p>
          </div>
        </div>

        {/* Time Period Filter */}
        <div className="flex gap-2">
          {(["all", "today", "7d", "month"] as const).map((p) => (
            <Button
              key={p}
              variant={period === p ? "default" : "outline"}
              onClick={() => setPeriod(p)}
              size="sm"
            >
              {periodLabels[p]}
            </Button>
          ))}
        </div>

        {/* Summary Stats */}
        {data?.stats && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Revenue</p>
                  <p className="text-2xl font-bold mt-2">
                    ฿{data.stats.totalRevenue.toLocaleString("th-TH", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                </div>
                <DollarSign className="w-8 h-8 text-green-500" />
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Purchases</p>
                  <p className="text-2xl font-bold mt-2">
                    {data.stats.totalPurchases.toLocaleString()}
                  </p>
                </div>
                <ShoppingCart className="w-8 h-8 text-blue-500" />
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Novels with Sales</p>
                  <p className="text-2xl font-bold mt-2">
                    {data.stats.novelCount}
                  </p>
                </div>
                <BookOpen className="w-8 h-8 text-purple-500" />
              </div>
            </Card>
          </div>
        )}

        {/* Top Selling Novels Table */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Rank</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Cover</th>
                  <th className="px-6 py-3 text-left text-sm font-semibold">Novel Title</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Revenue</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Purchases</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Episodes Sold</th>
                  <th className="px-6 py-3 text-right text-sm font-semibold">Wishlist</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                      Loading data...
                    </td>
                  </tr>
                ) : data?.novels && data.novels.length > 0 ? (
                  data.novels.map((novel: any) => (
                    <tr key={novel.novelId} className="hover:bg-muted/50 transition-colors">
                      <td className="px-6 py-4 font-semibold text-lg">
                        <div className="flex items-center gap-2">
                          {novel.rank <= 3 ? (
                            <span className={`text-xl ${
                              novel.rank === 1 ? "text-yellow-500" :
                              novel.rank === 2 ? "text-gray-400" :
                              "text-orange-600"
                            }`}>
                              {novel.rank === 1 ? "🥇" : novel.rank === 2 ? "🥈" : "🥉"}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{novel.rank}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {novel.coverImageUrl ? (
                          <img
                            src={novel.coverImageUrl}
                            alt={novel.novelTitle}
                            className="w-10 h-14 object-cover rounded"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="w-10 h-14 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                            No Image
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium">{novel.novelTitle}</p>
                          <p className="text-xs text-muted-foreground">ID: {novel.novelId}</p>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right font-semibold text-green-600">
                        ฿{novel.totalRevenue.toLocaleString("th-TH", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {novel.purchaseCount}
                      </td>
                      <td className="px-6 py-4 text-right">
                        {novel.soldEpisodesCount}
                      </td>
                      <td className="px-6 py-4 text-right">
                        ❤️ {novel.wishlistCount}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                      No sales data available for this period
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AdminLayout>
  );
}
