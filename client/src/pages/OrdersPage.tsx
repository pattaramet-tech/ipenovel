import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { FileText } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/_core/hooks/useAuth";

export default function OrdersPage() {
  const { isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();

  const { data: orders, isLoading } = trpc.orders.list.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">{t("common.pleaseSignIn")}</p>
            <Button asChild>
              <a href="/login">{t("nav.login")}</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-green-100 text-green-800";
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-slate-100 text-slate-800";
    }
  };

  const getPaymentStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "bg-green-100 text-green-800";
      case "submitted":
        return "bg-blue-100 text-blue-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      default:
        return "bg-slate-100 text-slate-800";
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <h1 className="text-3xl font-bold mb-8">{t("orders.title")}</h1>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : !orders || orders.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center py-12">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-600 text-lg">{t("orders.noOrders")}</p>
              <Button asChild className="mt-4">
                <a href="/novels">{t("common.startShopping")}</a>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {orders.map((order: any) => (
              <Card key={order.id} className="cursor-pointer hover:shadow-lg transition" onClick={() => navigate(`/orders/${order.id}`)}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{order.orderNumber}</CardTitle>
                      <p className="text-sm text-slate-600 mt-1">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Badge className={getStatusColor(order.status)}>
                        {t(`status.${order.status}`)}
                      </Badge>
                      <Badge className={getPaymentStatusColor(order.paymentStatus)}>
                        {t(`status.${order.paymentStatus}`)}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>

                <CardContent>
                  {/* Show rejection reason if payment was rejected */}
                  {order.paymentStatus === "rejected" && order.payment?.rejectionReason && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                      <p className="font-semibold">Payment Rejected</p>
                      <p>{order.payment.rejectionReason}</p>
                    </div>
                  )}

                  <div className="space-y-2 mb-4">
                    {order.items?.slice(0, 2).map((item: any) => (
                      <p key={item.id} className="text-sm text-slate-600">
                        • Episode {item.episode?.episodeNumber}{item.episode?.title ? ` - ${item.episode.title}` : ""}
                      </p>
                    ))}
                    {order.items?.length > 2 && (
                      <p className="text-sm text-slate-500">
                        +{order.items.length - 2} more items
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-4 border-t">
                    <div>
                      <p className="text-sm text-slate-600">Total Amount</p>
                      <p className="text-lg font-bold text-slate-900">
                        ฿{parseFloat(order.totalAmount.toString()).toFixed(2)}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/orders/${order.id}`); }}>
                      View Details →
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
