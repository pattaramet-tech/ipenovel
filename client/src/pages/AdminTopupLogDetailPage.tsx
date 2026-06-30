import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, ArrowLeft, Eye, Eye as EyeOff } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

/** Method badge styling */
function methodBadge(method: string): string {
  switch (method) {
    case "slip":
      return "bg-blue-100 text-blue-800";
    case "admin_adjust":
      return "bg-purple-100 text-purple-800";
    case "promo":
      return "bg-green-100 text-green-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

/** Format date */
function formatDate(date: Date | string | undefined): string {
  if (!date) return "-";
  try {
    return new Date(date).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

/** Format money */
function formatMoney(amount: string | number | undefined | null): string {
  if (amount === undefined || amount === null) return "฿0.00";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return isNaN(num) ? "฿0.00" : `฿${num.toFixed(2)}`;
}

export default function AdminTopupLogDetailPage() {
  const [, params] = useRoute("/admin/topup-logs/:logId");
  const [, navigate] = useLocation();
  const logId = params?.logId;
  const { t } = useLanguage();
  const [showDebug, setShowDebug] = useState(false);

  // Fetch topup log detail
  const { data, isLoading } = trpc.wallet.admin.logDetail.useQuery(
    { logId: parseInt(logId || "0", 10) },
    { enabled: !!logId }
  );

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </AdminLayout>
    );
  }

  if (!data?.log) {
    return (
      <AdminLayout>
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-slate-900 mb-4">Log Not Found</h1>
          <Button onClick={() => navigate("/admin/topup-logs")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Logs
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const { log, user, createdByUser, relatedTopup, relatedTransactions, userRecentLogs } = data;

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/admin/topup-logs")}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">
                Top-up Log #{log.id}
              </h1>
              <p className="text-slate-600 mt-1">
                {formatDate(log.createdAt)}
              </p>
            </div>
          </div>
          <Badge className={`text-lg px-3 py-1 ${methodBadge(log.method)}`}>
            {log.method?.toUpperCase()}
          </Badge>
        </div>

        {/* Log Summary Card */}
        <Card className="p-6">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Log Summary</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-slate-600">Log ID</p>
              <p className="text-lg font-semibold text-slate-900">#{log.id}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Method</p>
              <Badge className={methodBadge(log.method)}>
                {log.method}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-slate-600">Reference</p>
              <p className="text-sm font-mono text-slate-900">
                {log.reference || "-"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Created At</p>
              <p className="text-sm font-mono text-slate-900">
                {formatDate(log.createdAt)}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Note</p>
              <p className="text-sm text-slate-700">
                {log.note || "-"}
              </p>
            </div>
          </div>
        </Card>

        {/* User Info Card */}
        {user && (
          <Card className="p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">User Information</h2>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <p className="text-sm text-slate-600">User ID</p>
                <p className="text-lg font-semibold text-slate-900">#{user.id}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Name</p>
                <p className="text-sm font-semibold text-slate-900">{user.name || "-"}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Email</p>
                <p className="text-sm font-mono text-slate-900">{user.email || "-"}</p>
              </div>
            </div>
          </Card>
        )}

        {/* Created By Info Card */}
        <Card className="p-6 border-slate-300">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Created By</h2>
          {createdByUser ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <p className="text-sm text-slate-600">Admin ID</p>
                <p className="text-lg font-semibold text-slate-900">#{createdByUser.id}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Name</p>
                <p className="text-sm font-semibold text-slate-900">{createdByUser.name || "-"}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Email</p>
                <p className="text-sm font-mono text-slate-900">{createdByUser.email || "-"}</p>
              </div>
            </div>
          ) : log.createdBy === 0 ? (
            <p className="text-sm text-slate-600">System / OCR Auto</p>
          ) : (
            <p className="text-sm text-slate-600">Unknown</p>
          )}
        </Card>

        {/* Amount Breakdown Card */}
        <Card className="p-6 border-blue-200 bg-blue-50">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Amount Breakdown</h2>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Amount</p>
              <p className="text-2xl font-bold text-slate-900">
                {formatMoney(log.amount)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Actual amount</p>
            </div>
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Bonus</p>
              <p className="text-2xl font-bold text-green-600">
                {formatMoney(log.bonus)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Bonus amount</p>
            </div>
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Total</p>
              <p className="text-2xl font-bold text-blue-600">
                {formatMoney(log.total)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Amount + Bonus</p>
            </div>
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Method</p>
              <Badge className={methodBadge(log.method)}>
                {log.method}
              </Badge>
            </div>
          </div>

          {log.method === "admin_adjust" && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
              <p className="text-sm text-yellow-800">
                ⚠️ This log represents a manual wallet adjustment by an admin
              </p>
            </div>
          )}
        </Card>

        {/* Related Wallet Top-up Card */}
        {relatedTopup ? (
          <Card className="p-6 border-green-200">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-slate-900">Related Wallet Top-up</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/admin/wallet-topups/${relatedTopup.id}`)}
              >
                <Eye className="w-4 h-4 mr-2" />
                View Top-up Detail
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              <div>
                <p className="text-sm text-slate-600">Top-up ID</p>
                <p className="text-lg font-semibold text-slate-900">#{relatedTopup.id}</p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Status</p>
                <Badge className="mt-1" variant="outline">
                  {relatedTopup.status}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-slate-600">Requested Amount</p>
                <p className="text-sm font-semibold text-slate-900">
                  {formatMoney(relatedTopup.requestedAmount)}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Bonus Amount</p>
                <p className="text-sm font-semibold text-green-600">
                  {formatMoney(relatedTopup.bonusAmount)}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-600">Credited Amount</p>
                <p className="text-sm font-semibold text-blue-600">
                  {formatMoney(relatedTopup.creditedAmount)}
                </p>
              </div>
              {relatedTopup.ocrDecision && (
                <div>
                  <p className="text-sm text-slate-600">OCR Decision</p>
                  <Badge className="mt-1" variant="outline">
                    {relatedTopup.ocrDecision}
                  </Badge>
                </div>
              )}
            </div>
          </Card>
        ) : (
          <Card className="p-6 border-gray-200 bg-gray-50">
            <p className="text-sm text-slate-600">No related wallet top-up found</p>
          </Card>
        )}

        {/* Related Transactions Card */}
        {relatedTransactions && relatedTransactions.length > 0 && (
          <Card className="p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Related Wallet Transactions</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-2 px-2 text-slate-600 font-semibold">ID</th>
                    <th className="text-left py-2 px-2 text-slate-600 font-semibold">Type</th>
                    <th className="text-right py-2 px-2 text-slate-600 font-semibold">Amount</th>
                    <th className="text-right py-2 px-2 text-slate-600 font-semibold">Before</th>
                    <th className="text-right py-2 px-2 text-slate-600 font-semibold">After</th>
                    <th className="text-left py-2 px-2 text-slate-600 font-semibold">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedTransactions.map((tx: any) => (
                    <tr key={tx.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 px-2 font-mono text-slate-900">#{tx.id}</td>
                      <td className="py-2 px-2 text-slate-900">{tx.type}</td>
                      <td className="py-2 px-2 text-right font-semibold text-slate-900">
                        {formatMoney(tx.amount)}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-600">
                        {formatMoney(tx.balanceBefore)}
                      </td>
                      <td className="py-2 px-2 text-right text-slate-600">
                        {formatMoney(tx.balanceAfter)}
                      </td>
                      <td className="py-2 px-2 text-slate-600 font-mono text-xs">
                        {tx.referenceType} #{tx.referenceId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* User Recent Logs Card */}
        {userRecentLogs && userRecentLogs.length > 0 && (
          <Card className="p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">User Recent Logs</h2>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {userRecentLogs.map((recentLog: any) => (
                <div
                  key={recentLog.id}
                  className="flex items-center justify-between p-3 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer"
                  onClick={() => {
                    if (recentLog.id !== log.id) {
                      navigate(`/admin/topup-logs/${recentLog.id}`);
                    }
                  }}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-slate-900">#{recentLog.id}</p>
                      <Badge className={methodBadge(recentLog.method)}>
                        {recentLog.method}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {formatDate(recentLog.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-slate-900">
                      {formatMoney(recentLog.total)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatMoney(recentLog.amount)} + {formatMoney(recentLog.bonus)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Debug Section */}
        <Card className="p-6 border-gray-300 bg-gray-50">
          <button
            onClick={() => setShowDebug(!showDebug)}
            className="flex items-center gap-2 text-sm font-semibold text-slate-700 hover:text-slate-900"
          >
            {showDebug ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            {showDebug ? "Hide" : "Show"} Debug Info
          </button>
          {showDebug && (
            <pre className="mt-4 p-3 bg-slate-900 text-slate-100 text-xs rounded overflow-x-auto max-h-48">
              {JSON.stringify(
                {
                  log: {
                    id: log.id,
                    userId: log.userId,
                    amount: log.amount,
                    bonus: log.bonus,
                    total: log.total,
                    method: log.method,
                    reference: log.reference,
                    createdAt: log.createdAt,
                  },
                  relatedTopup: relatedTopup
                    ? {
                        id: relatedTopup.id,
                        status: relatedTopup.status,
                        requestedAmount: relatedTopup.requestedAmount,
                        creditedAmount: relatedTopup.creditedAmount,
                      }
                    : null,
                  transactionCount: relatedTransactions?.length || 0,
                },
                null,
                2
              )}
            </pre>
          )}
        </Card>
      </div>
    </AdminLayout>
  );
}
