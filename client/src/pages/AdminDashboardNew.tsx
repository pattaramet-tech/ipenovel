import { useAuth } from "@/_core/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { BarChart3, BookOpen, ShoppingCart, AlertCircle, CheckCircle, Settings } from "lucide-react";

export default function AdminDashboardNew() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  // Redirect if not admin
  if (user?.role !== "admin") {
    navigate("/");
    return null;
  }

  const { data: payments } = trpc.admin.payments.pending.useQuery();

  const pendingPayments = payments || [];
  const approvedPayments: any[] = [];

  const stats = [
    {
      label: "Total Novels",
      value: 0,
      icon: BookOpen,
      color: "bg-blue-100 text-blue-600",
    },
    {
      label: "Total Orders",
      value: 0,
      icon: ShoppingCart,
      color: "bg-green-100 text-green-600",
    },
    {
      label: "Pending Payments",
      value: pendingPayments.length,
      icon: AlertCircle,
      color: "bg-yellow-100 text-yellow-600",
    },
    {
      label: "Approved Payments",
      value: approvedPayments.length,
      icon: CheckCircle,
      color: "bg-purple-100 text-purple-600",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-slate-600 mt-2">Manage novels, episodes, payments, and settings</p>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <Card key={stat.label} className="p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-slate-600 text-sm font-medium">{stat.label}</p>
                    <p className="text-3xl font-bold text-slate-900 mt-2">{stat.value}</p>
                  </div>
                  <div className={`p-3 rounded-lg ${stat.color}`}>
                    <Icon className="w-6 h-6" />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Quick Actions</h2>
            <div className="space-y-2">
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => navigate("/admin/novels")}
              >
                <BookOpen className="w-4 h-4 mr-2" />
                Manage Novels
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => navigate("/admin/episodes")}
              >
                <BookOpen className="w-4 h-4 mr-2" />
                Manage Episodes
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => navigate("/admin/payments")}
              >
                <AlertCircle className="w-4 h-4 mr-2" />
                Review Payments
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => navigate("/admin/settings")}
              >
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-4">System Status</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Database</span>
                <span className="text-green-600 font-medium">✓ Connected</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Auth</span>
                <span className="text-green-600 font-medium">✓ Active</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Storage</span>
                <span className="text-green-600 font-medium">✓ Ready</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">API</span>
                <span className="text-green-600 font-medium">✓ Running</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Recent Activity */}
        {pendingPayments.length > 0 && (
          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Pending Payments</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left py-3 px-4 font-medium text-slate-600">Order ID</th>
                    <th className="text-left py-3 px-4 font-medium text-slate-600">Amount</th>
                    <th className="text-left py-3 px-4 font-medium text-slate-600">Status</th>
                    <th className="text-left py-3 px-4 font-medium text-slate-600">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingPayments.slice(0, 5).map((payment: any) => (
                    <tr key={payment.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 px-4">{payment.orderId}</td>
                      <td className="py-3 px-4 font-medium">${payment.amount}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium">
                          {payment.status}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate("/admin/payments")}
                        >
                          Review
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
