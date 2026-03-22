import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Upload, CheckCircle, AlertCircle, QrCode } from "lucide-react";
import { toast } from "sonner";

const QR_PAYMENT_IMAGE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_8beb9f9a.jpeg";

export default function PaymentPage() {
  const { user, isAuthenticated } = useAuth();
  const { t } = useLanguage();
  const [, navigate] = useLocation();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [pointsToRedeem, setPointsToRedeem] = useState("");

  // Fetch checkout preview - cart-based totals without creating order
  const { data: previewData, isLoading: previewLoading, error: previewError } = trpc.checkout.preview.useQuery(
    {
      couponCode: couponCode ? couponCode.trim().toUpperCase() : undefined,
      pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined,
    },
    { enabled: isAuthenticated }
  );

  // Submit payment slip and create order atomically
  const submitPaymentMutation = trpc.checkout.submitPayment.useMutation({
    onSuccess: () => {
      setIsUploading(false);
      setIsSubmitting(false);
      toast.success(t("payment.slipUploadSuccess"));
      setSelectedFile(null);
      // Redirect to orders page after successful submission
      navigate("/orders");
    },
    onError: (error: any) => {
      setIsUploading(false);
      setIsSubmitting(false);
      const errorMessage = error?.message || t("payment.slipUploadError");
      toast.error(errorMessage);
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
    // Duplicate-submit protection
    if (isSubmitting || isUploading) {
      return;
    }

    if (!selectedFile) {
      toast.error(t("payment.selectFileFirst"));
      return;
    }

    if (!previewData) {
      toast.error("Unable to load checkout details");
      return;
    }

    setIsSubmitting(true);
    setIsUploading(true);
    try {
      // Convert file to base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const result = e.target?.result as string;
          resolve(result);
        };
        reader.onerror = () => reject(new Error("File read failed"));
        reader.readAsDataURL(selectedFile);
      });

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
        const errorData = await uploadResponse.json().catch(() => ({}));
        throw new Error(errorData.error || "Upload failed");
      }

      const uploadResult = await uploadResponse.json();
      const url = uploadResult.url;

      if (!url) {
        throw new Error("No upload URL returned");
      }

      console.log("Upload successful, URL:", url);

      // Submit payment: creates order, orderItems, payment, and clears cart atomically
      await submitPaymentMutation.mutateAsync({
        couponCode: couponCode ? couponCode.trim().toUpperCase() : undefined,
        pointsToRedeem: pointsToRedeem ? pointsToRedeem.trim() : undefined,
        slipImageUrl: url,
      });
    } catch (error) {
      console.error("Upload error:", error);
      setIsUploading(false);
      setIsSubmitting(false);
      toast.error(t("payment.uploadFailed"));
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

  // Loading preview data
  if (previewLoading) {
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

  // Preview error or no data
  if (previewError || !previewData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
            <p className="text-slate-600 mb-4">{t("payment.orderNotFound")}</p>
            <Button onClick={() => navigate("/cart")}>{t("nav.backToCart")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { cartItems, subtotal, discountAmount, pointsDiscountAmount, totalAmount } = previewData;

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="container mx-auto px-4 max-w-2xl space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">{t("payment.title")}</h1>
          <Button variant="outline" onClick={() => navigate("/")}>{t("nav.home")}</Button>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Left: QR Code */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <QrCode className="w-5 h-5" />
                {t("payment.qrCode")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <img src={QR_PAYMENT_IMAGE} alt="QR Code" className="w-full rounded-lg" />
              <p className="text-sm text-slate-600 mt-4">{t("payment.scanToTransfer")}</p>
            </CardContent>
          </Card>

          {/* Right: Payment Details */}
          <div className="space-y-6">
            {/* Order Summary */}
            <Card>
              <CardHeader>
                <CardTitle>{t("payment.orderSummary")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Items */}
                <div className="space-y-2 pb-4 border-b">
                  {cartItems.map((item: any, idx: number) => (
                    <div key={idx} className="flex justify-between text-sm">
                      <span className="text-slate-600">
                        {item.novel?.title} - Episode {item.episode?.episodeNumber}
                      </span>
                      <span className="font-semibold">฿{parseFloat(item.price.toString()).toFixed(2)}</span>
                    </div>
                  ))}
                </div>

                {/* Totals */}
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-600">{t("payment.subtotal")}</span>
                    <span>฿{subtotal}</span>
                  </div>
                  {parseFloat(discountAmount) > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>{t("payment.discount")}</span>
                      <span>-฿{discountAmount}</span>
                    </div>
                  )}
                  {parseFloat(pointsDiscountAmount) > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>{t("payment.pointsDiscount")}</span>
                      <span>-฿{pointsDiscountAmount}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-lg pt-2 border-t">
                    <span>{t("payment.total")}</span>
                    <span className="text-blue-600">฿{totalAmount}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Upload Slip */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="w-5 h-5" />
                  {t("payment.uploadSlip")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center">
                  <input
                    type="file"
                    id="slip-upload"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={handleFileSelect}
                    disabled={isUploading || isSubmitting}
                    className="hidden"
                  />
                  <label htmlFor="slip-upload" className="cursor-pointer">
                    <div className="text-slate-600">
                      {selectedFile ? (
                        <div>
                          <CheckCircle className="w-8 h-8 text-green-600 mx-auto mb-2" />
                          <p className="font-semibold">{selectedFile.name}</p>
                          <p className="text-sm">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                      ) : (
                        <div>
                          <Upload className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                          <p>{t("payment.clickToUpload")}</p>
                          <p className="text-sm text-slate-500">{t("payment.supportedFormats")}</p>
                        </div>
                      )}
                    </div>
                  </label>
                </div>

                <Button
                  onClick={handleUploadSlip}
                  disabled={!selectedFile || isUploading || isSubmitting || submitPaymentMutation.isPending}
                  className="w-full"
                >
                  {isUploading || isSubmitting || submitPaymentMutation.isPending ? t("payment.submitting") : t("payment.submitPayment")}
                </Button>

                <p className="text-xs text-slate-500 text-center">{t("payment.uploadNote")}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
