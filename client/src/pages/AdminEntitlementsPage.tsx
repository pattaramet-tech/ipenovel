import AdminLayout from "@/components/AdminLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { toast } from "sonner";
import { Search, Loader2, AlertCircle } from "lucide-react";

export default function AdminEntitlementsPage() {
  const [orderId, setOrderId] = useState("");
  const [searchOrderId, setSearchOrderId] = useState<number | null>(null);
  const { data: searchResult, isLoading: isSearching } = trpc.admin.entitlements.search.useQuery(
    { orderId: searchOrderId! },
    { enabled: searchOrderId !== null }
  );

  const repairMutation = trpc.admin.entitlements.repair.useMutation({
    onSuccess: (data) => {
      toast.success(`Repaired! Granted ${data.grantedCount} entitlements`);
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to repair entitlements");
    },
  });

  const handleSearch = () => {
    if (!orderId) {
      toast.error("Please enter an order ID");
      return;
    }
    setSearchOrderId(parseInt(orderId));
  };

  const handleRepair = () => {
    if (!searchResult) {
      toast.error("No order selected");
      return;
    }
    if (!confirm("Are you sure you want to repair entitlements for this order?")) {
      return;
    }
    repairMutation.mutate({ orderId: searchResult.orderId });
  };

  return (
    <AdminLayout title="Entitlement Repair Tool">
      <div className="space-y-6">
        {/* Search Section */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Search Order</h2>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Enter order ID"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSearch()}
            />
            <Button
              onClick={handleSearch}
              disabled={isSearching}
            >
              {isSearching ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Search
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* Results Section */}
        {searchResult && (
          <Card className="p-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold">Order Details</h3>
                <div className="mt-2 space-y-2 text-sm">
                  <p><span className="font-semibold">Order Number:</span> {searchResult.orderNumber}</p>
                  <p><span className="font-semibold">Order ID:</span> {searchResult.orderId}</p>
                  <p><span className="font-semibold">User ID:</span> {searchResult.userId}</p>
                </div>
              </div>

              <div className="border-t pt-4">
                <h3 className="text-lg font-semibold mb-2">Entitlement Status</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-3 bg-blue-50 rounded">
                    <p className="text-sm text-slate-600">Total Items</p>
                    <p className="text-2xl font-bold">{searchResult.totalItems}</p>
                  </div>
                  <div className="p-3 bg-green-50 rounded">
                    <p className="text-sm text-slate-600">Granted</p>
                    <p className="text-2xl font-bold">{searchResult.grantedCount}</p>
                  </div>
                  <div className="p-3 bg-red-50 rounded">
                    <p className="text-sm text-slate-600">Missing</p>
                    <p className="text-2xl font-bold">{searchResult.missingCount}</p>
                  </div>
                </div>
              </div>

              {searchResult.missingCount > 0 && (
                <div className="border-t pt-4">
                  <div className="flex items-start gap-3 p-3 bg-yellow-50 rounded mb-4">
                    <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-yellow-900">Missing Entitlements Detected</p>
                      <p className="text-sm text-yellow-800 mt-1">
                        {searchResult.missingCount} episode(s) are missing entitlements. Click "Repair" to grant them.
                      </p>
                    </div>
                  </div>

                  <div className="mb-4">
                    <p className="font-semibold mb-2">Missing Episodes:</p>
                    <div className="space-y-2">
                      {searchResult.missingItems?.map((item: any, idx: number) => (
                        <div key={idx} className="p-2 bg-slate-50 rounded text-sm">
                          Episode {item.episodeId} - ฿{parseFloat(item.finalPrice.toString()).toFixed(2)}
                        </div>
                      ))}
                    </div>
                  </div>

                  <Button
                    onClick={handleRepair}
                    disabled={repairMutation.isPending}
                    className="w-full"
                  >
                    {repairMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Repairing...
                      </>
                    ) : (
                      "Repair Entitlements"
                    )}
                  </Button>
                </div>
              )}

              {searchResult.missingCount === 0 && (
                <div className="border-t pt-4">
                  <div className="p-3 bg-green-50 rounded text-center">
                    <p className="text-green-900 font-semibold">All entitlements are in order!</p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
