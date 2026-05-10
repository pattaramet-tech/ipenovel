import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2, ArrowLeft, Eye } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { OCRResultPanel } from "@/components/OCRResultPanel";

/** Derive a color class for a payment status string */
function paymentStatusColor(status: string | undefined | null): string {
  switch (status) {
    case "approved":
      return "bg-green-100 text-green-800";
    case "rejected":
      return "bg-red-100 text-red-800";
    case "pending_review":
      return "bg-orange-100 text-orange-800";
    case "submitted":
      return "bg-blue-100 text-blue-800";
    case "pending":
    default:
      return "bg-yellow-100 text-yellow-800";
  }
}

/** Derive a color class for an order status string */
function orderStatusColor(status: string | undefined | null): string {
  switch (status) {
    case "approved":
    case "completed":
      return "bg-green-100 text-green-800";
    case "rejected":
    case "cancelled":
      return "bg-red-100 text-red-800";
    default:
      return "bg-yellow-100 text-yellow-800";
  }
}

/** Map approvalSource to a human-readable label + badge color */
function paymentMethodBadge(
  approvalSource: string | null | undefined,
  formattedApprovalSource?: string | null,
  approvedByAdminId?: number | null,
  paymentStatus?: string | null,
  orderStatus?: string | null,
) {
  switch (approvalSource) {
    case "wallet":
      return { label: "Wallet", color: "bg-purple-100 text-purple-800" };
    case "auto":
      return { label: "OCR Auto-Approve", color: "bg-blue-100 text-blue-800" };
    case "manual":
      return { label: "Transfer (Manual)", color: "bg-green-100 text-green-800" };
    case "legacy":
      return { label: "Legacy", color: "bg-slate-100 text-slate-600" };
    default: {
      // null/undefined: infer from metadata
      const isApproved = paymentStatus === "approved" || orderStatus === "approved";
      if (isApproved && !approvedByAdminId) {
        // Approved with no admin → legacy wallet order
        return { label: "Wallet", color: "bg-purple-100 text-purple-800" };
      }
      if (approvedByAdminId) {
        return { label: "Transfer (Manual)", color: "bg-green-100 text-green-800" };
      }
      if (formattedApprovalSource && formattedApprovalSource !== "Unknown") {
        return { label: formattedApprovalSource, color: "bg-slate-100 text-slate-600" };
      }
      return { label: "—", color: "bg-slate-50 text-slate-400" };
    }
  }
}

export default function AdminOrderDetailPage() {
  const [, params] = useRoute("/admin/orders/:orderId");
  const orderId = params?.orderId;
  const { t } = useLanguage();
  const [, setLocation] = useLocation();
  const [showSlipPreview, setShowSlipPreview] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const { data: order, isLoading } = trpc.admin.orders.detail.useQuery(
    { orderId: parseInt(orderId || "0", 10) },
    { enabled: !!orderId }
  );

  const approveMutation = trpc.admin.orders.approve.useMutation({
    onSuccess: () => {
      setIsApproving(false);
      setLocation("/admin/orders");
    },
    onError: () => {
      setIsApproving(false);
    },
  });

  const rejectMutation = trpc.admin.orders.reject.useMutation({
    onSuccess: () => {
      setIsRejecting(false);
      setShowRejectDialog(false);
      setLocation("/admin/orders");
    },
    onError: () => {
      setIsRejecting(false);
    },
  });

  const handleApprove = () => {
    if (!orderId) return;
    setIsApproving(true);
    approveMutation.mutate({ orderId: parseInt(orderId, 10), reason: "" });
  };

  const handleReject = () => {
    if (!orderId) return;
    setIsRejecting(true);
    rejectMutation.mutate({ orderId: parseInt(orderId, 10), rejectionReason });
  };

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      </AdminLayout>
    );
  }

  if (!order) {
    return (
      <AdminLayout>
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">Order not found</p>
          <Button onClick={() => setLocation("/admin/orders")} className="mt-4">
            Back to Orders
          </Button>
        </Card>
      </AdminLayout>
    );
  }

  const effectiveApprovalSource = order.payment?.approvalSource ||
    (order.approvalMetadata as any)?.approvalSource;
  const effectiveAdminId = order.payment?.approvedByAdminId ||
    (order.approvalMetadata as any)?.approvedByAdminId;

  // Infer wallet: explicit wallet source OR (approved + no admin ID = legacy wallet)
  const isApproved = order.order?.status === "approved" || order.payment?.status === "approved";
  const isWalletPayment = effectiveApprovalSource === "wallet" ||
    (isApproved && !effectiveAdminId && !effectiveApprovalSource);

  const methodBadge = paymentMethodBadge(
    effectiveApprovalSource,
    order.formattedApprovalSource,
    effectiveAdminId,
    order.payment?.status,
    order.order?.status,
  );

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={() => setLocation("/admin/orders")}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold">Order {order.order.orderNumber}</h1>
          <Badge className={orderStatusColor(order.order.status)}>{order.order.status}</Badge>
        </div>

        {/* Order Details */}
        <Card className="p-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Order ID</p>
              <p className="font-semibold">{order.order.id}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">User ID</p>
              <p className="font-semibold">{order.order.userId || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Subtotal</p>
              <p className="font-semibold">฿{parseFloat(order.order.subtotal.toString()).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Discount</p>
              <p className="font-semibold">
                {parseFloat(order.order.discountAmount.toString()) > 0 || parseFloat(order.order.pointsDiscountAmount.toString()) > 0 ? (
                  <div className="space-y-1">
                    {parseFloat(order.order.discountAmount.toString()) > 0 && <div>฿{parseFloat(order.order.discountAmount.toString()).toFixed(2)}</div>}
                    {parseFloat(order.order.pointsDiscountAmount.toString()) > 0 && <div className="text-xs text-slate-500">Points: ฿{parseFloat(order.order.pointsDiscountAmount.toString()).toFixed(2)}</div>}
                  </div>
                ) : (
                  "—"
                )}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Amount</p>
              <p className="font-semibold">฿{parseFloat(order.order.totalAmount.toString()).toFixed(2)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Coupon Code</p>
              <p className="font-semibold">{order.order.couponCodeSnapshot || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Created</p>
              <p className="font-semibold">{new Date(order.order.createdAt).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Updated</p>
              <p className="font-semibold">{new Date(order.order.updatedAt).toLocaleString()}</p>
            </div>
          </div>
        </Card>

        {/* Payment Details */}
        {order.payment && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Payment Information</h2>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-sm text-muted-foreground">Payment ID</p>
                <p className="font-semibold">{order.payment.id}</p>
              </div>
              {/* Bug fix: use payment.status color, not order.status color */}
              <div>
                <p className="text-sm text-muted-foreground">Payment Status</p>
                <Badge className={paymentStatusColor(order.payment.status)}>{order.payment.status}</Badge>
              </div>
              {/* Payment Method — new field */}
              <div>
                <p className="text-sm text-muted-foreground">Payment Method</p>
                <Badge className={methodBadge.color}>{methodBadge.label}</Badge>
              </div>
              {/* Approved By — from approval metadata */}
              <div>
                <p className="text-sm text-muted-foreground">Approved By</p>
                <p className="font-semibold text-sm">
                  {(order.approvalMetadata as any)?.approvedByLabel || order.payment.approvedByLabel || "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Approved At</p>
                <p className="font-semibold">
                  {order.payment.approvedAt
                    ? new Date(order.payment.approvedAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Reviewed At</p>
                <p className="font-semibold">
                  {order.payment.reviewedAt
                    ? new Date(order.payment.reviewedAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Slip Submitted</p>
                <p className="font-semibold">
                  {isWalletPayment
                    ? "Not required (Wallet)"
                    : order.payment.slipSubmittedAt
                      ? new Date(order.payment.slipSubmittedAt).toLocaleString()
                      : "Not submitted"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Payment Created</p>
                <p className="font-semibold">{new Date(order.payment.createdAt).toLocaleString()}</p>
              </div>
              {order.payment.rejectionReason && (
                <div className="col-span-2">
                  <p className="text-sm text-muted-foreground">Rejection Reason</p>
                  <p className="font-semibold text-red-600">{order.payment.rejectionReason}</p>
                </div>
              )}
            </div>

            {/* Slip Preview — only for non-wallet payments */}
            {!isWalletPayment && order.payment.slipImageUrl && (
              <div className="mt-6">
                <p className="text-sm text-muted-foreground mb-2">Payment Slip</p>
                <div className="flex gap-2">
                  <img
                    src={order.payment.slipImageUrl}
                    alt="Payment slip"
                    className="w-32 h-32 object-cover rounded border"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowSlipPreview(true)}
                    className="h-fit"
                  >
                    <Eye className="w-4 h-4 mr-2" />
                    View Full
                  </Button>
                </div>
              </div>
            )}
            {/* Wallet: show friendly message instead of broken slip section */}
            {isWalletPayment && (
              <div className="mt-6 p-3 bg-purple-50 rounded-lg border border-purple-200">
                <p className="text-sm text-purple-700 font-medium">Wallet Payment — No slip required</p>
                <p className="text-xs text-purple-500 mt-1">This order was paid directly from the customer's wallet balance.</p>
              </div>
            )}

            {/* OCR Result Panel - Show OCR metadata if available */}
            {!isWalletPayment && order.payment && (
              <div className="mt-6">
                <OCRResultPanel payment={order.payment} />
              </div>
            )}
          </Card>
        )}

        {/* Order Items */}
        {order.items && order.items.length > 0 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Items</h2>
            <div className="space-y-4">
              {order.items.map((item: any) => {
                const episodeTitle = item.episode?.title || item.episodeTitle || item.title || `Episode ${item.episodeNumber}`;
                const fileUrl = item.episode?.fileUrl || null;
                return (
                  <div key={item.id} className="border-b pb-4 last:border-b-0">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <p className="font-medium">{episodeTitle}</p>
                        {fileUrl ? (
                          <a
                            href={fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:text-blue-800 hover:underline break-all mt-1 block"
                            title="Click to open file"
                          >
                            {fileUrl}
                          </a>
                        ) : (
                          <p className="text-sm text-muted-foreground mt-1">—</p>
                        )}
                      </div>
                      <span className="font-semibold ml-4 whitespace-nowrap">฿{item.price ? parseFloat(item.price.toString()).toFixed(2) : "0.00"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* Order Pricing Breakdown */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Order Summary</h2>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">ยอดรวมสินค้า</span>
              <span className="font-semibold">฿{order.order.subtotal ? parseFloat(order.order.subtotal.toString()).toFixed(2) : "0.00"}</span>
            </div>
            {order.order.discountAmount && parseFloat(order.order.discountAmount.toString()) > 0 && (
              <div className="flex justify-between text-red-600">
                <div>
                  <span className="text-muted-foreground">ส่วนลดคูปอง</span>
                  {order.order.couponCodeSnapshot && (
                    <p className="text-xs text-muted-foreground">โค้ดคูปอง: {order.order.couponCodeSnapshot}</p>
                  )}
                </div>
                <span className="font-semibold">-฿{parseFloat(order.order.discountAmount.toString()).toFixed(2)}</span>
              </div>
            )}
            {order.order.pointsDiscountAmount && parseFloat(order.order.pointsDiscountAmount.toString()) > 0 && (
              <div className="flex justify-between text-red-600">
                <span className="text-muted-foreground">ส่วนลดจากคะแนน</span>
                <span className="font-semibold">-฿{parseFloat(order.order.pointsDiscountAmount.toString()).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between pt-3 border-t-2 border-slate-200">
              <span className="font-semibold text-lg">ยอดชำระสุทธิ</span>
              <span className="font-bold text-lg text-blue-600">฿{parseFloat(order.order.totalAmount.toString()).toFixed(2)}</span>
            </div>
          </div>
        </Card>

        {/* Actions — only for pending orders */}
        {order.order.status === "pending" && (
          <Card className="p-6">
            <div className="flex gap-4">
              <Button
                onClick={handleApprove}
                disabled={isApproving}
                className="bg-green-600 hover:bg-green-700"
              >
                {isApproving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Approve Order
              </Button>
              <Button
                onClick={() => setShowRejectDialog(true)}
                disabled={isRejecting}
                variant="destructive"
              >
                Reject Order
              </Button>
            </div>
          </Card>
        )}
      </div>

      {/* Slip Preview Modal */}
      <Dialog open={showSlipPreview} onOpenChange={setShowSlipPreview}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Payment Slip</DialogTitle>
          </DialogHeader>
          {order.payment?.slipImageUrl && (
            <img src={order.payment.slipImageUrl} alt="Payment slip" className="w-full" />
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Rejection Reason</label>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Enter reason for rejection..."
                className="mt-2"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowRejectDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleReject}
                disabled={isRejecting || !rejectionReason.trim()}
                variant="destructive"
              >
                {isRejecting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Confirm Rejection
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
