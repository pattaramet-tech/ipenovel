import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { CheckCircle, XCircle, Clock, BookOpen, ShoppingCart, TrendingUp, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { StatCard, SectionHeader, StatusBadge, EmptyState } from "@/components/AdminComponents";
import AdminLayout from "@/components/AdminLayout";

export default function AdminDashboard() {
  // All hooks must be called at the top level, before any conditional returns
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState("overview");

  // Query hooks with enabled flag - they won't fetch until auth is resolved and user is admin
  const { data: pendingPayments, isLoading: paymentsLoading, refetch: refetchPayments } = trpc.admin.payments.pending.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );
  const { data: allOrders, isLoading: ordersLoading } = trpc.admin.orders.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );
  const { data: allNovels, isLoading: novelsLoading } = trpc.admin.novels.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  // Mutation hooks
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

  // Now perform auth checks after all hooks are declared
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

  // Calculate stats
  const totalOrders = allOrders?.length || 0;
  const totalNovels = allNovels?.length || 0;
  const pendingPaymentCount = pendingPayments?.length || 0;
  const approvedPaymentCount = allOrders?.filter((o: any) => o.status === "approved").length || 0;

  return (
    <AdminLayout>
      <div className="space-y-8">
        {/* Quick Stats */}
        <div>
          <SectionHeader 
            title="Dashboard Overview" 
            description="Key metrics and recent activity"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Novels"
              value={totalNovels}
              icon={BookOpen}
              color="blue"
            />
            <StatCard
              label="Total Orders"
              value={totalOrders}
              icon={ShoppingCart}
              color="green"
            />
            <StatCard
              label="Pending Payments"
              value={pendingPaymentCount}
              icon={Clock}
              color="yellow"
            />
            <StatCard
              label="Approved Payments"
              value={approvedPaymentCount}
              icon={CheckCircle}
              color="purple"
            />
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 lg:w-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="payments">
              Payments
              {pendingPaymentCount > 0 && (
                <Badge className="ml-2 bg-red-100 text-red-800">{pendingPaymentCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="recent">Recent Orders</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6 mt-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Quick Actions */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Button
                    variant="outline"
                    className="w-full justify-start h-10"
                    onClick={() => navigate("/admin/novels")}
                  >
                    <BookOpen className="w-4 h-4 mr-2" />
                    Manage Novels
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-10"
                    onClick={() => navigate("/admin/episodes")}
                  >
                    <TrendingUp className="w-4 h-4 mr-2" />
                    Manage Episodes
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-10"
                    onClick={() => navigate("/admin/payments")}
                  >
                    <AlertCircle className="w-4 h-4 mr-2" />
                    Review Payments
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-10"
                    onClick={() => navigate("/admin/settings")}
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    Settings
                  </Button>
                </CardContent>
              </Card>

              {/* System Status */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">System Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Database</span>
                    <span className="text-sm font-medium text-green-600">✓ Connected</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Auth</span>
                    <span className="text-sm font-medium text-green-600">✓ Active</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Storage</span>
                    <span className="text-sm font-medium text-green-600">✓ Ready</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">API</span>
                    <span className="text-sm font-medium text-green-600">✓ Running</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Payments Tab */}
          <TabsContent value="payments" className="space-y-4 mt-6">
            {paymentsLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-32" />
                ))}
              </div>
            ) : !pendingPayments || pendingPayments.length === 0 ? (
              <EmptyState
                icon={CheckCircle}
                title="No Pending Payments"
                description="All payments have been reviewed"
              />
            ) : (
              <div className="space-y-4">
                {pendingPayments.map((payment: any) => (
                  <Card key={payment.id} className="overflow-hidden hover:shadow-md transition-shadow">
                    <CardHeader className="pb-3 bg-slate-50">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="text-base">{payment.order?.orderNumber}</CardTitle>
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
                          </div>
                        </div>
                        <StatusBadge status="pending" />
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

          {/* Recent Orders Tab */}
          <TabsContent value="recent" className="space-y-4 mt-6">
            {ordersLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-20" />
                ))}
              </div>
            ) : !allOrders || allOrders.length === 0 ? (
              <EmptyState
                icon={ShoppingCart}
                title="No Orders"
                description="No orders found in the system"
              />
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Order</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Amount</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Items</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Status</th>
                      <th className="text-left px-4 py-3 font-semibold text-slate-700 text-sm">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allOrders.slice(0, 10).map((order: any) => (
                      <tr
                        key={order.id}
                        className="border-b hover:bg-slate-50 cursor-pointer transition-colors"
                        onClick={() => navigate(`/admin/orders/${order.id}`)}
                      >
                        <td className="px-4 py-3 font-medium text-slate-900">{order.orderNumber}</td>
                        <td className="px-4 py-3 text-slate-700">฿{parseFloat(order.totalAmount.toString()).toFixed(2)}</td>
                        <td className="px-4 py-3 text-slate-700">{order.items?.length || 0} items</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={order.status} />
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">
                          {new Date(order.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AdminLayout>
  );
}
