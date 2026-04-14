import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Trash2, ShoppingCart, Maximize2, X } from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CartPage() {
  const { isAuthenticated, user } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();
  const [couponCode, setCouponCode] = useState("");
  const [pointsToRedeem, setPointsToRedeem] = useState("");
  const [discountAmount, setDiscountAmount] = useState("0.00");
  const [showSlipUpload, setShowSlipUpload] = useState(false);
  const [selectedSlipFile, setSelectedSlipFile] = useState<File | null>(null);
  const [isUploadingSlip, setIsUploadingSlip] = useState(false);
  const [showQRFullscreen, setShowQRFullscreen] = useState(false);
  const [slipPreview, setSlipPreview] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const { data: cartData, isLoading: cartLoading, refetch: refetchCart } = trpc.cart.get.useQuery(undefined, { enabled: isAuthenticated });

  const { data: pointsData } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });

  const items = cartData?.items || [];
  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.price.toString()), 0).toFixed(2);

  const removeFromCartMutation = trpc.cart.remove.useMutation({
    onSuccess: () => {
      toast.success(t("common.success"));
      // Invalidate cart query to update badge and cart state
      utils.cart.get.invalidate();
    },
    onError: () => {
      toast.error(t("common.error"));
    },
  });

  const handleValidateCoupon = async () => {
    if (!couponCode) {
      toast.error(t("common.error"));
      return;
    }
    try {
      const result = await utils.checkout.validateCoupon.fetch({ couponCode, subtotal });
      setDiscountAmount(result.discountAmount);
      toast.success(t("common.success"));
    } catch (error: any) {
      // Show real error message from server
      const errorMessage = error?.message || t("common.error");
      toast.error(errorMessage);
    }
  };

  const createOrderMutation = trpc.checkout.create.useMutation({
    onSuccess: (order) => {
      toast.success(t("common.success"));
      // Reset slip upload state
      setShowSlipUpload(false);
      setSelectedSlipFile(null);
      // Navigate to orders page (order already has slip attached)
      navigate("/orders");
      utils.cart.get.invalidate();
    },
    onError: (error: any) => {
      const errorMessage = error?.message || t("common.error");
      toast.error(errorMessage);
    },
  });

  const walletCheckoutMutation = trpc.checkout.walletCheckout.useMutation({
    onSuccess: () => {
      toast.success(t("wallet.walletCheckoutSuccess"));
      utils.cart.get.invalidate();
      navigate("/my-novels");
    },
    onError: (error: any) => {
      const errorMessage = error?.message || t("wallet.walletCheckoutFailed");
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
              <a href={getLoginUrl()}>Sign In</a>
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



  const uploadSlipFile = async (file: File): Promise<string> => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        resolve(result);
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });

    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: base64,
        filename: file.name,
        type: file.type,
      }),
    });

    if (!response.ok) throw new Error("Upload failed");
    const data = await response.json();
    return data.url;
  };

  const handleCheckoutWithSlip = async () => {
    if (items.length === 0) {
      toast.error(t("cart.empty"));
      return;
    }
    if (!selectedSlipFile) {
      toast.error(t("payment.selectFileFirst"));
      return;
    }

    try {
      setIsUploadingSlip(true);

      // Step 1: Upload slip first
      const slipImageUrl = await uploadSlipFile(selectedSlipFile);

      // Step 2: Create order with slip URL
      const normalizedCoupon = couponCode ? couponCode.trim().toUpperCase() : undefined;
      createOrderMutation.mutate({
        couponCode: normalizedCoupon,
        pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined,
        slipImageUrl,
      });
    } catch (error: any) {
      toast.error(error.message || t("payment.uploadFailed"));
      setIsUploadingSlip(false);
    }
  };

  const handleCheckout = () => {
    if (items.length === 0) {
      toast.error(t("cart.empty"));
      return;
    }
    // Show slip upload dialog for manual slip-payment
    setShowSlipUpload(true);
  };

  const handleSlipFileSelect = (file: File | null) => {
    setSelectedSlipFile(file);
    if (file && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setSlipPreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setSlipPreview(null);
    }
  };

  const resetSlipUploadState = () => {
    setShowSlipUpload(false);
    setSelectedSlipFile(null);
    setSlipPreview(null);
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
                      disabled={items.length === 0 || createOrderMutation.isPending || isUploadingSlip}
                    >
                      {isUploadingSlip ? t("common.uploading") : t("checkout.proceedToCheckout")}
                    </Button>
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={() => walletCheckoutMutation.mutate({ couponCode: couponCode.trim().toUpperCase() || undefined, pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined })}
                      disabled={items.length === 0 || walletCheckoutMutation.isPending}
                    >
                      {t("wallet.payWithWallet")}
                    </Button>
                  </div>

                  {/* Slip Upload Modal */}
                  {showSlipUpload && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
                      <Card className="w-full max-w-md my-8">
                        <CardHeader>
                          <CardTitle>{t("payment.uploadSlip")}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          {/* Transfer Amount Label */}
                          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                            <p className="text-sm text-blue-700 mb-1">ยอดที่ต้องโอน</p>
                            <p className="text-3xl font-bold text-blue-900">฿{total}</p>
                          </div>

                          {/* QR Payment Block */}
                          <div>
                            <h3 className="text-lg font-semibold mb-3 text-slate-800">{t("payment.scanQRToPayment")}</h3>
                            <Card className="p-4 bg-slate-50 border-2 border-slate-200 relative">
                              <div className="flex flex-col items-center">
                                <img
                                  src="https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_19d96370.JPG"
                                  alt="QR Payment"
                                  className="w-full max-w-xs aspect-square object-contain rounded-lg"
                                />
                              </div>
                              {/* Fullscreen QR Button */}
                              <button
                                onClick={() => setShowQRFullscreen(true)}
                                className="absolute top-2 right-2 p-2 bg-white rounded-lg shadow hover:bg-slate-100 transition"
                                title="Expand QR"
                              >
                                <Maximize2 className="w-5 h-5 text-slate-700" />
                              </button>
                            </Card>
                            <p className="text-sm text-slate-600 mt-3 text-center">
                              {t("payment.qrPaymentHelper")}
                            </p>
                          </div>

                          {/* Slip Upload Section */}
                          <div className="space-y-3">
                            <label className="block text-sm font-medium text-slate-700">
                              {t("payment.selectFile")}
                            </label>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,application/pdf"
                              onChange={(e) => handleSlipFileSelect(e.target.files?.[0] || null)}
                              disabled={isUploadingSlip}
                              className="w-full px-3 py-2 border rounded text-sm"
                            />
                            <p className="text-xs text-slate-500">{t("payment.fileRequirements")}</p>

                            {/* Selected File Info */}
                            {selectedSlipFile && (
                              <div className="bg-green-50 p-3 rounded-lg border border-green-200 flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-green-900 truncate">{selectedSlipFile.name}</p>
                                  <p className="text-xs text-green-700">{(selectedSlipFile.size / 1024).toFixed(1)} KB</p>
                                </div>
                                <button
                                  onClick={() => handleSlipFileSelect(null)}
                                  className="text-green-600 hover:text-green-700 flex-shrink-0"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            )}

                            {/* Slip Image Preview */}
                            {slipPreview && (
                              <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50 p-2">
                                <img
                                  src={slipPreview}
                                  alt="Slip preview"
                                  className="w-full max-h-48 object-contain rounded"
                                />
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2">
                            <Button
                              className="flex-1"
                              onClick={handleCheckoutWithSlip}
                              disabled={!selectedSlipFile || isUploadingSlip || createOrderMutation.isPending}
                            >
                              {isUploadingSlip || createOrderMutation.isPending ? t("common.pleaseWait") : t("checkout.proceedToCheckout")}
                            </Button>
                            <Button
                              className="flex-1"
                              variant="outline"
                              onClick={resetSlipUploadState}
                              disabled={isUploadingSlip}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Fullscreen QR Modal */}
                  {showQRFullscreen && (
                    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4">
                      <div className="relative bg-white rounded-lg p-4 max-w-2xl w-full">
                        <button
                          onClick={() => setShowQRFullscreen(false)}
                          className="absolute top-4 right-4 p-2 bg-slate-100 rounded-lg hover:bg-slate-200 transition"
                        >
                          <X className="w-6 h-6 text-slate-700" />
                        </button>
                        <div className="flex flex-col items-center">
                          <img
                            src="https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_19d96370.JPG"
                            alt="QR Payment - Full Screen"
                            className="w-full max-w-lg aspect-square object-contain"
                          />
                        </div>
                        <p className="text-center text-slate-600 mt-4 text-sm">
                          {t("payment.qrPaymentHelper")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
