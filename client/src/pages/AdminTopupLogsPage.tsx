import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Loader2, RefreshCw, Eye } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";

/** Strict positive-integer parse for the `?userId=` query param - never
 *  NaN, never 0, never a decimal, never a value with trailing garbage
 *  (unlike `parseInt`, which silently accepts "5abc" as 5). Mirrors
 *  AdminOrdersPage.tsx's own userId query-param validation. */
function parsePositiveIntegerQueryParam(value: string | null): number | undefined {
  if (!value) return undefined;
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

type TopupLog = {
  id: number;
  userId: number;
  userName?: string;
  userEmail?: string;
  amount: string;
  bonus: string;
  total: string;
  method: "slip" | "admin_adjust" | "promo";
  reference?: string;
  note?: string;
  createdBy?: number;
  createdByName?: string;
  createdAt: Date;
};

export default function AdminTopupLogsPage() {
  const { user, isAuthenticated } = useAuth();
  const [location, navigate] = useLocation();
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  // Read `?userId=` from the URL (e.g. navigated here from AdminUsersPage's
  // "ดูประวัติเติมเงิน" row action) - strictly a positive integer, never
  // trusted as-is otherwise. Synced into local state once on mount, same
  // "sync from URL, then let local state own it" pattern as AdminOrdersPage.
  const urlUserId = parsePositiveIntegerQueryParam(
    new URLSearchParams(location.split("?")[1] || "").get("userId")
  );

  const [userFilter, setUserFilter] = useState(urlUserId !== undefined ? String(urlUserId) : "");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    if (urlUserId !== undefined) {
      setUserFilter(String(urlUserId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlUserId]);

  // Parse date inputs
  const parsedStartDate = startDate ? new Date(startDate) : undefined;
  const parsedEndDate = endDate ? new Date(endDate) : undefined;

  // Strict positive-integer parse - never NaN, never 0, never a value with
  // trailing garbage.
  const userIdFilter = parsePositiveIntegerQueryParam(userFilter);

  const { data, isLoading, refetch } = trpc.wallet.admin.listTopupLogs.useQuery(
    {
      userId: userIdFilter && !isNaN(userIdFilter) ? userIdFilter : undefined,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      limit,
      offset,
    },
    { enabled: !!user && user.role === "admin" }
  );

  const logs = data?.logs || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  const handleReset = () => {
    setUserFilter("");
    setStartDate("");
    setEndDate("");
    setOffset(0);
    refetch();
  };

  const getMethodBadgeColor = (method: string) => {
    switch (method) {
      case "slip":
        return "bg-blue-100 text-blue-800";
      case "admin_adjust":
        return "bg-yellow-100 text-yellow-800";
      case "promo":
        return "bg-green-100 text-green-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getMethodLabel = (method: string) => {
    switch (method) {
      case "slip":
        return "Slip";
      case "admin_adjust":
        return "Admin Adjust";
      case "promo":
        return "Promo";
      default:
        return method;
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <div className="pt-6 text-center pb-6 px-6">
            <p className="text-slate-600 mb-4">Please log in to access admin</p>
          </div>
        </Card>
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <div className="pt-6 text-center pb-6 px-6">
            <p className="text-slate-600 mb-4">Admin access required</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Top-up Logs</h1>
          <p className="text-slate-600 mt-1">View all wallet top-up transactions and audit trail</p>
        </div>

        {/* Filters */}
        <Card className="p-4">
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">User ID</label>
                <Input
                  type="text"
                  placeholder="Filter by user ID"
                  value={userFilter}
                  onChange={(e) => {
                    setUserFilter(e.target.value);
                    setOffset(0);
                  }}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Start Date</label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    setOffset(0);
                  }}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">End Date</label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => {
                    setEndDate(e.target.value);
                    setOffset(0);
                  }}
                  className="w-full"
                />
              </div>

              <div className="flex items-end gap-2">
                <Button
                  onClick={() => refetch()}
                  variant="outline"
                  className="flex-1"
                  disabled={isLoading}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
                <Button
                  onClick={handleReset}
                  variant="ghost"
                  className="flex-1"
                  disabled={isLoading}
                >
                  Reset
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Loading State */}
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : logs.length === 0 ? (
          /* Empty State */
          <Card>
            <div className="pt-6 text-center pb-6 px-6 py-12">
              <p className="text-slate-600 text-lg">No top-up logs found</p>
              <p className="text-slate-500 text-sm mt-1">Try adjusting your filters</p>
            </div>
          </Card>
        ) : (
          /* Table */
          <div className="max-w-full overflow-x-auto rounded-lg border border-slate-200" role="region" aria-label="Top-up logs table" tabIndex={0}>
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-semibold text-slate-700">วันที่</th>
                  <th className="text-left p-3 font-semibold text-slate-700">ผู้ใช้</th>
                  <th className="text-left p-3 font-semibold text-slate-700">ยอดเติม</th>
                  <th className="text-left p-3 font-semibold text-slate-700">โบนัส</th>
                  <th className="text-left p-3 font-semibold text-slate-700">ยอดรวม</th>
                  <th className="text-left p-3 font-semibold text-slate-700">วิธีชำระ</th>
                  <th className="text-left p-3 font-semibold text-slate-700">อ้างอิง</th>
                  <th className="text-left p-3 font-semibold text-slate-700">หมายเหตุ</th>
                  <th className="text-left p-3 font-semibold text-slate-700">อนุมัติโดย</th>
                  <th className="text-left p-3 font-semibold text-slate-700">การกระทำ</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: TopupLog) => (
                  <tr key={log.id} className="border-b hover:bg-slate-50">
                    <td className="p-3 text-slate-600">
                      {new Date(log.createdAt).toLocaleDateString()} {new Date(log.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="p-3">
                      <div className="text-slate-900 font-medium">{log.userId}</div>
                      <div className="text-xs text-slate-500">{log.userName || "—"}</div>
                    </td>
                    <td className="p-3 text-slate-900">฿{parseFloat(log.amount).toFixed(2)}</td>
                    <td className="p-3 text-slate-900">
                      {parseFloat(log.bonus) > 0 ? `฿${parseFloat(log.bonus).toFixed(2)}` : "—"}
                    </td>
                    <td className="p-3 font-bold text-slate-900">
                      ฿{parseFloat(log.total).toFixed(2)}
                    </td>
                    <td className="p-3">
                      <Badge className={getMethodBadgeColor(log.method)}>
                        {getMethodLabel(log.method)}
                      </Badge>
                    </td>
                    <td className="p-3 text-slate-600 text-xs">{log.reference || "—"}</td>
                    <td className="p-3 text-slate-600 text-xs max-w-xs truncate" title={log.note}>
                      {log.note || "—"}
                    </td>
                    <td className="p-3 text-slate-600 text-xs">{log.createdByName || log.createdBy || "—"}</td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => navigate(`/admin/topup-logs/${log.id}`)}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {logs.length > 0 && (
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600">
              Showing {offset + 1} to {Math.min(offset + limit, total)} of {total} logs
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0 || isLoading}
                variant="outline"
              >
                Previous
              </Button>
              <div className="flex items-center gap-2 px-3">
                <span className="text-sm text-slate-600">
                  Page {currentPage} of {totalPages}
                </span>
              </div>
              <Button
                onClick={() => setOffset(offset + limit)}
                disabled={currentPage >= totalPages || isLoading}
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
