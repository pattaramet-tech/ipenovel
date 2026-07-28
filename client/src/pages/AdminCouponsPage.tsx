import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { Plus, Edit2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

type CouponOwner = { id: number; name: string | null; email: string | null } | null;

export default function AdminCouponsPage() {
  const { user, isAuthenticated } = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingHasUsage, setEditingHasUsage] = useState(false);
  const [formData, setFormData] = useState({
    code: "",
    discountType: "flat" as "flat" | "percentage",
    discountValue: "",
    minPurchaseAmount: "",
    maxUsageCount: "",
    expiresAt: "",
    isActive: true,
    scope: "global" as "global" | "user",
  });
  const [ownerEmailInput, setOwnerEmailInput] = useState("");
  const [resolvedOwner, setResolvedOwner] = useState<CouponOwner>(null);

  const { data: coupons, isLoading, refetch } = trpc.admin.coupons.list.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  const findOwnerQuery = trpc.admin.coupons.findUserByEmail.useQuery(
    { email: ownerEmailInput.trim() },
    { enabled: false }
  );

  const createMutation = trpc.admin.coupons.create.useMutation({
    onSuccess: () => {
      toast.success("Coupon created!");
      resetForm();
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to create coupon");
    },
  });

  const updateMutation = trpc.admin.coupons.update.useMutation({
    onSuccess: () => {
      toast.success("Coupon updated!");
      resetForm();
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update coupon");
    },
  });

  const deleteMutation = trpc.admin.coupons.delete.useMutation({
    onSuccess: () => {
      toast.success("Coupon deleted!");
      refetch();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete coupon");
    },
  });

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

  const resetForm = () => {
    setFormData({
      code: "",
      discountType: "flat",
      discountValue: "",
      minPurchaseAmount: "",
      maxUsageCount: "",
      expiresAt: "",
      isActive: true,
      scope: "global",
    });
    setOwnerEmailInput("");
    setResolvedOwner(null);
    setIsCreating(false);
    setEditingId(null);
    setEditingHasUsage(false);
  };

  const handleEdit = (coupon: any) => {
    setEditingId(coupon.id);
    setEditingHasUsage(Boolean(coupon.usageCount) || Boolean(coupon.isOwnershipRestricted && coupon.owner));
    setIsCreating(false);
    setFormData({
      code: coupon.code || "",
      discountType: coupon.discountType || "flat",
      discountValue: coupon.discountValue ? String(coupon.discountValue).trim() : "",
      minPurchaseAmount: coupon.minPurchaseAmount ? String(coupon.minPurchaseAmount).trim() : "",
      maxUsageCount: coupon.maxUsageCount ? String(coupon.maxUsageCount) : "",
      expiresAt: coupon.expiresAt ? new Date(coupon.expiresAt).toISOString().split("T")[0] : "",
      isActive: coupon.isActive ?? true,
      scope: coupon.scope === "user" ? "user" : "global",
    });
    setResolvedOwner(coupon.owner ?? null);
    setOwnerEmailInput(coupon.owner?.email ?? "");
  };

  const handleFindOwner = async () => {
    if (!ownerEmailInput.trim()) return;
    const result = await findOwnerQuery.refetch();
    if (result.data) {
      setResolvedOwner(result.data);
      toast.success(`Found ${result.data.name || result.data.email}`);
    } else {
      setResolvedOwner(null);
      toast.error("No user found with that email");
    }
  };

  const handleSave = () => {
    if (!formData.code || !formData.discountValue) {
      toast.error("Code and discount value are required");
      return;
    }
    if (formData.scope === "user" && !resolvedOwner) {
      toast.error("Search and select an owner by email for a user-specific coupon");
      return;
    }

    const payload = {
      discountType: formData.discountType,
      discountValue: formData.discountValue,
      code: formData.code,
      minPurchaseAmount: formData.minPurchaseAmount || undefined,
      maxUsageCount: formData.maxUsageCount ? parseInt(formData.maxUsageCount) : undefined,
      expiresAt: formData.expiresAt ? new Date(formData.expiresAt) : undefined,
      isActive: formData.isActive,
      scope: formData.scope,
      ownerUserId: formData.scope === "user" ? resolvedOwner?.id : undefined,
    };

    if (editingId) {
      // Never send scope/ownerUserId for an edit of an already-used coupon -
      // the server independently rejects this too, but omitting it here
      // means a no-op re-save can never even attempt the change.
      const { scope, ownerUserId, ...rest } = payload;
      const updatePayload = editingHasUsage ? rest : payload;
      updateMutation.mutate({ couponId: editingId, ...updatePayload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleDelete = (coupon: any) => {
    if (coupon.usageCount > 0 || coupon.isOwnershipRestricted) {
      toast.error("This coupon has usage history - deactivate it instead of deleting.");
      return;
    }
    if (confirm("Are you sure you want to delete this coupon?")) {
      deleteMutation.mutate({ couponId: coupon.id });
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Manage Coupons</h1>
          <Button onClick={() => {
            resetForm();
            setIsCreating(true);
          }}>
            <Plus className="w-4 h-4 mr-2" />
            New Coupon
          </Button>
        </div>

        {/* Create/Edit Form */}
        {(isCreating || editingId) && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>{editingId ? "Edit Coupon" : "Create New Coupon"}</CardTitle>
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

              <div>
                <label className="text-sm font-semibold">Coupon Scope</label>
                <Select
                  value={formData.scope}
                  onValueChange={(value: any) => setFormData({ ...formData, scope: value })}
                  disabled={editingHasUsage}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Global (anyone can use)</SelectItem>
                    <SelectItem value="user">User-specific (one owner only)</SelectItem>
                  </SelectContent>
                </Select>
                {editingHasUsage && (
                  <p className="text-xs text-amber-600 mt-1">
                    This coupon already has usage history - scope and owner can no longer be changed.
                  </p>
                )}
              </div>

              {formData.scope === "user" && (
                <div>
                  <label className="text-sm font-semibold">Owner (search by email)</label>
                  <div className="flex gap-2">
                    <Input
                      value={ownerEmailInput}
                      onChange={(e) => {
                        setOwnerEmailInput(e.target.value);
                        setResolvedOwner(null);
                      }}
                      placeholder="user@example.com"
                      disabled={editingHasUsage}
                    />
                    <Button type="button" variant="outline" onClick={handleFindOwner} disabled={editingHasUsage}>
                      Find
                    </Button>
                  </div>
                  {resolvedOwner && (
                    <p className="text-xs text-green-700 mt-1">
                      Owner: {resolvedOwner.name || "(no name)"} - {resolvedOwner.email} (ID {resolvedOwner.id})
                    </p>
                  )}
                </div>
              )}

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

              <div>
                <label className="text-sm font-semibold flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  />
                  Active
                </label>
              </div>

              <div className="flex gap-2 pt-4">
                <Button onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} className="flex-1">
                  {editingId ? "Update Coupon" : "Create Coupon"}
                </Button>
                <Button variant="outline" onClick={resetForm} className="flex-1">
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
          <div className="max-w-full overflow-x-auto rounded-lg border border-slate-200" role="region" aria-label="Coupons table" tabIndex={0}>
            <table className="w-full min-w-[52rem]">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left p-3 font-semibold">Code</th>
                  <th className="text-left p-3 font-semibold">Scope / Owner</th>
                  <th className="text-left p-3 font-semibold">Discount</th>
                  <th className="text-left p-3 font-semibold">Min Purchase</th>
                  <th className="text-left p-3 font-semibold">Usage</th>
                  <th className="text-left p-3 font-semibold">Expires</th>
                  <th className="text-left p-3 font-semibold">Status</th>
                  <th className="text-left p-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((coupon: any) => (
                  <tr key={coupon.id} className="border-b hover:bg-slate-50">
                    <td className="p-3 font-medium">{coupon.code}</td>
                    <td className="p-3">
                      {coupon.isOwnershipRestricted ? (
                        <div>
                          <span className="text-xs px-2 py-1 rounded bg-purple-100 text-purple-800">User-owned</span>
                          {coupon.owner && (
                            <p className="text-xs text-slate-600 mt-1">
                              {coupon.owner.name || "(no name)"}
                              <br />
                              {coupon.owner.email} (ID {coupon.owner.id})
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-800">Global</span>
                      )}
                    </td>
                    <td className="p-3">
                      {coupon.discountType === "flat" ? "฿" : ""}{coupon.discountValue || "0.00"}
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
                    <td className="p-3 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEdit(coupon)}
                        disabled={editingId === coupon.id}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(coupon)}
                        disabled={deleteMutation.isPending || coupon.usageCount > 0 || coupon.isOwnershipRestricted}
                        title={coupon.usageCount > 0 || coupon.isOwnershipRestricted ? "Has usage history - deactivate instead" : "Delete"}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
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
