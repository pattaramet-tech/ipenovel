import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { Loader2, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocation } from "wouter";
import { useState } from "react";
import AdminLayout from "@/components/AdminLayout";

interface AdminOrdersResult {
  orders: Array<any>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function AdminOrdersPage() {
  const [, setLocation] = useLocation();
  
  // Pagination and filtering state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<'createdAt' | 'updatedAt' | 'amount' | 'discount'>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>("");
  const [hasDiscountFilter, setHasDiscountFilter] = useState<boolean | undefined>(undefined);

  // Fetch orders with filters
  const queryInput = {
    page,
    pageSize,
    search: search || undefined,
    sortBy,
    sortOrder,
    status: statusFilter || undefined,
    paymentStatus: paymentStatusFilter || undefined,
    hasDiscount: hasDiscountFilter,
  };
  
  const { data: result, isLoading, refetch } = trpc.admin.orders.list.useQuery(queryInput as any);

  const orders = result?.orders || [];
  const total = result?.total || 0;
  const totalPages = result?.totalPages || 1;

  // Handle search with debounce
  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  // Handle sort change
  const handleSort = (newSortBy: typeof sortBy) => {
    if (sortBy === newSortBy) {
      // Toggle sort order if clicking same column
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(newSortBy);
      setSortOrder('desc');
    }
    setPage(1);
  };

  // Handle filter changes
  const handleStatusFilter = (status: string) => {
    setStatusFilter(statusFilter === status ? "" : status);
    setPage(1);
  };

  const handlePaymentStatusFilter = (status: string) => {
    setPaymentStatusFilter(paymentStatusFilter === status ? "" : status);
    setPage(1);
  };

  const handleDiscountFilter = (value: boolean | undefined) => {
    setHasDiscountFilter(hasDiscountFilter === value ? undefined : value);
    setPage(1);
  };

  // Get sort indicator
  const getSortIndicator = (column: typeof sortBy) => {
    if (sortBy !== column) return " ↕";
    return sortOrder === 'asc' ? " ↑" : " ↓";
  };

  // Status badge color
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'cancelled':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-slate-100 text-slate-800';
    }
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      case 'submitted':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">Orders</h1>
          <p className="text-sm text-slate-600">Total: {total} orders</p>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search by order number, user name, or user ID..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Filters */}
        <div className="space-y-3">
          <div className="text-sm font-semibold">Filters</div>
          
          <div className="flex flex-wrap gap-2">
            {/* Status Filter */}
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={statusFilter === 'pending' ? 'default' : 'outline'}
                onClick={() => handleStatusFilter('pending')}
                className="text-xs"
              >
                Pending
              </Button>
              <Button
                size="sm"
                variant={statusFilter === 'completed' ? 'default' : 'outline'}
                onClick={() => handleStatusFilter('completed')}
                className="text-xs"
              >
                Completed
              </Button>
              <Button
                size="sm"
                variant={statusFilter === 'cancelled' ? 'default' : 'outline'}
                onClick={() => handleStatusFilter('cancelled')}
                className="text-xs"
              >
                Cancelled
              </Button>
            </div>

            {/* Payment Status Filter */}
            <div className="flex gap-1 ml-4">
              <Button
                size="sm"
                variant={paymentStatusFilter === 'approved' ? 'default' : 'outline'}
                onClick={() => handlePaymentStatusFilter('approved')}
                className="text-xs"
              >
                Payment Approved
              </Button>
              <Button
                size="sm"
                variant={paymentStatusFilter === 'pending' ? 'default' : 'outline'}
                onClick={() => handlePaymentStatusFilter('pending')}
                className="text-xs"
              >
                Payment Pending
              </Button>
            </div>

            {/* Discount Filter */}
            <div className="flex gap-1 ml-4">
              <Button
                size="sm"
                variant={hasDiscountFilter === true ? 'default' : 'outline'}
                onClick={() => handleDiscountFilter(true)}
                className="text-xs"
              >
                Has Discount
              </Button>
              <Button
                size="sm"
                variant={hasDiscountFilter === false ? 'default' : 'outline'}
                onClick={() => handleDiscountFilter(false)}
                className="text-xs"
              >
                No Discount
              </Button>
            </div>

            {/* Clear Filters */}
            {(statusFilter || paymentStatusFilter || hasDiscountFilter !== undefined) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setStatusFilter("");
                  setPaymentStatusFilter("");
                  setHasDiscountFilter(undefined);
                  setPage(1);
                }}
                className="text-xs ml-4"
              >
                Clear Filters
              </Button>
            )}
          </div>
        </div>

        {/* Loading State */}
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : !orders || orders.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No orders found</p>
          </Card>
        ) : (
          <>
            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100" onClick={() => handleSort('createdAt')}>
                      Order Number{getSortIndicator('createdAt')}
                    </th>
                    <th className="text-left p-3 font-semibold">User Name</th>
                    <th className="text-left p-3 font-semibold">User ID</th>
                    <th className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100" onClick={() => handleSort('amount')}>
                      Amount{getSortIndicator('amount')}
                    </th>
                    <th className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100" onClick={() => handleSort('discount')}>
                      Discount{getSortIndicator('discount')}
                    </th>
                    <th className="text-left p-3 font-semibold">Status</th>
                    <th className="text-left p-3 font-semibold">Payment</th>
                    <th className="text-left p-3 font-semibold">Approved By</th>
                    <th className="text-left p-3 font-semibold cursor-pointer hover:bg-slate-100" onClick={() => handleSort('createdAt')}>
                      Created{getSortIndicator('createdAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order: any) => (
                    <tr key={order.id} className="border-b hover:bg-slate-50 cursor-pointer" onClick={() => setLocation(`/admin/orders/${order.id}`)}>
                      <td className="p-3 font-medium text-blue-600 hover:underline">{order.orderNumber}</td>
                      <td className="p-3 text-sm">{order.userName || "—"}</td>
                      <td className="p-3 text-sm text-slate-600">{order.userId || "—"}</td>
                      <td className="p-3 font-medium">฿{parseFloat(order.totalAmount.toString()).toFixed(2)}</td>
                      <td className="p-3 text-sm">
                        {parseFloat(order.discountAmount.toString()) > 0 || parseFloat(order.pointsDiscountAmount.toString()) > 0 ? (
                          <div className="space-y-0.5">
                            {parseFloat(order.discountAmount.toString()) > 0 && <div>฿{parseFloat(order.discountAmount.toString()).toFixed(2)}</div>}
                            {parseFloat(order.pointsDiscountAmount.toString()) > 0 && <div className="text-xs text-slate-500">Pts: ฿{parseFloat(order.pointsDiscountAmount.toString()).toFixed(2)}</div>}
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-3">
                        <Badge className={getStatusColor(order.status || 'pending')}>
                          {order.status || "pending"}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <Badge className={getPaymentStatusColor(order.paymentStatus || 'pending')}>
                          {order.paymentStatus || "pending"}
                        </Badge>
                      </td>
                      <td className="p-3 text-slate-600 text-xs">
                        {(() => {
                          // Fallback logic: prefer approvalSource first, then approver details
                          if (order.approvalSource === "wallet") return "Wallet";
                          if (order.approvalSource === "auto") return "OCR Auto-Approve";
                          if (order.approvedByName) return order.approvedByName;
                          if (order.approvedByEmail) return order.approvedByEmail;
                          if (order.approvedByAdminId) return `Admin ${order.approvedByAdminId}`;
                          if (order.approvedByLabel) return order.approvedByLabel;
                          return "—";
                        })()}
                      </td>
                      <td className="p-3 text-sm text-slate-600">
                        {new Date(order.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between">
              <div className="text-sm text-slate-600">
                Page {page} of {totalPages} ({total} total orders)
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 1}
                  onClick={() => setPage(Math.max(1, page - 1))}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                
                {/* Page numbers */}
                <div className="flex gap-1">
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    const pageNum = Math.max(1, page - 2) + i;
                    if (pageNum > totalPages) return null;
                    return (
                      <Button
                        key={pageNum}
                        size="sm"
                        variant={page === pageNum ? 'default' : 'outline'}
                        onClick={() => setPage(pageNum)}
                      >
                        {pageNum}
                      </Button>
                    );
                  })}
                </div>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === totalPages}
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
