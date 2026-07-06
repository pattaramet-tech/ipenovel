import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle as DialogTitleComponent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { CheckCircle, XCircle, Clock, BookOpen, ShoppingCart, TrendingUp, AlertCircle, Wallet, ScanLine, ArrowLeftRight, Trophy, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { StatCard, SectionHeader, StatusBadge, EmptyState } from "@/components/AdminComponents";
import AdminLayout from "@/components/AdminLayout";

export default function AdminDashboard() {
  // All hooks must be called at the top level, before any conditional returns
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [, navigate] = useLocation();
    const [rejectingPaymentId, setRejectingPaymentId] = useState<number | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [activeTab, setActiveTab] = useState("overview");

  // Check for admin session (local admin login)
  const adminSession = typeof window !== 'undefined' ? localStorage.getItem('admin-session') : null;
  const isAdminLoggedIn = adminSession !== null;
  const isAdmin = isAdminLoggedIn || (user && user.role === 'admin');
  const shouldFetchAdminData = isAdmin === true; // Ensure it's a boolean for enabled flag

  // Query hooks with enabled flag - they won't fetch until auth is resolved and user is admin
  const { data: dashboardSummary, isLoading: summaryLoading } = trpc.admin.dashboard.summary.useQuery(
    undefined,
    { enabled: shouldFetchAdminData }
  );
  const { data: pendingPayments, isLoading: paymentsLoading, refetch: refetchPayments } = trpc.admin.payments.pending.useQuery(
    undefined,
    { enabled: shouldFetchAdminData }
  );
  const { data: approvedPayments, isLoading: approvedLoading } = trpc.admin.payments.approved.useQuery(
    undefined,
    { enabled: shouldFetchAdminData }
  );
  const { data: allOrders, isLoading: ordersLoading } = trpc.admin.orders.list.useQuery(
    {},
    { enabled: shouldFetchAdminData }
  );
  const [topUsersPeriod, setTopUsersPeriod] = useState<"all" | "today" | "7d" | "30d" | "month">("all");
  const { data: topUsers, isLoading: topUsersLoading } = trpc.admin.dashboard.topUsers.useQuery(
    { period: topUsersPeriod },
    { enabled: shouldFetchAdminData }
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
  // Show loading state while auth is being resolved
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <Skeleton className="h-8 w-32 mx-auto mb-4" />
            <p className="text-slate-600 mb-4">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show access denied if not admin
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Access Denied - You do not have permission to access the admin panel</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Calculate stats from dashboard summary (source of truth)
  const totalOrders = dashboardSummary?.totalOrders || 0;
  const totalNovels = dashboardSummary?.totalNovels || 0;
  const pendingPaymentCount = dashboardSummary?.pendingPayments || 0;
  const approvedPaymentCount = dashboardSummary?.approvedPayments || 0;

  // Payment source breakdown (approved payments only)
  const walletCount = dashboardSummary?.paymentSources?.walletCount ?? 0;
  const ocrCount = dashboardSummary?.paymentSources?.ocrCount ?? 0;
  const transferCount = dashboardSummary?.paymentSources?.transferCount ?? 0;
  const unknownCount = dashboardSummary?.paymentSources?.unknownCount ?? 0;

  return (
    <AdminLayout>
      <div className="space-y-4 md:space-y-6">
        {/* Quick Stats - Mobile first grid */}
        <div>
          <SectionHeader 
            title="Dashboard Overview" 
            description="Key metrics and recent activity"
          />
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
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

        {/* Payment Source Metrics */}
        <div>
          <SectionHeader
            title="Payment Sources"
            description="Breakdown of approved payments by source"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
            <StatCard
              label="Wallet"
              value={walletCount}
              icon={Wallet}
              color="purple"
            />
            <StatCard
              label="OCR Auto-Approve"
              value={ocrCount}
              icon={ScanLine}
              color="blue"
            />
            <StatCard
              label="Transfer (Manual)"
              value={transferCount}
              icon={ArrowLeftRight}
              color="green"
            />
            {unknownCount > 0 && (
              <StatCard
                label="Unknown / Legacy"
                value={unknownCount}
                icon={AlertCircle}
                color="yellow"
              />
            )}
          </div>
        </div>

        {/* Tabs - Mobile optimized */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5 h-auto gap-1 p-1">
            <TabsTrigger value="overview" className="text-xs md:text-sm py-2">Overview</TabsTrigger>
            <TabsTrigger value="payments" className="text-xs md:text-sm py-2 flex items-center justify-center gap-1">
              <span>Pending</span>
              {pendingPaymentCount > 0 && (
                <Badge className="ml-1 bg-red-100 text-red-800 text-xs px-1.5 py-0">{pendingPaymentCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="approved" className="text-xs md:text-sm py-2">Approved</TabsTrigger>
            <TabsTrigger value="users" className="text-xs md:text-sm py-2">Top 10 ลูกค้า</TabsTrigger>
            <TabsTrigger value="recent" className="text-xs md:text-sm py-2">Recent</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-3 md:space-y-4 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
              {/* Quick Actions */}
              <Card className="p-3 md:p-4">
                <CardHeader className="p-0 mb-3">
                  <CardTitle className="text-sm md:text-base">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent className="p-0 space-y-2">
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/novels")}
                  >
                    <BookOpen className="w-3 h-3 md:w-4 md:h-4 mr-2" />
                    Manage Novels
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/episodes")}
                  >
                    <TrendingUp className="w-3 h-3 md:w-4 md:h-4 mr-2" />
                    Manage Episodes
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/import-episodes")}
                  >
<<<<<<< Updated upstream
                    <FileSpreadsheet className="w-3 h-3 md:w-4 md:h-4 mr-2" />
=======
                    <TrendingUp className="w-3 h-3 md:w-4 md:h-4 mr-2" />
>>>>>>> Stashed changes
                    Import Episodes
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/payments")}
                  >
                    <AlertCircle className="w-3 h-3 md:w-4 md:h-4 mr-2" />
                    Review Payments
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/settings")}
                  >
                    <CheckCircle className="w-3 h-3 md:w-4 md:h-4 mr-2" />
                    Settings
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-9 text-xs md:text-sm"
                    onClick={() => navigate("/admin/sports-votes")}
                  >
                    <Trophy className="w-3 h-3 md:w-4 md:h-4 mr-2" />
                    Sports Votes
                  </Button>
                </CardContent>
              </Card>

              {/* System Status */}
              <Card className="p-3 md:p-4">
                <CardHeader className="p-0 mb-3">
                  <CardTitle className="text-sm md:text-base">System Status</CardTitle>
                </CardHeader>
                <CardContent className="p-0 space-y-2">
                  <div className="flex items-center justify-between text-xs md:text-sm">
                    <span className="text-slate-600">Database</span>
                    <span className="font-medium text-green-600">✓ Connected</span>
                  </div>
                  <div className="flex items-center justify-between text-xs md:text-sm">
                    <span className="text-slate-600">Auth</span>
                    <span className="font-medium text-green-600">✓ Active</span>
                  </div>
                  <div className="flex items-center justify-between text-xs md:text-sm">
                    <span className="text-slate-600">Storage</span>
                    <span className="font-medium text-green-600">✓ Ready</span>
                  </div>
                  <div className="flex items-center justify-between text-xs md:text-sm">
                    <span className="text-slate-600">API</span>
                    <span className="font-medium text-green-600">✓ Running</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Payments Tab */}
          <TabsContent value="payments" className="space-y-2 md:space-y-3 mt-4">
            {paymentsLoading ? (
              <div className="space-y-2 md:space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-24 md:h-32" />
                ))}
              </div>
            ) : !pendingPayments || pendingPayments.length === 0 ? (
              <EmptyState
                icon={CheckCircle}
                title="No Pending Payments"
                description="All payments have been reviewed"
              />
            ) : (
              <div className="space-y-2 md:space-y-3">
                {pendingPayments.map((payment: any) => (
                  <Card key={payment.id} className="overflow-hidden hover:shadow-md transition-shadow p-3 md:p-4">
                    <div className="space-y-2 md:space-y-3">
                      {/* Header with order number and status */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-sm md:text-base text-slate-900 truncate">
                            {payment.order?.orderNumber}
                          </h3>
                        </div>
                        <StatusBadge status="pending" />
                      </div>

                      {/* Buyer info - compact */}
                      <div className="space-y-1 text-xs md:text-sm">
                        <p className="text-slate-700">
                          <span className="font-semibold">Buyer:</span> {payment.user?.name || "Unknown"}
                        </p>
                        <p className="text-slate-600 truncate">
                          <span className="font-semibold">Email:</span> {payment.user?.email || "N/A"}
                        </p>
                        <p className="text-slate-600">
                          <span className="font-semibold">Amount:</span> ฿{parseFloat(payment.order?.totalAmount.toString()).toFixed(2)}
                        </p>
                      </div>

                      {/* Approval metadata - show if available */}
                      {(payment.approvalMetadata || payment.formattedApprovalSource) && (
                        <div className="pt-2 border-t space-y-1 text-xs md:text-sm">
                          {payment.formattedApprovalSource && (
                            <p className="text-slate-700">
                              <span className="font-semibold">Approval Source:</span> {payment.formattedApprovalSource}
                            </p>
                          )}
                          {payment.approvalMetadata?.approvedByLabel && (
                            <p className="text-slate-700">
                              <span className="font-semibold">Approved By:</span> {payment.approvalMetadata.approvedByLabel}
                            </p>
                          )}
                          {payment.approvalMetadata?.approvedAt && (
                            <p className="text-slate-600">
                              <span className="font-semibold">Approved At:</span> {new Date(payment.approvalMetadata.approvedAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      )}

                      {/* Payment Slip - compact preview */}
                      {payment.slipImageUrl && (
                        <div className="pt-2 border-t">
                          <p className="text-xs font-semibold mb-1">Payment Slip:</p>
                          <img
                            src={payment.slipImageUrl}
                            alt="Payment slip"
                            className="max-w-xs max-h-32 rounded border border-slate-200"
                          />
                        </div>
                      )}

                      {/* Actions - stack on mobile */}
                      <div className="flex gap-2 pt-2 border-t flex-col sm:flex-row">
                        <Button
                          className="flex-1 h-8 md:h-9 text-xs md:text-sm"
                          onClick={() => approveMutation.mutate({ paymentId: payment.id })}
                          disabled={approveMutation.isPending}
                        >
                          <CheckCircle className="w-3 h-3 md:w-4 md:h-4 mr-1" />
                          Approve
                        </Button>
                        <Button
                          variant="destructive"
                          className="flex-1 h-8 md:h-9 text-xs md:text-sm"
                          onClick={() => setRejectingPaymentId(payment.id)}
                          disabled={rejectMutation.isPending}
                        >
                          <XCircle className="w-3 h-3 md:w-4 md:h-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Approved Payments Tab */}
          <TabsContent value="approved" className="space-y-2 md:space-y-3 mt-4">
            {approvedLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-32 w-full" />
                ))}
              </div>
            ) : !approvedPayments || approvedPayments.length === 0 ? (
              <EmptyState
                icon={CheckCircle}
                title="No approved payments"
                description="Recently approved payments will appear here"
              />
            ) : (
              <div className="space-y-2">
                {approvedPayments.map((payment: any) => (
                  <Card key={payment.id} className="overflow-hidden hover:shadow-md transition-shadow p-3 md:p-4">
                    <div className="space-y-2 md:space-y-3">
                      {/* Header with order number and status */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-sm md:text-base text-slate-900 truncate">
                            {payment.order?.orderNumber}
                          </h3>
                        </div>
                        <StatusBadge status="approved" />
                      </div>

                      {/* Buyer info - compact */}
                      <div className="space-y-1 text-xs md:text-sm">
                        <p className="text-slate-700">
                          <span className="font-semibold">Buyer:</span> {payment.user?.name || "Unknown"}
                        </p>
                        <p className="text-slate-600 truncate">
                          <span className="font-semibold">Email:</span> {payment.user?.email || "N/A"}
                        </p>
                        <p className="text-slate-600">
                          <span className="font-semibold">Amount:</span> ฿{parseFloat(payment.order?.totalAmount.toString()).toFixed(2)}
                        </p>
                      </div>

                      {/* Approval metadata - ALWAYS show for approved payments */}
                      <div className="pt-2 border-t space-y-1 text-xs md:text-sm">
                        {payment.formattedApprovalSource && (
                          <p className="text-slate-700">
                            <span className="font-semibold">Approval Source:</span> {payment.formattedApprovalSource}
                          </p>
                        )}
                        {payment.approvalMetadata?.approvedByLabel && (
                          <p className="text-slate-700">
                            <span className="font-semibold">Approved By:</span> {payment.approvalMetadata.approvedByLabel}
                          </p>
                        )}
                        {payment.approvalMetadata?.approvedAt && (
                          <p className="text-slate-600">
                            <span className="font-semibold">Approved At:</span> {new Date(payment.approvalMetadata.approvedAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Top Users Tab */}
          <TabsContent value="users" className="space-y-3 md:space-y-4 mt-4">
            {/* Title and Helper Text */}
            <div className="mb-4">
              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-1">Top 10 ลูกค้ายอดซื้อสูงสุด (อนุมัติแล้ว)</h3>
              <p className="text-xs md:text-sm text-slate-600">นับจากออเดอร์ที่อนุมัติแล้วเท่านั้น</p>
            </div>

            {/* Period Filter */}
            <div className="flex gap-2 flex-wrap">
              {(["all", "today", "7d", "30d", "month"] as const).map((p) => (
                <Button
                  key={p}
                  variant={topUsersPeriod === p ? "default" : "outline"}
                  size="sm"
                  className="text-xs"
                  onClick={() => setTopUsersPeriod(p)}
                >
                  {p === "all" ? "ทั้งหมด" : p === "today" ? "วันนี้" : p === "7d" ? "7 วัน" : p === "30d" ? "30 วัน" : "เดือนนี้"}
                </Button>
              ))}
            </div>

            {/* Top Users Table */}
            {topUsersLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 md:h-16" />
                ))}
              </div>
            ) : !topUsers || topUsers.length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title="ไม่มีข้อมูล"
                description="ไม่พบออเดอร์ที่อนุมัติแล้วในช่วงเวลานี้"
              />
            ) : (
              <div className="overflow-x-auto">
                <Card className="p-0">
                  <div className="hidden md:block">
                    {/* Desktop Table */}
                    <div className="grid grid-cols-6 gap-2 p-3 md:p-4 bg-slate-50 font-semibold text-xs md:text-sm border-b">
                      <div>อันดับ</div>
                      <div>ผู้ใช้</div>
                      <div className="text-right">ยอดซื้อรวม (อนุมัติ)</div>
                      <div className="text-right">จำนวนออเดอร์</div>
                      <div className="text-right">จำนวนตอนที่ซื้อ</div>
                      <div></div>
                    </div>
                    {topUsers.map((user: any, idx: number) => (
                      <div
                        key={user.userId}
                        className="grid grid-cols-6 gap-2 p-3 md:p-4 border-b hover:bg-slate-50 transition-colors cursor-pointer text-xs md:text-sm"
                      >
                        <div className="font-semibold text-blue-600">{idx + 1}</div>
                        <div className="truncate">
                          <p className="font-semibold text-slate-900 truncate">{user.userName}</p>
                          <p className="text-slate-500 truncate text-xs">{user.userEmail}</p>
                        </div>
                        <div className="text-right font-semibold text-slate-900">฿{parseFloat(user.totalSpent).toFixed(2)}</div>
                        <div className="text-right text-slate-600">{user.orderCount}</div>
                        <div className="text-right text-slate-600">{user.episodeCount}</div>
                        <div></div>
                      </div>
                    ))}
                  </div>

                  {/* Mobile Cards */}
                  <div className="md:hidden space-y-2 p-3">
                    {topUsers.map((user: any, idx: number) => (
                      <div
                        key={user.userId}
                        className="p-3 bg-slate-50 rounded border hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-blue-600 text-lg">#{idx + 1}</span>
                              <div>
                                <p className="font-semibold text-slate-900 text-sm">{user.userName}</p>
                                <p className="text-slate-500 text-xs truncate">{user.userEmail}</p>
                              </div>
                            </div>
                          </div>
                          <span className="font-bold text-lg text-blue-600">฿{parseFloat(user.totalSpent).toFixed(2)}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <p className="text-slate-600">จำนวนออเดอร์</p>
                            <p className="font-semibold text-slate-900">{user.orderCount}</p>
                          </div>
                          <div>
                            <p className="text-slate-600">จำนวนตอนที่ซื้อ</p>
                            <p className="font-semibold text-slate-900">{user.episodeCount}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* Recent Orders Tab */}
          <TabsContent value="recent" className="space-y-2 md:space-y-3 mt-4">
            {ordersLoading ? (
              <div className="space-y-2 md:space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-16 md:h-20" />
                ))}
              </div>
            ) : !allOrders || !allOrders.orders || allOrders.orders.length === 0 ? (
              <EmptyState
                icon={ShoppingCart}
                title="No Orders"
                description="No orders found in the system"
              />
            ) : (
              <div className="space-y-2 md:space-y-3">
                {allOrders.orders.slice(0, 10).map((order: any) => (
                  <Card
                    key={order.id}
                    className="p-3 md:p-4 hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => navigate(`/admin/orders/${order.id}`)}
                  >
                    <div className="space-y-2">
                      {/* Order number and status */}
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-semibold text-sm md:text-base text-slate-900">
                          {order.orderNumber}
                        </h3>
                        <StatusBadge status={order.status} />
                      </div>

                      {/* Order details - compact grid */}
                      <div className="grid grid-cols-2 gap-2 text-xs md:text-sm">
                        <div>
                          <p className="text-slate-600">Amount</p>
                          <p className="font-semibold text-slate-900">฿{parseFloat(order.totalAmount.toString()).toFixed(2)}</p>
                        </div>
                        <div>
                          <p className="text-slate-600">Items</p>
                          <p className="font-semibold text-slate-900">{order.items?.length || 0}</p>
                        </div>
                        <div className="col-span-2">
                          <p className="text-slate-600">Date</p>
                          <p className="font-semibold text-slate-900">{new Date(order.createdAt).toLocaleDateString()}</p>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      
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
    </div>
    </AdminLayout>
  );
}
