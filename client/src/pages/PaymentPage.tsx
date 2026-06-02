import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation, useParams } from "wouter";
import { Upload, CheckCircle, AlertCircle, QrCode } from "lucide-react";
import { toast } from "sonner";
import { getLoginUrl } from "@/const";

const QR_PAYMENT_IMAGE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_8beb9f9a.jpeg";

export default function PaymentPage() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Get order ID from URL params using wouter's useParams
  const params = useParams();
  const parsedId = params?.orderId ? parseInt(params.orderId, 10) : null;
  const orderId = parsedId && !isNaN(parsedId) && parsedId > 0 ? parsedId : null;



  // Fetch order details - only when authenticated and we have a valid orderId
  const { data: orderData, isLoading: orderLoading, error: orderError } = trpc.orders.detail.useQuery(
    { orderId: orderId || 0 },
    { enabled: isAuthenticated && orderId !== null && orderId > 0 }
  );



  const uploadSlipFileMutation = trpc.payment.uploadSlipFile.useMutation();
  const submitPaymentSlipMutation = trpc.orders.uploadPaymentSlip.useMutation({
    onSuccess: () => {
      setSelectedFile(null);
      navigate("/orders");
    },
    onError: (error) => {
      setIsUploading(false);
      toast.error(error?.message || t("payment.slipUploadError"));
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file type
      if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
        toast.error(t("payment.invalidFileType"));
        return;
      }
      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        toast.error(t("payment.fileTooLarge"));
        return;
      }
      setSelectedFile(file);
    }
  };

  const handleUploadSlip = async () => {
    if (!selectedFile) {
      toast.error(t("payment.selectFileFirst"));
      return;
    }

    setIsUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const result = e.target?.result as string;
          resolve(result);
        };
        reader.onerror = () => reject(new Error("File read failed"));
        reader.readAsDataURL(selectedFile);
      });

      // Step 1: Upload file to S3
      const mimeType = selectedFile.type as "image/jpeg" | "image/png" | "application/pdf";
      const uploadResult = await uploadSlipFileMutation.mutateAsync({
        fileName: selectedFile.name,
        mimeType,
        fileBase64: base64,
        context: "payment_page",
      });

      // Step 2: Submit uploaded slip to order
      const submitResult = await submitPaymentSlipMutation.mutateAsync({
        orderId: orderId || 0,
        slipImageUrl: uploadResult.slipImageUrl,
      });

      // Show message based on OCR/payment result, not upload result
      setIsUploading(false);
      if (submitResult) {
        let msg = "Payment submitted successfully.";
        
        if (submitResult.status === "approved") {
          msg = "Payment approved automatically! Your order is confirmed.";
        } else if (submitResult.status === "pending_review") {
          if (submitResult.reviewReason === "OCR_PROCESSING_ERROR") {
            msg = "Payment slip received. Our system encountered an issue, but our team will review it manually.";
          } else if (submitResult.duplicateStatus?.isDuplicateReference || submitResult.duplicateStatus?.isDuplicateFingerprint) {
            msg = "Payment slip received. It appears to be a duplicate, but our team will review it.";
          } else if (submitResult.ocrConfidence && submitResult.ocrConfidence < 85) {
            msg = `Payment slip received (confidence: ${submitResult.ocrConfidence}%). Our team will review it shortly.`;
          } else {
            msg = "Payment slip received. Our team will review and approve it shortly.";
          }
        }
        
        toast.success(msg);
      } else {
        toast.success("Payment slip submitted successfully.");
      }
    } catch (error) {
      console.error("Upload error:", error);
      setIsUploading(false);
      toast.error(error instanceof Error ? error.message : t("payment.uploadFailed"));
    }
  };

  // Not authenticated
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-slate-600 mb-4">{t("common.pleaseSignIn")}</p>
            <Button asChild>
              <a href={getLoginUrl()}>{t("nav.login")}</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Invalid order ID in URL
  if (orderId === null || orderId <= 0) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
            <p className="text-slate-600 mb-4">{t("payment.invalidOrder")}</p>
            <Button onClick={() => navigate("/cart")}>{t("nav.backToCart")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading order data
  if (orderLoading) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4 max-w-2xl space-y-6">
          <Skeleton className="h-12 w-48" />
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  // Order not found
  if (orderError || !orderData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
            <p className="text-slate-600 mb-4">{t("payment.orderNotFound")}</p>
            <Button onClick={() => navigate("/orders")}>{t("nav.viewOrders")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { order, payment } = orderData;

  // Check if already approved
  if (payment?.status === "approved") {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4 max-w-2xl">
          <Card>
            <CardHeader className="bg-green-50">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-6 h-6 text-green-600" />
                <CardTitle>{t("payment.alreadyApproved")}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-6 text-center">
              <p className="text-slate-600 mb-4">{t("payment.approvedMessage")}</p>
              <Button onClick={() => navigate("/orders")}>{t("nav.viewOrders")}</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 max-w-2xl space-y-6">
        {/* Order Summary */}
        <Card>
          <CardHeader>
            <CardTitle>{t("payment.orderSummary")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between">
              <span className="text-slate-600">{t("payment.orderNumber")}:</span>
              <span className="font-semibold">{order?.orderNumber}</span>
            </div>

            {/* Pricing Breakdown */}
            <div className="space-y-2 p-3 bg-slate-50 rounded">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">ยอดรวมสินค้า</span>
                <span className="font-semibold">฿{order?.subtotal ? parseFloat(order.subtotal.toString()).toFixed(2) : "0.00"}</span>
              </div>
              {order?.discountAmount && parseFloat(order.discountAmount.toString()) > 0 && (
                <div className="flex justify-between text-sm text-red-600">
                  <div>
                    <span className="text-slate-600">ส่วนลดคูปอง</span>
                    {order.couponCodeSnapshot && (
                      <p className="text-xs text-slate-500">{order.couponCodeSnapshot}</p>
                    )}
                  </div>
                  <span className="font-semibold">-฿{parseFloat(order.discountAmount.toString()).toFixed(2)}</span>
                </div>
              )}
              {order?.pointsDiscountAmount && parseFloat(order.pointsDiscountAmount.toString()) > 0 && (
                <div className="flex justify-between text-sm text-red-600">
                  <span className="text-slate-600">ส่วนลดจากคะแนน</span>
                  <span className="font-semibold">-฿{parseFloat(order.pointsDiscountAmount.toString()).toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm pt-2 border-t border-slate-200 font-semibold">
                <span>ยอดชำระสุทธิ</span>
                <span className="text-blue-600">฿{parseFloat(order?.totalAmount.toString()).toFixed(2)}</span>
              </div>
            </div>

            <div className="flex justify-between">
              <span className="text-slate-600">{t("payment.status")}:</span>
              <span className="font-semibold">{payment?.status ? t(`status.${payment.status}`) : t("status.pending")}</span>
            </div>
          </CardContent>
        </Card>

        {/* QR Code Payment */}
        <Card>
          <CardHeader>
            <CardTitle>{t("payment.qrPayment")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <img src={QR_PAYMENT_IMAGE} alt="QR Code" className="w-64 h-64 mx-auto" />
            <p className="text-sm text-slate-600 text-center">{t("payment.scanQr")}</p>
          </CardContent>
        </Card>

        {/* Slip Upload */}
        <Card>
          <CardHeader>
            <CardTitle>{t("payment.uploadSlip")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                {t("payment.selectFile")}
              </label>
              <Input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                onChange={handleFileSelect}
                disabled={isUploading}
              />
              <p className="text-xs text-slate-500">{t("payment.fileRequirements")}</p>
            </div>

            {selectedFile && (
              <div className="bg-blue-50 p-3 rounded text-sm text-blue-800">
                {t("payment.selectedFile")}: {selectedFile.name}
              </div>
            )}

            <Button
              onClick={handleUploadSlip}
              disabled={!selectedFile || isUploading}
              className="w-full"
            >
              <Upload className="w-4 h-4 mr-2" />
              {isUploading ? t("common.uploading") : t("payment.uploadButton")}
            </Button>
          </CardContent>
        </Card>

        {/* Help Section */}
        <Card>
          <CardHeader>
            <CardTitle>{t("payment.helpTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            <p>• {t("payment.uploadNote")}</p>
            <p>• {t("payment.reviewTime")}</p>
            <p>• {t("payment.contactSupport")}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
