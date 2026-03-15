import AdminLayout from "@/components/AdminLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { toast } from "sonner";

export default function AdminPaymentsPage() {
  const { data: payments, isLoading, refetch } = trpc.admin.payments.pending.useQuery();

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
      </div>
    </AdminLayout>
  );
}
