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

  const statusColor =
    order.order.status === "approved"
      ? "bg-green-100 text-green-800"
      : order.order.status === "rejected"
        ? "bg-red-100 text-red-800"
        : "bg-yellow-100 text-yellow-800";

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
          <Badge className={statusColor}>{order.order.status}</Badge>
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
              <div>
                <p className="text-sm text-muted-foreground">Payment Status</p>
                <Badge className={statusColor}>{order.payment.status}</Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Slip Submitted</p>
                <p className="font-semibold">
                  {order.payment.slipSubmittedAt
                    ? new Date(order.payment.slipSubmittedAt).toLocaleString()
                    : "Not submitted"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Reviewed At</p>
                <p className="font-semibold">
                  {order.payment.reviewedAt
                    ? new Date(order.payment.reviewedAt).toLocaleString()
                    : "Not reviewed"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Approval Source</p>
                <p className="font-semibold">
                  {(() => {
                    const src = order.payment?.approvalSource;
                    const lbl = order.payment?.approvedByLabel;
                    if (src === 'wallet') {
                      return <span className="text-blue-600">Wallet</span>;
                    } else if (src === 'auto') {
                      return <span className="text-green-600">AutoApp</span>;
                    } else if (src === 'manual') {
                      return <span className="text-purple-600">Manual</span>;
                    } else if (lbl) {
                      // Legacy record: show label with (Legacy) indicator
                      return <span className="text-slate-600">{lbl} (Legacy)</span>;
                    } else {
                      return "—";
                    }
                  })()}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Approved By</p>
                <p className="font-semibold">
                  {order.payment?.approvedByLabel || "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Approved At</p>
                <p className="font-semibold">
                  {order.payment?.approvedAt
                    ? new Date(order.payment.approvedAt).toLocaleString()
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Payment Created</p>
                <p className="font-semibold">{new Date(order.payment.createdAt).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Payment Updated</p>
                <p className="font-semibold">{new Date(order.payment.updatedAt).toLocaleString()}</p>
              </div>
              {order.payment.rejectionReason && (
                <div>
                  <p className="text-sm text-muted-foreground">Rejection Reason</p>
                  <p className="font-semibold text-red-600">{order.payment.rejectionReason}</p>
                </div>
              )}
            </div>

            {/* Slip Preview */}
            {order.payment.slipImageUrl && (
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
          </Card>
        )}

        {/* Order Items */}
        {order.items && order.items.length > 0 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold mb-4">Items</h2>
            <div className="space-y-4">
              {order.items.map((item: any) => {
                const episodeTitle = item.episode?.title || item.episodeTitle || item.title || `Episode ${item.episodeNumber}`;
                const hasFile = item.episode?.fileUrl || null;
                return (
                  <div key={item.id} className="border-b pb-4 last:border-b-0">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <p className="font-medium">{episodeTitle}</p>
                        {hasFile ? (
                          <p className="text-sm text-slate-600 mt-1">
                            ✓ File uploaded (secure download available)
                          </p>
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
            {/* Subtotal */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">ยอดรวมสินค้า</span>
              <span className="font-semibold">฿{order.order.subtotal ? parseFloat(order.order.subtotal.toString()).toFixed(2) : "0.00"}</span>
            </div>

            {/* Coupon Discount */}
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

            {/* Points Discount */}
            {order.order.pointsDiscountAmount && parseFloat(order.order.pointsDiscountAmount.toString()) > 0 && (
              <div className="flex justify-between text-red-600">
                <span className="text-muted-foreground">ส่วนลดจากคะแนน</span>
                <span className="font-semibold">-฿{parseFloat(order.order.pointsDiscountAmount.toString()).toFixed(2)}</span>
              </div>
            )}

            {/* Total Amount */}
            <div className="flex justify-between pt-3 border-t-2 border-slate-200">
              <span className="font-semibold text-lg">ยอดชำระสุทธิ</span>
              <span className="font-bold text-lg text-blue-600">฿{parseFloat(order.order.totalAmount.toString()).toFixed(2)}</span>
            </div>
          </div>
        </Card>

        {/* Actions */}
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
