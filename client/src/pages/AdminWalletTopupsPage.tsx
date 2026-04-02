import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Loader2, CheckCircle, XCircle, Image as ImageIcon, FileText, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { SlipPreviewModal } from "@/components/SlipPreviewModal";
import AdminLayout from "@/components/AdminLayout";
import { useAuth } from "@/_core/hooks/useAuth";

export default function AdminWalletTopupsPage() {
  const { user, isAuthenticated } = useAuth();
  const [slipPreviewOpen, setSlipPreviewOpen] = useState(false);
  const [selectedSlipUrl, setSelectedSlipUrl] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingTopupId, setRejectingTopupId] = useState<number | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const { data: topups, isLoading, refetch } = trpc.wallet.admin.listPendingTopups.useQuery(
    { limit: 50, offset: 0 },
    { enabled: !!user && user.role === "admin" }
  );

  const approveMutation = trpc.wallet.admin.approveTopup.useMutation({
    onSuccess: () => {
      toast.success("Top-up approved!");
      refetch();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to approve top-up");
    },
  });

  const rejectMutation = trpc.wallet.admin.rejectTopup.useMutation({
    onSuccess: () => {
      toast.success("Top-up rejected");
      refetch();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to reject top-up");
    },
  });

  const handleSlipPreview = (slipUrl: string) => {
    setSelectedSlipUrl(slipUrl);
    setSlipPreviewOpen(true);
  };

  const isPdfSlip = (url: string): boolean => {
    return url.toLowerCase().endsWith('.pdf') || url.includes('pdf');
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please log in to access admin</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Wallet Top-up Requests</h1>
          <p className="text-slate-600 mt-1">Review and approve/reject user wallet top-up requests</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : !topups || topups.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">No pending top-up requests</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {topups.map((topup: any) => (
              <Card key={topup.id} className="overflow-hidden">
                <CardHeader className="pb-3 bg-slate-50">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">Top-up Request #{topup.id}</CardTitle>
                      <div className="mt-2 space-y-1 text-sm">
                        <p className="text-slate-700">
                          <span className="font-semibold">User:</span> {topup.user?.name || "Unknown"}
                        </p>
                        <p className="text-slate-600">
                          <span className="font-semibold">Email:</span> {topup.user?.email || "N/A"}
                        </p>
                        <p className="text-slate-600">
                          <span className="font-semibold">Requested Amount:</span> ฿{parseFloat(topup.requestedAmount.toString()).toFixed(2)}
                        </p>
                        <p className="text-slate-600">
                          <span className="font-semibold">Created:</span> {new Date(topup.createdAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <Badge className={topup.status === "pending" ? "bg-yellow-100 text-yellow-800" : topup.status === "approved" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                      {topup.status}
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="pt-6">
                  {/* Payment Slip */}
                  <div className="mb-4">
                    <p className="text-sm font-semibold mb-2">Payment Slip:</p>
                    {topup.slipImageUrl ? (
                      <div className="flex gap-2 items-start">
                        {isPdfSlip(topup.slipImageUrl) ? (
                          <div className="flex flex-col gap-2 w-full">
                            <div className="flex items-center gap-2 bg-slate-100 rounded border border-slate-300 p-3">
                              <FileText className="w-6 h-6 text-red-600" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-slate-700">PDF Payment Slip</p>
                                <p className="text-xs text-slate-600">Click to open in new tab</p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => window.open(topup.slipImageUrl, '_blank')}
                              className="w-full"
                            >
                              <ExternalLink className="w-4 h-4 mr-2" />
                              Open PDF
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2 items-start">
                            <img
                              src={topup.slipImageUrl}
                              alt="Payment slip"
                              className="max-w-xs max-h-32 rounded border border-slate-200 cursor-pointer hover:opacity-80 transition"
                              onClick={() => handleSlipPreview(topup.slipImageUrl)}
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                              }}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSlipPreview(topup.slipImageUrl)}
                            >
                              <ImageIcon className="w-4 h-4 mr-1" />
                              View Full
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="bg-slate-100 rounded border border-slate-300 p-4 text-center text-slate-600 text-sm">
                        No slip uploaded
                      </div>
                    )}
                  </div>

                  {/* Actions - only show if pending */}
                  {topup.status === "pending" && (
                    <div className="flex gap-2 pt-4 border-t">
                      <Button
                        className="flex-1"
                        onClick={() => approveMutation.mutate({ topupId: topup.id })}
                        disabled={approveMutation.isPending}
                      >
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={() => {
                          setRejectingTopupId(topup.id);
                          setRejectionReason("");
                          setRejectDialogOpen(true);
                        }}
                        disabled={rejectMutation.isPending}
                      >
                        <XCircle className="w-4 h-4 mr-2" />
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {selectedSlipUrl && (
        <SlipPreviewModal
          isOpen={slipPreviewOpen}
          onClose={() => setSlipPreviewOpen(false)}
          slipUrl={selectedSlipUrl}
        />
      )}

      {/* Rejection Reason Dialog */}
      {rejectDialogOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Reject Top-up</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Rejection Reason
                </label>
                <Input
                  type="text"
                  placeholder="Enter reason for rejection"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  disabled={rejectMutation.isPending}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setRejectDialogOpen(false)}
                  disabled={rejectMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={() => {
                    if (rejectingTopupId && rejectionReason.trim()) {
                      rejectMutation.mutate({
                        topupId: rejectingTopupId,
                        reason: rejectionReason.trim(),
                      });
                      setRejectDialogOpen(false);
                    } else {
                      toast.error("Please enter a rejection reason");
                    }
                  }}
                  disabled={rejectMutation.isPending || !rejectionReason.trim()}
                >
                  Confirm Rejection
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </AdminLayout>
  );
}
