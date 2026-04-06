import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { ArrowLeft, FileText, BookOpen } from "lucide-react";

export default function OrderDetailPage() {
  const { isAuthenticated } = useAuth();
  const [location, navigate] = useLocation();
  
  // Extract order ID from URL
  const orderId = parseInt(location.split("/").pop() || "0", 10);

  const { data: order, isLoading } = trpc.orders.detail.useQuery(
    { orderId },
    { enabled: isAuthenticated && orderId > 0 }
  );

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please sign in to view order details</p>
            <Button asChild>
              <a href="/login">Sign In</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-green-100 text-green-800";
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-slate-100 text-slate-800";
    }
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-green-100 text-green-800";
      case "submitted":
        return "bg-blue-100 text-blue-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-slate-100 text-slate-800";
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4">
          <Skeleton className="h-10 w-32 mb-6" />
          <div className="space-y-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-48" />
            <Skeleton className="h-32" />
          </div>
        </div>
      </div>
    );
  }

  const orderData = order?.order;

  if (!orderData) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4">
          <Button variant="ghost" onClick={() => navigate("/orders")} className="mb-6">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Orders
          </Button>
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">Order not found</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <Button variant="ghost" onClick={() => navigate("/orders")} className="mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Orders
        </Button>

        <div className="space-y-6">
          {/* Order Header */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-2xl">Order #{orderData.orderNumber}</CardTitle>
                  <div className="mt-2 space-y-1">
                    <p className="text-sm text-slate-600">
                      Created: {orderData.createdAt ? new Date(orderData.createdAt).toLocaleDateString() + " at " + new Date(orderData.createdAt).toLocaleTimeString() : "—"}
                    </p>
                    {orderData.updatedAt && new Date(orderData.updatedAt).getTime() !== new Date(orderData.createdAt).getTime() && (
                      <p className="text-xs text-slate-500">
                        Last Updated: {new Date(orderData.updatedAt).toLocaleDateString()} at {new Date(orderData.updatedAt).toLocaleTimeString()}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Badge className={getStatusColor(orderData.status)}>
                    {orderData.status}
                  </Badge>
                  <Badge className={getPaymentStatusColor(orderData.paymentStatus)}>
                    {orderData.paymentStatus}
                  </Badge>
                </div>
              </div>
            </CardHeader>
          </Card>

          {/* Order Items */}
          <Card>
            <CardHeader>
              <CardTitle>Order Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {order?.items && order.items.length > 0 ? (
                  order.items.map((item: any) => {
                    const isApproved = orderData.paymentStatus === "approved" || orderData.status === "approved";
                    const hasAccess = item.purchase || isApproved;
                    const fileUrl = item.episode?.fileUrl;

                    return (
                      <div
                        key={item.id}
                        className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border"
                      >
                        <div className="flex-1">
                          <p className="font-semibold text-slate-900">
                            {item.novel?.title || "Novel"}
                          </p>
                          <p className="text-sm text-slate-600">
                            Episode {item.episode?.episodeNumber}{item.episode?.title ? ` - ${item.episode.title}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-4">
                          <p className="font-semibold text-slate-900">
                            ฿{parseFloat(item.finalPrice.toString()).toFixed(2)}
                          </p>
                          {hasAccess && fileUrl ? (
                            <Button
                              size="sm"
                              asChild
                              className="bg-blue-600 hover:bg-blue-700 text-white"
                            >
                              <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                                <BookOpen className="w-4 h-4 mr-1" />
                                Read
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-slate-600">No items in this order</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Order Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Order Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-slate-600">Subtotal</p>
                  <p className="font-semibold">
                    ฿{parseFloat(orderData.subtotal.toString()).toFixed(2)}
                  </p>
                </div>
                {parseFloat(orderData.discountAmount.toString()) > 0 && (
                  <div className="flex items-center justify-between">
                    <p className="text-slate-600">Coupon Discount</p>
                    <p className="font-semibold text-green-600">
                      -฿{parseFloat(orderData.discountAmount.toString()).toFixed(2)}
                    </p>
                  </div>
                )}
                {parseFloat(orderData.pointsDiscountAmount.toString()) > 0 && (
                  <div className="flex items-center justify-between">
                    <p className="text-slate-600">Points Discount</p>
                    <p className="font-semibold text-green-600">
                      -฿{parseFloat(orderData.pointsDiscountAmount.toString()).toFixed(2)}
                    </p>
                  </div>
                )}
                <div className="border-t pt-3 flex items-center justify-between">
                  <p className="font-semibold text-slate-900">Total Amount</p>
                  <p className="text-xl font-bold text-slate-900">
                    ฿{parseFloat(orderData.totalAmount.toString()).toFixed(2)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Payment Status */}
          {order?.payment && (
            <Card>
              <CardHeader>
                <CardTitle>Payment Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-slate-600">Payment Status</p>
                    <Badge className={getPaymentStatusColor(order.payment.status)}>
                      {order.payment.status}
                    </Badge>
                  </div>
                  {order.payment.slipImageUrl && (
                    <div className="flex items-center justify-between">
                      <p className="text-slate-600">Payment Slip</p>
                      <a
                        href={order.payment.slipImageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        View Slip
                      </a>
                    </div>
                  )}
                  {order.payment.rejectionReason && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                      <p className="font-semibold">Rejection Reason</p>
                      <p>{order.payment.rejectionReason}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Rejection Reason */}
          {orderData.status === "rejected" && orderData.notes && (
            <Card className="border-red-200 bg-red-50">
              <CardHeader>
                <CardTitle className="text-red-800">Order Rejected</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-red-700">{orderData.notes}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
