import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle as DialogTitleComponent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Loader2, CheckCircle, XCircle, Image as ImageIcon, AlertCircle, CheckCheckIcon, FileText, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { SlipPreviewModal } from "@/components/SlipPreviewModal";
import AdminLayout from "@/components/AdminLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { OCRResultPanel } from "@/components/OCRResultPanel";

export default function AdminPaymentsPage() {
  const { user, isAuthenticated } = useAuth();
  const [slipPreviewOpen, setSlipPreviewOpen] = useState(false);
  const [selectedSlipUrl, setSelectedSlipUrl] = useState<string | null>(null);
  const [rejectingPaymentId, setRejectingPaymentId] = useState<number | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const { data: payments, isLoading, refetch } = trpc.admin.payments.pending.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  const approveMutation = trpc.admin.payments.approve.useMutation({
    onSuccess: () => {
      toast.success("Payment approved!");
      refetch();
    },
    onError: () => {
      toast.error("Failed to approve payment");
    },
  });

  const rejectMutation = trpc.admin.payments.reject.useMutation({
    onSuccess: () => {
      toast.success("Payment rejected");
      refetch();
    },
    onError: () => {
      toast.error("Failed to reject payment");
    },
  });

  const isPdfUrl = (url: string): boolean => {
    return url.toLowerCase().split("?")[0].endsWith(".pdf");
  };

  const handleSlipPreview = (slipUrl: string) => {
    if (isPdfUrl(slipUrl)) {
      window.open(slipUrl, "_blank");
    } else {
      setSelectedSlipUrl(slipUrl);
      setSlipPreviewOpen(true);
    }
  };

  const getReasonCodeLabel = (code: string): string => {
    const labels: Record<string, string> = {
      MISSING_SHOP_NAME: "Missing shop name",
      SHOP_NAME_MISMATCH: "Shop name mismatch",
      MISSING_MERCHANT_CODE: "Missing merchant code",
      MERCHANT_CODE_MISMATCH: "Merchant code mismatch",
      MERCHANT_TRANSACTION_CODE_MISMATCH: "Transaction code mismatch",
      MISSING_AMOUNT: "Missing amount",
      AMOUNT_MISMATCH: "Amount mismatch",
      MISSING_TRANSACTION_DATE: "Missing transaction date",
      TRANSACTION_OUTSIDE_TIME_WINDOW: "Transaction outside 24-hour window",
      MISSING_REFERENCE: "Missing reference number",
      DUPLICATE_REFERENCE: "Duplicate reference number",
      LOW_CONFIDENCE: "Confidence below 85%",
      PAYMENT_ALREADY_PROCESSED: "Payment already processed",
      DATABASE_CONNECTION_FAILED: "Database error",
      PAYMENT_NOT_FOUND: "Payment not found",
      ORDER_NOT_FOUND: "Order not found",
    };
    return labels[code] || code;
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
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : !payments || payments.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">No pending payments</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {payments.map((payment: any) => {
              // Safely parse extractedData - OCRResultPanel handles parsing, so we don't need it here
              // But keep for backward compatibility if needed elsewhere
              let extractedData = null;
              if (payment.extractedData) {
                try {
                  extractedData = typeof payment.extractedData === 'string' ? JSON.parse(payment.extractedData) : payment.extractedData;
                } catch (e) {
                  console.error('Failed to parse extractedData for payment', payment.id, e);
                  extractedData = null;
                }
              }
              const isAutoApproved = payment.autoApprovedAt !== null;

              return (
                <Card key={payment.id} className="overflow-hidden">
                  <CardHeader className="pb-3 bg-slate-50">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-lg">{payment.order?.orderNumber}</CardTitle>
                        <div className="mt-2 space-y-1 text-sm">
                          <p className="text-slate-700">
                            <span className="font-semibold">Buyer:</span> {payment.user?.name || "Unknown"}
                          </p>
                          <p className="text-slate-600">
                            <span className="font-semibold">Email:</span> {payment.user?.email || "N/A"}
                          </p>
                          <p className="text-slate-600">
                            <span className="font-semibold">Amount:</span> ฿{parseFloat(payment.order?.totalAmount.toString()).toFixed(2)}
                          </p>
                          <p className="text-slate-600">
                            <span className="font-semibold">Slip Submitted:</span> {payment.slipSubmittedAt ? new Date(payment.slipSubmittedAt).toLocaleString() : "—"}
                          </p>
                          <p className="text-slate-600">
                            <span className="font-semibold">Request Created:</span> {new Date(payment.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Badge className="bg-yellow-100 text-yellow-800">Pending Review</Badge>
                        {isAutoApproved && (
                          <Badge className="bg-green-100 text-green-800 flex items-center gap-1">
                            <CheckCheckIcon className="w-3 h-3" />
                            Auto-Approved
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-6">
                    {/* OCR Result Panel - Comprehensive OCR Display */}
                    <OCRResultPanel payment={payment} />

                    {/* Additional Info */}
                    {isAutoApproved && payment.autoApprovedAt && (
                      <div className="mb-4 p-3 bg-green-50 rounded border border-green-200">
                        <p className="text-sm font-semibold mb-1 text-green-900">Auto-Approved</p>
                        <p className="text-xs text-green-700">
                          {new Date(payment.autoApprovedAt).toLocaleString()}
                        </p>
                      </div>
                    )}

                    {/* Linked Order/Payment */}
                    {(payment.linkedOrderId || payment.linkedPaymentId) && (
                      <div className="mb-4 p-3 bg-slate-50 rounded border border-slate-200">
                        <p className="text-sm font-semibold mb-2">Linked Records:</p>
                        <div className="space-y-1 text-xs text-slate-600">
                          {payment.linkedOrderId && (
                            <p><span className="font-semibold">Order ID:</span> {payment.linkedOrderId}</p>
                          )}
                          {payment.linkedPaymentId && (
                            <p><span className="font-semibold">Payment ID:</span> {payment.linkedPaymentId}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Timestamps */}
                    <div className="mb-4 p-3 bg-slate-50 rounded border border-slate-200">
                      <p className="text-sm font-semibold mb-2">Payment Timeline:</p>
                      <div className="space-y-1 text-xs text-slate-600">
                        <p><span className="font-semibold">Created:</span> {new Date(payment.createdAt).toLocaleString()}</p>
                        {payment.slipSubmittedAt && <p><span className="font-semibold">Slip Submitted:</span> {new Date(payment.slipSubmittedAt).toLocaleString()}</p>}
                        {payment.autoApprovedAt && <p><span className="font-semibold">Auto-Approved:</span> {new Date(payment.autoApprovedAt).toLocaleString()}</p>}
                        {payment.reviewedAt && <p><span className="font-semibold">Reviewed:</span> {new Date(payment.reviewedAt).toLocaleString()}</p>}
                      </div>
                    </div>

                    {/* Payment Slip */}
                    <div className="mb-4">
                      <p className="text-sm font-semibold mb-2">Payment Slip:</p>
                      {payment.slipImageUrl ? (
                        isPdfUrl(payment.slipImageUrl) ? (
                          <div className="flex gap-2 items-start">
                            <div className="flex items-center gap-2 p-3 bg-blue-50 rounded border border-blue-200">
                              <FileText className="w-6 h-6 text-blue-600" />
                              <div>
                                <p className="text-sm font-semibold text-blue-900">PDF Document</p>
                                <p className="text-xs text-blue-700">Payment slip (PDF)</p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSlipPreview(payment.slipImageUrl)}
                            >
                              <ExternalLink className="w-4 h-4 mr-1" />
                              Open PDF
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2 items-start">
                            <img
                              src={payment.slipImageUrl}
                              alt="Payment slip"
                              className="max-w-xs max-h-32 rounded border border-slate-200 cursor-pointer hover:opacity-80 transition"
                              onClick={() => handleSlipPreview(payment.slipImageUrl)}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleSlipPreview(payment.slipImageUrl)}
                            >
                              <ImageIcon className="w-4 h-4 mr-1" />
                              View Full
                            </Button>
                          </div>
                        )
                      ) : (
                        <div className="bg-slate-100 rounded border border-slate-300 p-4 text-center text-slate-600 text-sm">
                          No slip uploaded
                        </div>
                      )}
                    </div>

                    {/* Order Items */}
                    <div className="mb-4">
                      <p className="text-sm font-semibold mb-2">Items:</p>
                      <ul className="text-sm text-slate-600 space-y-1">
                        {payment.items?.map((item: any) => (
                          <li key={item.id}>
                            • Episode {item.episode?.episodeNumber}{item.episode?.title ? ` - ${item.episode.title}` : ""} - ฿{parseFloat(item.finalPrice.toString()).toFixed(2)}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-4 border-t">
                      <Button
                        className="flex-1"
                        onClick={() => approveMutation.mutate({ paymentId: payment.id })}
                        disabled={approveMutation.isPending}
                      >
                        <CheckCircle className="w-4 h-4 mr-2" />
                        Approve
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={() => setRejectingPaymentId(payment.id)}
                        disabled={rejectMutation.isPending}
                      >
                        <XCircle className="w-4 h-4 mr-2" />
                        Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Rejection Reason Dialog */}
        <Dialog open={rejectingPaymentId !== null} onOpenChange={(open) => {
          if (!open) {
            setRejectingPaymentId(null);
            setRejectionReason("");
          }
        }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitleComponent>Reject Payment</DialogTitleComponent>
              <DialogDescription>
                Please provide a reason for rejecting this payment.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Rejection reason..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setRejectingPaymentId(null);
                setRejectionReason("");
              }}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => {
                if (rejectingPaymentId && rejectionReason.trim()) {
                  rejectMutation.mutate({ paymentId: rejectingPaymentId, rejectionReason: rejectionReason.trim() });
                  setRejectingPaymentId(null);
                  setRejectionReason("");
                }
              }}>
                Reject
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {selectedSlipUrl && (
          <SlipPreviewModal
            isOpen={slipPreviewOpen}
            onClose={() => setSlipPreviewOpen(false)}
            slipUrl={selectedSlipUrl}
          />
        )}
      </div>
    </AdminLayout>
  );
}
