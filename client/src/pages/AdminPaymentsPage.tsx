import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Loader2, CheckCircle, XCircle, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { SlipPreviewModal } from "@/components/SlipPreviewModal";
import AdminLayout from "@/components/AdminLayout";
import { useAuth } from "@/_core/hooks/useAuth";

export default function AdminPaymentsPage() {
  const { user, isAuthenticated } = useAuth();
  const [slipPreviewOpen, setSlipPreviewOpen] = useState(false);
  const [selectedSlipUrl, setSelectedSlipUrl] = useState<string | null>(null);
  const { data: payments, isLoading, refetch } = trpc.admin.payments.pending.useQuery(
    undefined,
    { enabled: !!user && user.role === "admin" }
  );

  const approveMutation = trpc.admin.payments.approve.useMutation({
    onSuccess: () => {
      toast.success("Payment approved!");
      refetch();
    },
    onError: () => {
      toast.error("Failed to approve payment");
    },
  });

  const rejectMutation = trpc.admin.payments.reject.useMutation({
    onSuccess: () => {
      toast.success("Payment rejected");
      refetch();
    },
    onError: () => {
      toast.error("Failed to reject payment");
    },
  });

  const handleSlipPreview = (slipUrl: string) => {
    setSelectedSlipUrl(slipUrl);
    setSlipPreviewOpen(true);
  };

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

  return (
    <AdminLayout>
      <div className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : !payments || payments.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <CheckCircle className="w-12 h-12 text-green-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">No pending payments</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {payments.map((payment: any) => (
              <Card key={payment.id} className="overflow-hidden">
                <CardHeader className="pb-3 bg-slate-50">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg">{payment.order?.orderNumber}</CardTitle>
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
                    <Badge className="bg-yellow-100 text-yellow-800">Pending</Badge>
                  </div>
                </CardHeader>

                <CardContent className="pt-6">
                  {/* Payment Slip */}
                  <div className="mb-4">
                    <p className="text-sm font-semibold mb-2">Payment Slip:</p>
                    {payment.slipImageUrl ? (
                      <div className="flex gap-2 items-start">
                        <img
                          src={payment.slipImageUrl}
                          alt="Payment slip"
                          className="max-w-xs max-h-32 rounded border border-slate-200 cursor-pointer hover:opacity-80 transition"
                          onClick={() => handleSlipPreview(payment.slipImageUrl)}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleSlipPreview(payment.slipImageUrl)}
                        >
                          <ImageIcon className="w-4 h-4 mr-1" />
                          View Full
                        </Button>
                      </div>
                    ) : (
                      <div className="bg-slate-100 rounded border border-slate-300 p-4 text-center text-slate-600 text-sm">
                        No slip uploaded
                      </div>
                    )}
                  </div>

                  {/* Order Items */}
                  <div className="mb-4">
                    <p className="text-sm font-semibold mb-2">Items:</p>
                    <ul className="text-sm text-slate-600 space-y-1">
                      {payment.items?.map((item: any) => (
                        <li key={item.id}>
                          • Episode {item.episode?.episodeNumber}{item.episode?.title ? ` - ${item.episode.title}` : ""} - ฿{parseFloat(item.finalPrice.toString()).toFixed(2)}
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
      </div>

      {selectedSlipUrl && (
        <SlipPreviewModal
          isOpen={slipPreviewOpen}
          onClose={() => setSlipPreviewOpen(false)}
          slipUrl={selectedSlipUrl}
        />
      )}
    </AdminLayout>
  );
}
