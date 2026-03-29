import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Trash2, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CartPage() {
  const { isAuthenticated, user } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();
  const [couponCode, setCouponCode] = useState("");
  const [pointsToRedeem, setPointsToRedeem] = useState("");
  const [discountAmount, setDiscountAmount] = useState("0.00");
  const utils = trpc.useUtils();

  const { data: cartData, isLoading: cartLoading, refetch: refetchCart } = trpc.cart.get.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const { data: pointsData } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });

  const items = cartData?.items || [];
  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.price.toString()), 0).toFixed(2);

  const removeFromCartMutation = trpc.cart.remove.useMutation({
    onSuccess: () => {
      toast.success("Item removed from cart");
      refetchCart();
    },
    onError: () => {
      toast.error("Failed to remove item");
    },
  });

  const handleValidateCoupon = async () => {
    if (!couponCode) {
      toast.error("Enter a coupon code");
      return;
    }
    try {
      const result = await utils.checkout.validateCoupon.fetch({ couponCode, subtotal });
      setDiscountAmount(result.discountAmount);
      toast.success("Coupon applied!");
    } catch (error: any) {
      // Show real error message from server
      const errorMessage = error?.message || "Invalid coupon";
      toast.error(errorMessage);
    }
  };

  const createOrderMutation = trpc.checkout.create.useMutation({
    onSuccess: (order) => {
      toast.success("Order created! Proceed to payment.");
      navigate(`/payment/${order.id}`);
    },
    onError: (error: any) => {
      const errorMessage = error?.message || "Failed to create order";
      toast.error(errorMessage);
    },
  });

  const walletCheckoutMutation = trpc.checkout.walletCheckout.useMutation({
    onSuccess: () => {
      toast.success("Payment successful! Access granted.");
      refetchCart();
      navigate("/my-novels");
    },
    onError: (error: any) => {
      const errorMessage = error?.message || "Wallet checkout failed";
      toast.error(errorMessage);
    },
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please sign in to view your cart</p>
            <Button asChild>
              <a href="/login">Sign In</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (cartLoading) {
    return <Skeleton className="h-96" />;
  }

  const total = (parseFloat(subtotal) - parseFloat(discountAmount) - parseFloat(pointsToRedeem || "0")).toFixed(2);



  const handleCheckout = () => {
    if (items.length === 0) {
      toast.error("Cart is empty");
      return;
    }
    // Normalize coupon code same way as server
    const normalizedCoupon = couponCode ? couponCode.trim().toUpperCase() : undefined;
    createOrderMutation.mutate({
      couponCode: normalizedCoupon,
      pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined,
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4">
        <h1 className="text-3xl font-bold mb-8">{t("cart.title")}</h1>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Cart Items */}
          <div className="lg:col-span-2">
            {items.length === 0 ? (
              <Card>
                <CardContent className="pt-6 text-center py-12">
                  <ShoppingCart className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                  <p className="text-slate-600 text-lg">{t("cart.empty")}</p>
                  <Button asChild className="mt-4">
                    <a href="/novels">{t("cart.continueShopping")}</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {items.map((item: any) => (
                  <Card key={item.id}>
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <h3 className="font-semibold text-slate-900">{item.novel?.title}</h3>
                          <p className="text-sm text-slate-600">Episode {item.episode?.episodeNumber}</p>
                          <p className="text-sm text-slate-600">{item.episode?.title}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-slate-900">฿{parseFloat(item.price.toString()).toFixed(2)}</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeFromCartMutation.mutate({ cartItemId: item.id })}
                            disabled={removeFromCartMutation.isPending}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Order Summary */}
          <div>
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle>{t("cart.orderSummary")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Subtotal */}
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">{t("cart.subtotal")}</span>
                  <span className="font-semibold">฿{subtotal}</span>
                </div>

                {/* Coupon */}
                <div className="border-t pt-4">
                  <p className="text-sm font-semibold mb-2">{t("cart.applyCoupon")}</p>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("cart.applyCoupon")}
                      value={couponCode}
                      onChange={(e) => setCouponCode(e.target.value)}
                    />
                    <Button
                      size="sm"
                      onClick={handleValidateCoupon}
                      disabled={!couponCode}
                    >
                      {t("common.apply")}
                    </Button>
                  </div>
                  {discountAmount !== "0.00" && (
                    <p className="text-xs text-green-600 mt-2">Discount: -฿{discountAmount}</p>
                  )}
                </div>

                {/* Points */}
                <div className="border-t pt-4">
                  <p className="text-sm font-semibold mb-2">{t("cart.redeemPoints")}</p>
                  <p className="text-xs text-slate-600 mb-2">{t("cart.availablePoints")}: {pointsData?.balance || "0"} pts</p>
                  <Input
                    placeholder="Points to redeem"
                    type="number"
                    value={pointsToRedeem}
                    onChange={(e) => setPointsToRedeem(e.target.value)}
                  />
                  {pointsToRedeem && (
                    <p className="text-xs text-blue-600 mt-2">Discount: -฿{pointsToRedeem}</p>
                  )}
                </div>

                {/* Total */}
                <div className="border-t pt-4">
                  <div className="flex justify-between mb-4">
                    <span className="font-semibold text-slate-900">{t("cart.total")}</span>
                    <span className="font-bold text-lg text-blue-600">฿{total}</span>
                  </div>

                  <div className="space-y-2">
                    <Button
                      className="w-full"
                      onClick={handleCheckout}
                      disabled={items.length === 0 || createOrderMutation.isPending}
                    >
                      {t("checkout.proceedToCheckout")}
                    </Button>
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => walletCheckoutMutation.mutate({ couponCode: couponCode.trim().toUpperCase() || undefined, pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined })}
                      disabled={items.length === 0 || walletCheckoutMutation.isPending}
                    >
                      Pay with Wallet
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
