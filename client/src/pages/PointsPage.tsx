import { useEffect } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Zap, TrendingUp, TrendingDown } from "lucide-react";

export default function PointsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!user) {
      navigate("/");
    }
  }, [user, navigate]);

  // Fetch points balance and history
  const { data: pointsData, isLoading: pointsLoading } = trpc.points.balance.useQuery(undefined, { enabled: !!user });

  const { data: historyData, isLoading: historyLoading } = trpc.points.history.useQuery(undefined, { enabled: !!user });

  if (!user) {
    return null;
  }

  const balance = pointsData?.balance || "0";
  const history = Array.isArray(historyData) ? historyData : [];

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container max-w-4xl mx-auto px-4">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-slate-900 mb-2">{t("points.title")}</h1>
          <p className="text-slate-600">{t("points.subtitle")}</p>
        </div>

        {/* Points Balance Card */}
        <Card className="mb-8 p-8 bg-gradient-to-br from-blue-500 to-blue-600 text-white border-0">
          <div className="text-center">
            <p className="text-sm font-medium opacity-90 mb-2">{t("points.currentBalance")}</p>
            <p className="text-6xl font-bold mb-4">{pointsLoading ? "..." : balance}</p>
            <p className="text-sm opacity-75">{t("points.balanceDescription")}</p>
          </div>
        </Card>

        {/* Points Rules */}
        <Card className="mb-8 p-6 border border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">{t("points.rules")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <p className="text-sm font-medium text-green-900 mb-1 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" />
                {t("points.earnRate")}
              </p>
              <p className="text-2xl font-bold text-green-600">100 THB = 1 {t("points.point")}</p>
            </div>
            <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
              <p className="text-sm font-medium text-purple-900 mb-1 flex items-center gap-2">
                <Zap className="w-4 h-4" />
                {t("points.redeemRate")}
              </p>
              <p className="text-2xl font-bold text-purple-600">1 {t("points.point")} = 1 THB</p>
            </div>
          </div>
        </Card>

        {/* Points History */}
        <Card className="p-6 border border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">{t("points.history")}</h2>

          {historyLoading ? (
            <div className="text-center py-8">
              <p className="text-slate-600">{t("common.loading")}</p>
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-8">
              <TrendingDown className="w-12 h-12 mx-auto text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">{t("points.noHistory")}</p>
              <p className="text-sm text-slate-500 mt-2">Start shopping to earn points</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-4 font-semibold text-slate-900">{t("points.date")}</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-900">{t("points.type")}</th>
                    <th className="text-right py-3 px-4 font-semibold text-slate-900">{t("points.amount")}</th>
                    <th className="text-right py-3 px-4 font-semibold text-slate-900">{t("points.balance")}</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-900">{t("points.reference")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((transaction: any, idx: number) => (
                    <tr key={idx} className="border-b border-slate-200 hover:bg-slate-50">
                      <td className="py-3 px-4 text-slate-900">
                        {new Date(transaction.createdAt).toLocaleDateString()} {new Date(transaction.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${
                            transaction.type === "earn"
                              ? "bg-green-100 text-green-800"
                              : transaction.type === "redeem"
                              ? "bg-purple-100 text-purple-800"
                              : "bg-slate-100 text-slate-800"
                          }`}
                        >
                          {transaction.type === "earn" ? t("points.earned") : transaction.type === "redeem" ? t("points.redeemed") : transaction.type}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-slate-900">
                        {transaction.type === "earn" ? "+" : "-"}
                        {transaction.amount}
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-slate-900">{transaction.balanceAfter}</td>
                      <td className="py-3 px-4 text-slate-600 text-xs">
                        {transaction.referenceType === "order" && transaction.referenceId ? `Order #${transaction.referenceId}` : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Action Buttons */}
        <div className="mt-8 flex gap-4 justify-center">
          <Button onClick={() => navigate("/novels")} variant="outline">
            {t("points.browseLinkText")}
          </Button>
          <Button onClick={() => navigate("/cart")} variant="default">
            {t("points.checkoutLinkText")}
          </Button>
        </div>
      </div>
    </div>
  );
}
