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
      setShowSlipUpload(false);
      setSelectedSlipFile(null);
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

  const uploadSlipFileMutation = trpc.payment.uploadSlipFile.useMutation();

  const fileToBase64 = async (file: File): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        resolve(result);
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">Please sign in to view your cart</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (cartLoading) {
    return (
      <div className="container max-w-4xl py-8">
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const subtotalNum = parseFloat(subtotal);
  const discountNum = parseFloat(discountAmount);
  const safePointsToRedeem = pointsToRedeem ? Math.min(parseFloat(pointsToRedeem), subtotalNum - discountNum) : 0;
  const total = Math.max(0, subtotalNum - discountNum - safePointsToRedeem).toFixed(2);

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

      // Step 1: Upload file to S3
      const base64 = await fileToBase64(selectedSlipFile);
      const mimeType = selectedSlipFile.type as "image/jpeg" | "image/png" | "application/pdf";
      const uploadResult = await uploadSlipFileMutation.mutateAsync({
        fileName: selectedSlipFile.name,
        mimeType,
        fileBase64: base64,
        context: "checkout",
      });

      // Step 2: Create order with the uploaded slip URL
      const orderResult = await createOrderMutation.mutateAsync({
        couponCode: appliedCouponCode || undefined,
        pointsToRedeem: safePointsToRedeem > 0 ? safePointsToRedeem.toFixed(2) : undefined,
        slipImageUrl: uploadResult.slipImageUrl,
      });

      // Show user-friendly message based on OCR/payment result
      if (orderResult?.slipResult) {
        const sr = orderResult.slipResult;
        let msg = "Payment submitted successfully.";
        
        if (sr.status === "approved") {
          msg = "Payment approved automatically! Your order is confirmed.";
        } else if (sr.status === "pending_review") {
          if (sr.reviewReason === "OCR_PROCESSING_ERROR") {
            msg = "Payment slip received. Our system encountered an issue, but our team will review it manually.";
          } else if (sr.duplicateStatus?.isDuplicateReference || sr.duplicateStatus?.isDuplicateFingerprint) {
            msg = "Payment slip received. It appears to be a duplicate, but our team will review it.";
          } else if (sr.ocrConfidence && sr.ocrConfidence < 85) {
            msg = `Payment slip received (confidence: ${sr.ocrConfidence}%). Our team will review it shortly.`;
          } else {
            msg = "Payment slip received. Our team will review and approve it shortly.";
          }
        }
        
        toast.success(msg);
      } else {
        toast.success("Order created successfully.");
      }
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
    setShowSlipUpload(true);
  };

  const handleSlipFileSelect = (file: File | null) => {
    if (!file) {
      setSelectedSlipFile(null);
      setSlipPreview(null);
      return;
    }

    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
      toast.error(t("payment.invalidFileType"));
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error(t("payment.fileTooLarge"));
      return;
    }

    setSelectedSlipFile(file);

    const reader = new FileReader();
    reader.onload = (e) => {
      setSlipPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="container max-w-4xl py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">{t("nav.cart")}</h1>
        <ShoppingCart className="w-8 h-8 text-blue-600" />
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center">
            <ShoppingCart className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <p className="text-slate-600">{t("cart.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            {items.map((item: any) => (
              <Card key={item.id}>
                <CardContent className="pt-6">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h3 className="font-semibold text-lg">{item.novelTitle}</h3>
                      <p className="text-sm text-slate-600">{item.episodeTitle}</p>
                      <p className="text-sm text-slate-500 mt-1">{t("common.episode")}: {item.episodeNumber}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-lg">{formatBaht(item.price)} {t("common.baht")}</p>
                      <button
                        onClick={() => removeFromCartMutation.mutate({ cartItemId: item.id })}
                        className="text-red-600 hover:text-red-700 mt-2 flex items-center gap-1"
                      >
                        <Trash2 className="w-4 h-4" />
                        {t("common.remove")}
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="lg:col-span-1">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle>{t("cart.summary")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between text-sm">
                  <span>{t("cart.subtotal")}</span>
                  <span>{formatBaht(subtotal)} {t("common.baht")}</span>
                </div>

                {appliedCoupon && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>{t("cart.discount")}</span>
                    <span>-{formatBaht(discountAmount)} {t("common.baht")}</span>
                  </div>
                )}

                {safePointsToRedeem > 0 && (
                  <div className="flex justify-between text-sm text-blue-600">
                    <span>{t("cart.pointsRedeemed")}</span>
                    <span>-{formatBaht(safePointsToRedeem)} {t("common.baht")}</span>
                  </div>
                )}

                <div className="border-t pt-4 flex justify-between font-bold">
                  <span>{t("cart.total")}</span>
                  <span>{formatBaht(total)} {t("common.baht")}</span>
                </div>

                {!appliedCoupon && (
                  <div className="space-y-2">
                    <button
                      onClick={() => setShowCouponPicker(true)}
                      className="w-full px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center justify-center gap-2"
                    >
                      <TicketPercent className="w-4 h-4" />
                      {t("cart.applyCoupon")}
                    </button>
                  </div>
                )}

                {appliedCoupon && (
                  <div className="bg-green-50 p-3 rounded border border-green-200 flex items-center justify-between">
                    <span className="text-sm text-green-700 font-semibold">{appliedCoupon.code}</span>
                    <button onClick={handleClearCoupon} className="text-green-600 hover:text-green-700">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}

                <div className="space-y-2 pt-4 border-t">
                  <Button
                    onClick={handleCheckout}
                    className="w-full bg-blue-600 hover:bg-blue-700"
                    disabled={isUploadingSlip || createOrderMutation.isPending}
                  >
                    {isUploadingSlip ? t("common.loading") : t("cart.proceedToPayment")}
                  </Button>
                  <Button
                    onClick={() => walletCheckoutMutation.mutate({ couponCode: appliedCouponCode || undefined, pointsToRedeem: safePointsToRedeem > 0 ? safePointsToRedeem.toFixed(2) : undefined })}
                    variant="outline"
                    className="w-full"
                    disabled={walletCheckoutMutation.isPending}
                  >
                    {t("wallet.payWithWallet")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {showCouponPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>{t("cart.applyCoupon")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={couponInput}
                  onChange={(e) => setCouponInput(e.target.value)}
                  placeholder={t("cart.couponCode")}
                  onKeyPress={(e) => e.key === "Enter" && handleValidateCoupon()}
                />
                <Button onClick={handleValidateCoupon} className="bg-blue-600 hover:bg-blue-700">
                  {t("common.apply")}
                </Button>
              </div>

              {activeCoupons.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">{t("cart.availableCoupons")}</p>
                  {activeCoupons.map((coupon: any) => (
                    <button
                      key={coupon.id}
                      onClick={() => handleApplyCoupon(coupon.code, coupon)}
                      className="w-full p-3 border rounded text-left hover:bg-blue-50 transition"
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-semibold text-blue-600">{coupon.code}</span>
                        <span className="text-sm text-slate-600">
                          {coupon.discountType === "percentage" ? `${coupon.discountValue}%` : `${formatBaht(coupon.discountValue)}`}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <Button onClick={() => setShowCouponPicker(false)} variant="outline" className="w-full">
                {t("common.close")}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {showSlipUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <Card className="w-full max-w-md my-8">
            <CardHeader>
              <CardTitle>{t("payment.uploadSlip")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                <p className="text-sm text-blue-700 mb-1">ยอดที่ต้องโอน</p>
                <p className="text-2xl font-bold text-blue-900">{formatBaht(total)} {t("common.baht")}</p>
              </div>

              <div className="bg-amber-50 p-3 rounded-lg border border-amber-200 flex gap-2">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800">
                  {t("payment.pdfNote") || "PDF files will be reviewed manually. JPG/PNG files may be auto-approved."}
                </p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700">{t("payment.selectFile")}</label>
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(e) => handleSlipFileSelect(e.target.files?.[0] || null)}
                  disabled={isUploadingSlip}
                  className="w-full px-3 py-2 border rounded text-sm"
                />
                <p className="text-xs text-slate-500">{t("payment.fileRequirements")}</p>

                {selectedSlipFile && (
                  <div className="bg-green-50 p-3 rounded border border-green-200 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-green-700">{selectedSlipFile.name}</p>
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

                {slipPreview && (
                  <div className="relative">
                    <img src={slipPreview} alt="Preview" className="w-full h-48 object-cover rounded border" />
                    <button
                      onClick={() => setShowQRFullscreen(true)}
                      className="absolute top-2 right-2 bg-white/80 hover:bg-white p-2 rounded"
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleCheckoutWithSlip}
                  className="flex-1 bg-blue-600 hover:bg-blue-700"
                  disabled={!selectedSlipFile || isUploadingSlip}
                >
                  {isUploadingSlip ? t("common.uploading") : t("payment.uploadAndCheckout")}
                </Button>
                <Button
                  onClick={() => {
                    setShowSlipUpload(false);
                    setSelectedSlipFile(null);
                    setSlipPreview(null);
                  }}
                  variant="outline"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showQRFullscreen && slipPreview && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4">
          <div className="relative max-w-2xl w-full">
            <img src={slipPreview} alt="Full Preview" className="w-full h-auto rounded" />
            <button
              onClick={() => setShowQRFullscreen(false)}
              className="absolute top-4 right-4 bg-white/80 hover:bg-white p-2 rounded"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
