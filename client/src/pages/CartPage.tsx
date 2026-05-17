
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import {
  Trash2,
  ShoppingCart,
  Maximize2,
  X,
  TicketPercent,
  CheckCircle2,
  ChevronRight,
  Tag,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { useEffect, useState } from "react";

export default function CartPage() {
  const { isAuthenticated, user } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useLanguage();
  const [couponInput, setCouponInput] = useState("");
  const [appliedCouponCode, setAppliedCouponCode] = useState("");
  const [pointsToRedeem, setPointsToRedeem] = useState("");
  const [discountAmount, setDiscountAmount] = useState("0.00");
  const [showSlipUpload, setShowSlipUpload] = useState(false);
  const [selectedSlipFile, setSelectedSlipFile] = useState<File | null>(null);
  const [isUploadingSlip, setIsUploadingSlip] = useState(false);
  const [showQRFullscreen, setShowQRFullscreen] = useState(false);
  const [slipPreview, setSlipPreview] = useState<string | null>(null);
  const [appliedCoupon, setAppliedCoupon] = useState<any | null>(null);
  const [showCouponPicker, setShowCouponPicker] = useState(false);
  const utils = trpc.useUtils();

  const { data: cartData, isLoading: cartLoading, refetch: refetchCart } = trpc.cart.get.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  const { data: pointsData } = trpc.points.balance.useQuery(undefined, { enabled: isAuthenticated });

  const items = cartData?.items || [];
  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.price.toString()), 0).toFixed(2);

  const { data: activeCoupons = [], isLoading: couponsLoading, error: couponsError } = trpc.checkout.activeCoupons.useQuery(
    items.length > 0 ? { subtotal } : undefined,
    { enabled: isAuthenticated && items.length > 0 }
  );

  useEffect(() => {
    setCouponInput("");
    setAppliedCouponCode("");
    setAppliedCoupon(null);
    setDiscountAmount("0.00");
  }, [subtotal]);

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

  const formatBaht = (value: string | number | undefined | null) => {
    const amount = Number.parseFloat(String(value ?? "0"));
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    return safeAmount.toLocaleString("th-TH", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const handleApplyCoupon = async (code: string, coupon?: any) => {
    const normalizedCode = String(code || "").trim().toUpperCase();

    if (!normalizedCode) {
      toast.error(t("common.error"));
      return;
    }

    try {
      const result = await utils.checkout.validateCoupon.fetch({
        couponCode: normalizedCode,
        subtotal,
      });

      setAppliedCouponCode(normalizedCode);
      setDiscountAmount(result.discountAmount);
      setAppliedCoupon(coupon || result.coupon || { code: normalizedCode });
      setShowCouponPicker(false);
      toast.success(t("common.success"));
    } catch (error: any) {
      const errorMessage = error?.message || t("common.error");
      toast.error(errorMessage);
    }
  };

  const handleValidateCoupon = () => handleApplyCoupon(couponInput);

  const handleClearCoupon = () => {
    setCouponInput("");
    setAppliedCouponCode("");
    setDiscountAmount("0.00");
    setAppliedCoupon(null);
    toast.success("Coupon removed");
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

  // Safe points redemption clamping
  const subtotalNum = Number(subtotal) || 0;
  const discountNum = Number(discountAmount) || 0;
  const requestedPoints = Math.max(0, Number(pointsToRedeem) || 0);
  const pointBalance = Number(pointsData?.balance) || 0;
  const maxRedeemable = Math.max(0, subtotalNum - discountNum);
  const safePointsToRedeem = Math.min(requestedPoints, pointBalance, maxRedeemable);
  const total = Math.max(0, subtotalNum - discountNum - safePointsToRedeem).toFixed(2);



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

      // Step 2: Create order with slip URL using mutateAsync
      await createOrderMutation.mutateAsync({
        couponCode: appliedCouponCode || undefined,
        pointsToRedeem: safePointsToRedeem > 0 ? safePointsToRedeem.toFixed(2) : undefined,
        slipImageUrl,
      });
    } catch (error: any) {
      toast.error(error?.message || t("payment.uploadFailed"));
    } finally {
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
    if (!file) {
      setSelectedSlipFile(null);
      setSlipPreview(null);
      return;
    }

    // Validate file type
    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      toast.error("Invalid file type. Please upload JPG, PNG, or PDF.");
      setSelectedSlipFile(null);
      setSlipPreview(null);
      return;
    }

    // Validate file size (5 MB max)
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      toast.error("File size exceeds 5 MB limit.");
      setSelectedSlipFile(null);
      setSlipPreview(null);
      return;
    }

    setSelectedSlipFile(file);
    if (file.type.startsWith("image/")) {
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
                <div className="border-t pt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TicketPercent className="w-4 h-4 text-orange-500" />
                      <p className="text-sm font-semibold">Discount Coupons</p>
                    </div>

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowCouponPicker(true)}
                      disabled={items.length === 0}
                      className="h-8 px-2 text-orange-600 hover:text-orange-700"
                    >
                      Select Coupon <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>

                  {appliedCoupon ? (
                    <div className="rounded-xl border border-orange-200 bg-orange-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-4 h-4 text-green-600" />
                            <p className="text-sm font-bold text-orange-700 truncate">
                              {appliedCoupon.code || appliedCouponCode}
                            </p>
                          </div>
                          <p className="mt-1 text-xs text-slate-600">
                            Applied. Instant discount ฿{formatBaht(discountAmount)}
                          </p>
                        </div>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={handleClearCoupon}
                          className="h-8 px-2 text-slate-500"
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : activeCoupons.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setShowCouponPicker(true)}
                      className="w-full rounded-xl border border-dashed border-orange-300 bg-orange-50/60 p-3 text-left transition hover:bg-orange-50"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Tag className="w-4 h-4 text-orange-500 flex-shrink-0" />
                          <span className="text-sm text-slate-700 truncate">
                            {activeCoupons.length} coupon{activeCoupons.length > 1 ? "s" : ""} available
                          </span>
                        </div>
                        <span className="text-xs font-semibold text-orange-600">Use</span>
                      </div>
                    </button>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                      No active coupons available right now.
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Input
                      placeholder="Enter coupon code"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value)}
                    />
                    <Button size="sm" onClick={handleValidateCoupon} disabled={!couponInput.trim()}>
                      Apply
                    </Button>
                  </div>
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
                      onClick={() => walletCheckoutMutation.mutate({ couponCode: appliedCouponCode || undefined, pointsToRedeem: safePointsToRedeem > 0 ? safePointsToRedeem.toFixed(2) : undefined })}
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

      {/* Coupon Picker Modal */}
      {showCouponPicker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
          <Card className="w-full max-w-lg rounded-b-none sm:rounded-2xl max-h-[85vh] overflow-hidden">
            <CardHeader className="border-b">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <TicketPercent className="w-5 h-5 text-orange-500" />
                    Select Discount Coupon
                  </CardTitle>
                  <p className="mt-1 text-xs text-slate-500">Cart subtotal ฿{formatBaht(subtotal)}</p>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCouponPicker(false)}
                  className="h-9 w-9 p-0"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-3 overflow-y-auto p-4 max-h-[65vh]">
              {couponsError ? (
                <div className="py-10 text-center">
                  <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
                  <p className="text-sm text-red-600">Unable to load coupons. Please try again.</p>
                </div>
              ) : couponsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full rounded-xl" />
                  <Skeleton className="h-24 w-full rounded-xl" />
                </div>
              ) : activeCoupons.length === 0 ? (
                <div className="py-10 text-center">
                  <TicketPercent className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                  <p className="text-sm text-slate-500">No active coupons available.</p>
                </div>
              ) : (
                activeCoupons.map((coupon: any) => (
                  <div
                    key={coupon.id}
                    className={`relative overflow-hidden rounded-2xl border bg-white ${
                      coupon.canUse ? "border-orange-200" : "border-slate-200 opacity-70"
                    }`}
                  >
                    <div className="flex">
                      <div className="flex w-28 flex-shrink-0 flex-col items-center justify-center bg-gradient-to-br from-orange-500 to-red-500 p-4 text-white">
                        <TicketPercent className="mb-2 h-6 w-6" />
                        <p className="text-center text-sm font-bold leading-tight">{coupon.discountLabel}</p>
                      </div>

                      <div className="min-w-0 flex-1 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-bold text-slate-900 truncate">{coupon.code}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              Min. spend ฿{formatBaht(coupon.minPurchaseAmount)}
                            </p>

                            {coupon.remainingUsageCount !== null && (
                              <p className="mt-1 text-xs text-slate-400">
                                Remaining: {coupon.remainingUsageCount}
                              </p>
                            )}

                            {coupon.expiresAt && (
                              <p className="mt-1 text-xs text-slate-400">
                                Expires: {new Date(coupon.expiresAt).toLocaleDateString("th-TH")}
                              </p>
                            )}
                          </div>

                          <Button
                            type="button"
                            size="sm"
                            disabled={!coupon.canUse}
                            onClick={() => handleApplyCoupon(coupon.code, coupon)}
                            className="shrink-0"
                          >
                            Use
                          </Button>
                        </div>

                        {!coupon.canUse && (
                          <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
                            Buy ฿{formatBaht(coupon.needMoreAmount)} more to use this coupon.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
