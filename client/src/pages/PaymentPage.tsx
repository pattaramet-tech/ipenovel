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



  const uploadPaymentSlipMutation = trpc.orders.uploadPaymentSlip.useMutation({
    onSuccess: () => {
      setIsUploading(false);
      toast.success(t("payment.slipUploadSuccess"));
      setSelectedFile(null);
      // Redirect to orders page after successful upload
      navigate("/orders");
    },
    onError: (error) => {
      setIsUploading(false);
      toast.error(t("payment.slipUploadError"));
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
      // Convert file to base64
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        
        // Upload to S3 via backend
        const uploadResponse = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: base64,
            filename: selectedFile.name,
            type: selectedFile.type,
          }),
        });

        if (!uploadResponse.ok) {
          throw new Error("Upload failed");
        }

        const { url } = await uploadResponse.json();

        // Submit payment slip
        await uploadPaymentSlipMutation.mutateAsync({
          orderId: orderId || 0,
          slipImageUrl: url,
        });
      };
      reader.readAsDataURL(selectedFile);
    } catch (error) {
      toast.error(t("payment.uploadFailed"));
      setIsUploading(false);
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
              <a href="/login">{t("nav.login")}</a>
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

  // Error loading order or order not found
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

  const { order, items, payment } = orderData;
  const totalAmount = parseFloat(order.totalAmount.toString()).toFixed(2);
  
  // Determine payment state based on payment record and order status
  const isApproved = payment?.status === "approved" || order?.paymentStatus === "approved";
  const isRejected = payment?.status === "rejected";
  
  // Check if slip has been submitted and is pending review
  // This happens when payment exists with status "pending" and slipImageUrl is set
  const isSlipSubmittedPendingReview = payment?.slipImageUrl && payment?.status === "pending";
  
  // Show upload UI if:
  // 1. Payment is not approved AND
  // 2. (No payment record exists OR payment is rejected OR (payment is pending but no slip uploaded yet))
  const canUploadSlip = !isApproved && (!payment || payment.status === "rejected" || (payment.status === "pending" && !payment.slipImageUrl));

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 max-w-2xl">
        <h1 className="text-3xl font-bold mb-2">{t("payment.title")}</h1>
        <p className="text-slate-600 mb-8">{t("payment.subtitle")}</p>

        <div className="space-y-6">
          {/* Order Summary Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t("payment.orderSummary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between">
                <span className="text-slate-600">{t("payment.orderNumber")}</span>
                <span className="font-semibold">#{order.orderNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">{t("payment.items")}</span>
                <span className="font-semibold">{items?.length || 0}</span>
              </div>
              <div className="border-t pt-4 flex justify-between">
                <span className="text-lg font-semibold">{t("payment.totalAmount")}</span>
                <span className="text-2xl font-bold text-blue-600">฿{totalAmount}</span>
              </div>
            </CardContent>
          </Card>

          {/* QR Payment Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <QrCode className="w-5 h-5" />
                {t("payment.scanAndPay")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-white p-8 rounded-lg flex justify-center">
                <img
                  src={QR_PAYMENT_IMAGE}
                  alt="QR Payment"
                  className="w-full max-w-sm h-auto"
                />
              </div>
              <div className="bg-blue-50 p-4 rounded-lg">
                <p className="text-sm text-slate-700 mb-2 font-semibold">{t("payment.instructions")}</p>
                <ol className="text-sm text-slate-600 space-y-1 list-decimal list-inside">
                  <li>{t("payment.step1")}</li>
                  <li>{t("payment.step2")}</li>
                  <li>{t("payment.step3")}</li>
                </ol>
              </div>
            </CardContent>
          </Card>

          {/* Payment Status Cards */}
          {isApproved ? (
            <Card className="border-green-200 bg-green-50">
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-green-600" />
                  <div>
                    <p className="font-semibold text-green-900">{t("payment.approved")}</p>
                    <p className="text-sm text-green-700">{t("payment.accessGranted")}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : isRejected ? (
            <>
              <Card className="border-red-200 bg-red-50">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="w-6 h-6 text-red-600" />
                    <div>
                      <p className="font-semibold text-red-900">{t("payment.rejected")}</p>
                      {payment?.rejectionReason && (
                        <p className="text-sm text-red-700 mt-2">{t("payment.rejectionReason")}: {payment.rejectionReason}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Upload className="w-5 h-5" />
                    {t("payment.uploadNewSlip")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                    <input
                      type="file"
                      id="slip-upload-retry"
                      className="hidden"
                      accept="image/jpeg,image/png,application/pdf"
                      onChange={handleFileSelect}
                    />
                    <label
                      htmlFor="slip-upload-retry"
                      className="cursor-pointer block"
                    >
                      <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-slate-900">
                        {selectedFile ? selectedFile.name : t("payment.clickToUpload")}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">{t("payment.fileFormats")}</p>
                    </label>
                  </div>

                  {selectedFile && (
                    <div className="bg-blue-50 p-3 rounded-lg flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-blue-600" />
                      <span className="text-sm text-blue-900">{t("payment.fileSelected")}: {selectedFile.name}</span>
                    </div>
                  )}

                  <Button
                    className="w-full"
                    onClick={handleUploadSlip}
                    disabled={!selectedFile || isUploading || uploadPaymentSlipMutation.isPending}
                  >
                    {isUploading || uploadPaymentSlipMutation.isPending ? t("common.loading") : t("payment.submitSlip")}
                  </Button>
                </CardContent>
              </Card>
            </>
          ) : isSlipSubmittedPendingReview ? (
            <Card className="border-blue-200 bg-blue-50">
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-blue-600" />
                  <div>
                    <p className="font-semibold text-blue-900">{t("payment.slipSubmitted")}</p>
                    <p className="text-sm text-blue-700">{t("payment.pendingReview")}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : canUploadSlip ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="w-5 h-5" />
                  {t("payment.uploadSlip")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
                  <input
                    type="file"
                    id="slip-upload"
                    className="hidden"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={handleFileSelect}
                  />
                  <label
                    htmlFor="slip-upload"
                    className="cursor-pointer block"
                  >
                    <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm font-semibold text-slate-900">
                      {selectedFile ? selectedFile.name : t("payment.clickToUpload")}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">{t("payment.fileFormats")}</p>
                  </label>
                </div>

                {selectedFile && (
                  <div className="bg-blue-50 p-3 rounded-lg flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-blue-600" />
                    <span className="text-sm text-blue-900">{t("payment.fileSelected")}: {selectedFile.name}</span>
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleUploadSlip}
                  disabled={!selectedFile || isUploading || uploadPaymentSlipMutation.isPending}
                >
                  {isUploading || uploadPaymentSlipMutation.isPending ? t("common.loading") : t("payment.submitSlip")}
                </Button>

                <p className="text-xs text-slate-500 text-center">
                  {t("payment.uploadNote")}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* Help Card */}
          <Card className="bg-amber-50 border-amber-200">
            <CardContent className="pt-6">
              <div className="flex gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="font-semibold mb-2">{t("payment.helpTitle")}</p>
                  <p>{t("payment.helpText")}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
