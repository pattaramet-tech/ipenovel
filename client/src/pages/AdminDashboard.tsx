import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { CheckCircle, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export default function AdminDashboard() {
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState("payments");

  if (!isAuthenticated || user?.role !== "admin") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Admin access required</p>
            <Button asChild>
              <a href="/">Go Home</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { data: pendingPayments, isLoading: paymentsLoading, refetch: refetchPayments } = trpc.admin.payments.pending.useQuery();
  const { data: allOrders, isLoading: ordersLoading } = trpc.admin.orders.list.useQuery();

  const approveMutation = trpc.admin.payments.approve.useMutation({
    onSuccess: () => {
      toast.success("Payment approved!");
      refetchPayments();
    },
    onError: () => {
      toast.error("Failed to approve payment");
    },
  });

  const rejectMutation = trpc.admin.payments.reject.useMutation({
    onSuccess: () => {
      toast.success("Payment rejected");
      refetchPayments();
    },
    onError: () => {
      toast.error("Failed to reject payment");
    },
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 py-6">
        <div className="container mx-auto px-4">
          <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-slate-600 mt-2">Manage payments, orders, and content</p>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="payments">
              Payment Verification
              {pendingPayments && pendingPayments.length > 0 && (
                <Badge className="ml-2 bg-red-100 text-red-800">{pendingPayments.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="orders">All Orders</TabsTrigger>
            <TabsTrigger value="content">Content Management</TabsTrigger>
          </TabsList>

          {/* Payment Verification Tab */}
          <TabsContent value="payments" className="space-y-4">
            <div className="grid md:grid-cols-3 gap-4 mb-6">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-center">
                    <Clock className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
                    <p className="text-2xl font-bold">{pendingPayments?.length || 0}</p>
                    <p className="text-sm text-slate-600">Pending</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {paymentsLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-32" />
                ))}
              </div>
            ) : !pendingPayments || pendingPayments.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center py-12">
                  <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-4" />
                  <p className="text-slate-600 text-lg">No pending payments</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {pendingPayments.map((payment: any) => (
                  <Card key={payment.id} className="overflow-hidden">
                    <CardHeader className="pb-3 bg-slate-50">
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-lg">{payment.order?.orderNumber}</CardTitle>
                          <p className="text-sm text-slate-600 mt-1">
                            User: {payment.order?.userId} | Amount: ฿{parseFloat(payment.order?.totalAmount.toString()).toFixed(2)}
                          </p>
                        </div>
                        <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>
                      </div>
                    </CardHeader>

                    <CardContent className="pt-6">
                      {/* Payment Slip */}
                      {payment.slipImageUrl && (
                        <div className="mb-4">
                          <p className="text-sm font-semibold mb-2">Payment Slip:</p>
                          <img
                            src={payment.slipImageUrl}
                            alt="Payment slip"
                            className="max-w-xs rounded border border-slate-200"
                          />
                        </div>
                      )}

                      {/* Order Items */}
                      <div className="mb-4">
                        <p className="text-sm font-semibold mb-2">Items:</p>
                        <ul className="text-sm text-slate-600 space-y-1">
                          {payment.items?.map((item: any) => (
                            <li key={item.id}>
                              • Episode {item.episodeId} - ฿{parseFloat(item.finalPrice.toString()).toFixed(2)}
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
                          onClick={() => {
                            const reason = prompt("Rejection reason:");
                            if (reason) {
                              rejectMutation.mutate({ paymentId: payment.id, rejectionReason: reason });
                            }
                          }}
                          disabled={rejectMutation.isPending}
                        >
                          <XCircle className="w-4 h-4 mr-2" />
                          Reject
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Orders Tab */}
          <TabsContent value="orders" className="space-y-4">
            {ordersLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-20" />
                ))}
              </div>
            ) : !allOrders || allOrders.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center py-12">
                  <p className="text-slate-600">No orders found</p>
                </CardContent>
              </Card>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left p-3 font-semibold">Order Number</th>
                      <th className="text-left p-3 font-semibold">User ID</th>
                      <th className="text-left p-3 font-semibold">Amount</th>
                      <th className="text-left p-3 font-semibold">Items</th>
                      <th className="text-left p-3 font-semibold">Status</th>
                      <th className="text-left p-3 font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOrders.map((order: any) => (
                      <tr
                        key={order.id}
                        className="border-b hover:bg-slate-50 cursor-pointer"
                        onClick={() => navigate(`/admin/orders/${order.id}`)}
                      >
                        <td className="p-3 font-medium">{order.orderNumber}</td>
                        <td className="p-3">{order.userId || "—"}</td>
                        <td className="p-3">฿{parseFloat(order.totalAmount.toString()).toFixed(2)}</td>
                        <td className="p-3">{order.items?.length || 0} items</td>
                        <td className="p-3">
                          <Badge className={order.status === "approved" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}>
                            {order.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-sm text-slate-600">
                          {new Date(order.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* Content Management Tab */}
          <TabsContent value="content" className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => navigate("/admin/novels")}>
                <CardHeader>
                  <CardTitle>Manage Novels</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">Create, edit, and delete novels</p>
                </CardContent>
              </Card>

              <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => navigate("/admin/banners")}>
                <CardHeader>
                  <CardTitle>Manage Banners</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">Create and manage promotional banners</p>
                </CardContent>
              </Card>

              <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => navigate("/admin/coupons")}>
                <CardHeader>
                  <CardTitle>Manage Coupons</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">Create discount coupons and manage usage</p>
                </CardContent>
              </Card>

              <Card className="cursor-pointer hover:shadow-lg transition" onClick={() => navigate("/admin/settings")}>
                <CardHeader>
                  <CardTitle>Settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">Configure site settings and webhooks</p>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
