import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Loader2 } from "lucide-react";
import { useLocation } from "wouter";

export default function AdminOrdersPage() {
  const [, setLocation] = useLocation();
  const { data: orders, isLoading } = trpc.admin.orders.list.useQuery();

  return (
    <AdminLayout>
      <div className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : !orders || orders.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No orders found</p>
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
                {orders.map((order: any) => (
                  <tr key={order.id} className="border-b hover:bg-slate-50 cursor-pointer" onClick={() => setLocation(`/admin/orders/${order.id}`)}>
                    <td className="p-3 font-medium text-blue-600 hover:underline">{order.orderNumber}</td>
                    <td className="p-3">{order.userId || "—"}</td>
                    <td className="p-3">฿{parseFloat(order.totalAmount.toString()).toFixed(2)}</td>
                    <td className="p-3">{order.items?.length || 0} items</td>
                    <td className="p-3">
                      <Badge className="bg-blue-100 text-blue-800">
                        {order.status || "pending"}
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
      </div>
    </AdminLayout>
  );
}
