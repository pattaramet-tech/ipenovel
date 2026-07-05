import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, ArrowLeft, Image as ImageIcon, FileText, ExternalLink, Eye, Info } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/** Derive a color class for a topup status string */
function topupStatusColor(status: string | undefined | null): string {
  switch (status) {
    case "approved":
      return "bg-green-100 text-green-800";
    case "rejected":
      return "bg-red-100 text-red-800";
    case "pending_review":
      return "bg-orange-100 text-orange-800";
    case "pending":
    default:
      return "bg-yellow-100 text-yellow-800";
  }
}

/** Format ISO date to readable string */
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

/** Format money with 2 decimals */
function formatMoney(amount: string | number | undefined | null): string {
  if (amount === undefined || amount === null) return "฿0.00";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  return isNaN(num) ? "฿0.00" : `฿${num.toFixed(2)}`;
}

export default function AdminWalletTopupDetailPage() {
  const [, params] = useRoute("/admin/wallet-topups/:topupId");
  const [, navigate] = useLocation();
  const topupId = params?.topupId;
  const { t } = useLanguage();

  // State for modals
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showSlipPreview, setShowSlipPreview] = useState(false);

  // Fetch topup detail
  const { data, isLoading } = trpc.wallet.admin.detail.useQuery(
    { topupId: parseInt(topupId || "0", 10) },
    { enabled: !!topupId }
  );

  // Approve mutation
  const approveMutation = trpc.wallet.admin.approveTopup.useMutation({
    onSuccess: () => {
      navigate("/admin/wallet-topups");
    },
  });

  // Reject mutation
  const rejectMutation = trpc.wallet.admin.rejectTopup.useMutation({
    onSuccess: () => {
      navigate("/admin/wallet-topups");
    },
  });

  const handleApprove = () => {
    if (!topupId) return;
    approveMutation.mutate({ topupId: parseInt(topupId, 10) });
  };

  const handleReject = () => {
    if (!topupId) return;
    rejectMutation.mutate({
      topupId: parseInt(topupId, 10),
      reason: rejectReason,
    });
  };

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </AdminLayout>
    );
  }

  if (!data?.topup) {
    return (
      <AdminLayout>
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-slate-900 mb-4">Top-up Not Found</h1>
          <Button onClick={() => navigate("/admin/wallet-topups")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to List
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const { topup, user, logs } = data;

  // Parse extracted data (OCR) if available
  let extractedData: any = null;
  if (topup.extractedData) {
    try {
      extractedData = typeof topup.extractedData === "string" ? JSON.parse(topup.extractedData) : topup.extractedData;
    } catch {
      // Extracted data is invalid JSON, skip
    }
  }

  // Parse duplicate status if available
  let duplicateStatus: any = null;
  if (topup.duplicateStatus) {
    try {
      duplicateStatus = typeof topup.duplicateStatus === "string" ? JSON.parse(topup.duplicateStatus) : topup.duplicateStatus;
    } catch {
      // Duplicate status is invalid JSON, skip
    }
  }

  const canApproveOrReject =
    topup.status === "pending" || topup.status === "pending_review";

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/admin/wallet-topups")}
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">
                Wallet Top-up #{topup.id}
              </h1>
              <p className="text-slate-600 mt-1">
                {formatDate(topup.createdAt)}
              </p>
            </div>
          </div>
          <Badge className={`text-lg px-3 py-1 ${topupStatusColor(topup.status)}`}>
            {topup.status?.toUpperCase()}
          </Badge>
        </div>

        {/* Top-up Details Card */}
        <Card className="p-6">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Top-up Details</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <div>
              <p className="text-sm text-slate-600">Top-up ID</p>
              <p className="text-lg font-semibold text-slate-900">#{topup.id}</p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Status</p>
              <Badge
                className={`mt-1 ${topupStatusColor(topup.status)}`}
                variant="outline"
              >
                {topup.status}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-slate-600">Created</p>
              <p className="text-sm font-mono text-slate-900">
                {formatDate(topup.createdAt)}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Updated</p>
              <p className="text-sm font-mono text-slate-900">
                {formatDate(topup.updatedAt)}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Approved At</p>
              <p className="text-sm font-mono text-slate-900">
                {topup.approvedAt ? formatDate(topup.approvedAt) : "-"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-600">Rejected At</p>
              <p className="text-sm font-mono text-slate-900">
                {topup.rejectedAt ? formatDate(topup.rejectedAt) : "-"}
              </p>
            </div>
          </div>
        </Card>

        {/* User Information Card */}
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

        {/* Amount Comparison Card */}
        <Card className="p-6 border-blue-200 bg-blue-50">
          <h2 className="text-xl font-bold text-slate-900 mb-4">Amount Breakdown</h2>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Requested Amount</p>
              <p className="text-2xl font-bold text-slate-900">
                {formatMoney(topup.requestedAmount)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Actual amount paid</p>
            </div>
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Bonus Amount</p>
              <p className="text-2xl font-bold text-green-600">
                {formatMoney(topup.bonusAmount)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Snapshot at approval</p>
            </div>
            <div className="p-4 bg-white rounded border border-slate-200">
              <p className="text-sm text-slate-600 mb-1">Credited Amount</p>
              <p className="text-2xl font-bold text-blue-600">
                {formatMoney(topup.creditedAmount)}
              </p>
              <p className="text-xs text-slate-500 mt-1">Snapshot at approval</p>
            </div>
            {extractedData?.amount && (
              <div className="p-4 bg-white rounded border border-slate-200">
                <p className="text-sm text-slate-600 mb-1">OCR Amount</p>
                <p className="text-2xl font-bold text-slate-900">
                  {formatMoney(extractedData.amount)}
                </p>
                <p className="text-xs text-slate-500 mt-1">Extracted from slip</p>
              </div>
            )}
          </div>

          {/* Snapshot Information */}
          <div className="mt-4 p-3 bg-white rounded border border-blue-200 flex gap-2 text-sm text-slate-700">
            <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <p>
              <span className="font-semibold">Bonus & Credited amounts are snapshots</span> captured at approval time.
              If bonus tiers are later modified, this transaction retains its historical bonus value.
            </p>
          </div>
        </Card>

        {/* Slip Preview Card */}
        {topup.slipImageUrl && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-slate-900">Slip Preview</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSlipPreview(true)}
              >
                <Eye className="w-4 h-4 mr-2" />
                View
              </Button>
            </div>
            <p className="text-sm text-slate-600">
              <ExternalLink className="w-4 h-4 inline mr-2" />
              <a
                href={topup.slipImageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Open in new tab
              </a>
            </p>
          </Card>
        )}

        {/* OCR Data Card */}
        {(topup.ocrDecision || topup.finalConfidence) && (
          <Card className="p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">OCR Data</h2>
            <div className="space-y-3">
              {topup.ocrDecision && (
                <div>
                  <p className="text-sm text-slate-600">Decision</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {topup.ocrDecision || "-"}
                  </p>
                </div>
              )}
              {topup.reviewReason && (
                <div>
                  <p className="text-sm text-slate-600">Review Reason</p>
                  <p className="text-sm font-semibold text-slate-900">
                    {topup.reviewReason || "-"}
                  </p>
                </div>
              )}
              {topup.finalConfidence !== undefined && topup.finalConfidence !== null && (
                <div>
                  <p className="text-sm text-slate-600">Confidence</p>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1 bg-slate-200 rounded-full h-2">
                      <div
                        className="bg-green-500 h-2 rounded-full"
                        style={{
                          width: `${Math.min(Number(topup.finalConfidence), 100)}%`,
                        }}
                      />
                    </div>
                    <p className="text-sm font-mono text-slate-900">
                      {Math.round(Number(topup.finalConfidence))}%
                    </p>
                  </div>
                </div>
              )}
              {extractedData?.amount && (
                <div>
                  <p className="text-sm text-slate-600">Extracted Amount</p>
                  <Badge
                    variant="outline"
                    className="bg-blue-100 text-blue-800"
                  >
                    {formatMoney(extractedData.amount)}
                  </Badge>
                </div>
              )}
              {duplicateStatus?.isDuplicate && (
                <div>
                  <p className="text-sm text-slate-600">Duplicate Status</p>
                  <Badge variant="outline" className="bg-orange-100 text-orange-800">
                    ⚠️ Potential Duplicate
                  </Badge>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Rejection Reason Card */}
        {topup.status === "rejected" && topup.rejectionReason && (
          <Card className="p-6 border-red-200 bg-red-50">
            <h2 className="text-lg font-bold text-red-900 mb-2">Rejection Reason</h2>
            <p className="text-sm text-red-800">{topup.rejectionReason}</p>
          </Card>
        )}

        {/* Audit Trail Card */}
        {logs && logs.length > 0 && (
          <Card className="p-6">
            <h2 className="text-xl font-bold text-slate-900 mb-4">Audit Trail</h2>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {logs.map((log: any, index: number) => (
                <div
                  key={index}
                  className="flex justify-between items-start pb-3 border-b border-slate-200 last:border-b-0"
                >
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-900">
                      {log.method || log.type || "Log Entry"}
                    </p>
                    <p className="text-xs text-slate-600 mt-1">
                      {log.note || log.reason || log.description || "-"}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {formatDate(log.createdAt)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-slate-900">
                      {formatMoney(log.amount)}
                    </p>
                    {log.bonus && (
                      <p className="text-xs text-green-600">
                        +{formatMoney(log.bonus)} bonus
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Actions Card */}
        {canApproveOrReject && (
          <Card className="p-6 border-blue-200">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Actions</h2>
            <div className="flex gap-3">
              <Button
                onClick={handleApprove}
                disabled={approveMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {approveMutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Approve
              </Button>
              <Button
                onClick={() => setShowRejectDialog(true)}
                disabled={rejectMutation.isPending}
                variant="destructive"
              >
                Reject
              </Button>
              <Button
                onClick={() => navigate("/admin/wallet-topups")}
                variant="outline"
              >
                Back to List
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Slip Preview Modal */}
      <Dialog open={showSlipPreview} onOpenChange={setShowSlipPreview}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Slip Preview</DialogTitle>
          </DialogHeader>
          {topup.slipImageUrl?.toLowerCase().endsWith(".pdf") ? (
            <div className="w-full h-96 bg-slate-100 flex items-center justify-center rounded border border-slate-300">
              <div className="text-center">
                <FileText className="w-12 h-12 text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-600 mb-4">PDF Document</p>
                <a
                  href={topup.slipImageUrl || ""}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline text-sm"
                >
                  Open PDF →
                </a>
              </div>
            </div>
          ) : (
            <img
              src={topup.slipImageUrl || ""}
              alt="Slip"
              className="w-full rounded border border-slate-300"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Top-up</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-semibold text-slate-900">
                Rejection Reason
              </label>
              <Textarea
                placeholder="Enter reason for rejection..."
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="mt-2"
                rows={4}
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={handleReject}
                disabled={!rejectReason.trim() || rejectMutation.isPending}
                variant="destructive"
              >
                {rejectMutation.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Confirm Reject
              </Button>
              <Button
                onClick={() => setShowRejectDialog(false)}
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
