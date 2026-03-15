import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export default function AdminCouponsPage() {
  // All hooks must be called at the top level, before any conditional returns
  const { user, isAuthenticated } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    discountType: "flat" as "flat" | "percentage",
    discountValue: "",
    minPurchaseAmount: "",
    maxUsageCount: "",
    expiresAt: "",
  });

  // Query hooks with enabled flag - they won't fetch until auth is resolved and user is admin
  const { data: coupons, isLoading, refetch } = trpc.admin.coupons.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  // Mutation hooks
  const createMutation = trpc.admin.coupons.create.useMutation({
    onSuccess: () => {
      toast.success("Coupon created!");
      setFormData({
        code: "",
        discountType: "flat",
        discountValue: "",
        minPurchaseAmount: "",
        maxUsageCount: "",
        expiresAt: "",
      });
      setIsCreating(false);
      refetch();
    },
    onError: () => {
      toast.error("Failed to create coupon");
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

  const handleCreate = () => {
    if (!formData.code || !formData.discountValue) {
      toast.error("Code and discount value are required");
      return;
    }
    createMutation.mutate({
      ...formData,
      maxUsageCount: formData.maxUsageCount ? parseInt(formData.maxUsageCount) : undefined,
      expiresAt: formData.expiresAt ? new Date(formData.expiresAt) : undefined,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Manage Coupons</h1>
          <Button onClick={() => setIsCreating(!isCreating)}>
            <Plus className="w-4 h-4 mr-2" />
            New Coupon
          </Button>
        </div>

        {/* Create Form */}
        {isCreating && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Create New Coupon</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-semibold">Coupon Code</label>
                <Input
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="e.g., SAVE20"
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-semibold">Discount Type</label>
                  <Select value={formData.discountType} onValueChange={(value: any) => setFormData({ ...formData, discountType: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="flat">Flat Amount</SelectItem>
                      <SelectItem value="percentage">Percentage</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-sm font-semibold">
                    Discount Value {formData.discountType === "percentage" ? "(%)" : "(฿)"}
                  </label>
                  <Input
                    type="number"
                    value={formData.discountValue}
                    onChange={(e) => setFormData({ ...formData, discountValue: e.target.value })}
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-semibold">Min Purchase Amount (฿)</label>
                  <Input
                    type="number"
                    value={formData.minPurchaseAmount}
                    onChange={(e) => setFormData({ ...formData, minPurchaseAmount: e.target.value })}
                    placeholder="0"
                  />
                </div>

                <div>
                  <label className="text-sm font-semibold">Max Usage Count</label>
                  <Input
                    type="number"
                    value={formData.maxUsageCount}
                    onChange={(e) => setFormData({ ...formData, maxUsageCount: e.target.value })}
                    placeholder="Unlimited"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold">Expires At</label>
                <Input
                  type="datetime-local"
                  value={formData.expiresAt}
                  onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
                />
              </div>

              <div className="flex gap-2 pt-4">
                <Button onClick={handleCreate} disabled={createMutation.isPending} className="flex-1">
                  Create Coupon
                </Button>
                <Button variant="outline" onClick={() => setIsCreating(false)} className="flex-1">
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Coupons List */}
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : !coupons || coupons.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <p className="text-slate-600">No coupons yet</p>
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-semibold">Code</th>
                  <th className="text-left p-3 font-semibold">Discount</th>
                  <th className="text-left p-3 font-semibold">Min Purchase</th>
                  <th className="text-left p-3 font-semibold">Usage</th>
                  <th className="text-left p-3 font-semibold">Expires</th>
                  <th className="text-left p-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon: any) => (
                  <tr key={coupon.id} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-medium">{coupon.code}</td>
                    <td className="p-3">
                      {coupon.discountType === "flat" ? "฿" : ""}{coupon.discountValue}
                      {coupon.discountType === "percentage" ? "%" : ""}
                    </td>
                    <td className="p-3">฿{coupon.minPurchaseAmount || "0"}</td>
                    <td className="p-3">
                      {coupon.usageCount || 0}
                      {coupon.maxUsageCount ? ` / ${coupon.maxUsageCount}` : " / ∞"}
                    </td>
                    <td className="p-3 text-sm">
                      {coupon.expiresAt ? new Date(coupon.expiresAt).toLocaleDateString() : "Never"}
                    </td>
                    <td className="p-3">
                      <span className={`text-xs px-2 py-1 rounded ${coupon.isActive ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-800"}`}>
                        {coupon.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
