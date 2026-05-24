import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { Upload, CheckCircle, AlertCircle, X } from "lucide-react";

const QR_PAYMENT_IMAGE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_19d96370.JPG";

export default function WalletPage() {
  const auth = useAuth();
  const { t } = useLanguage();
  const [showTopupForm, setShowTopupForm] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeTopupId, setActiveTopupId] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [filePreview, setFilePreview] = useState<string | null>(null);

  const { data: summary, isLoading, refetch: refetchSummary } = trpc.wallet.getSummary.useQuery();
  const createTopupMutation = trpc.wallet.createTopupRequest.useMutation();
  const uploadPaymentSlipMutation = trpc.payment.uploadSlip.useMutation();

  const handleFileSelect = (file: File | null) => {
    setSelectedFile(file);
    if (file && file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const handleCreateTopupWithSlip = async () => {
    // Validate amount
    if (!topupAmount || parseFloat(topupAmount) <= 0) {
      toast.error(t("wallet.pleaseEnterValidAmount"));
      return;
    }
    // Validate file
    if (!selectedFile) {
      toast.error(t("wallet.pleaseSelectFile"));
      return;
    }

    try {
      setIsUploading(true);
      setIsCreatingRequest(true);

      // Step 1: Upload slip first
      const slipImageUrl = await uploadFile(selectedFile);

      // Step 2: Create top-up request with slip URL
      const result = await createTopupMutation.mutateAsync({
        requestedAmount: topupAmount,
        slipImageUrl,
      });

      // Success: Reset form and show confirmation
      setTopupAmount("");
      setSelectedFile(null);
      setShowTopupForm(false);
      toast.success(t("wallet.topupRequestCreated"));
      refetchSummary();
    } catch (error: any) {
      toast.error(error.message || t("wallet.failedToCreateTopup"));
    } finally {
      setIsUploading(false);
      setIsCreatingRequest(false);
    }
  };

  const uploadFile = async (file: File): Promise<string> => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        resolve(result);
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });

    const result = await uploadPaymentSlipMutation.mutateAsync({
      slipImageUrl: base64,
      context: "wallet",
    });

    return result.slipImageUrl;
  };

  if (isLoading) return <div className="p-4 text-center">{t("common.loading")}</div>;

  // Policy message for non-refundable wallet (use translation keys)

  // Find the active top-up for payment step
  const activeTopup = activeTopupId
    ? summary?.recentTopups?.find((t: any) => t.id === activeTopupId)
    : null;

  // Old payment step is now removed - slip is uploaded before creating the top-up request
  // This keeps the UI cleaner and prevents incomplete records

  // Main wallet page
  return (
    <div className="container max-w-2xl py-8">
      <h1 className="text-3xl font-bold mb-6">{t("wallet.title")}</h1>

      {/* Policy Notice Card - Visible and Prominent */}
      <Card className="p-6 mb-6 border-l-4 border-l-red-500 bg-red-50">
        <div className="flex gap-3">
          <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h2 className="text-lg font-bold text-red-900 mb-3">{t("wallet.policyTitle")}</h2>
            <ul className="space-y-2 text-sm text-red-800">
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint1")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint2")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint3")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint4")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint5")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint6")}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-red-600 font-bold">•</span>
                <span>{t("wallet.policyPoint7")}</span>
              </li>
            </ul>
          </div>
        </div>
      </Card>

      {/* Balance Card */}
      <Card className="p-6 mb-6">
        <div className="text-sm text-gray-600">{t("wallet.currentBalance")}</div>
        <div className="text-4xl font-bold">฿{summary?.balance || "0.00"}</div>
      </Card>

      {/* Top-up Section */}
      <Card className="p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">{t("wallet.topupRequests")}</h2>
        {!showTopupForm ? (
          <Button onClick={() => setShowTopupForm(true)}>{t("wallet.requestTopup")}</Button>
        ) : (
          <div className="space-y-6">
            {/* 1. Amount Input with Live Bonus Preview */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                {t("wallet.topupAmount")}
              </label>
              <input
                type="number"
                placeholder={t("wallet.topupAmount")}
                value={topupAmount}
                onChange={(e) => setTopupAmount(e.target.value)}
                disabled={isUploading || isCreatingRequest}
                className="w-full px-3 py-2 border rounded"
              />
              
              {/* Live Bonus Preview */}
              {topupAmount && parseFloat(topupAmount) > 0 && (
                <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-700">Requested Amount:</span>
                      <span className="font-semibold">฿{parseFloat(topupAmount).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-700">Bonus:</span>
                      <span className="font-semibold text-green-600">
                        {parseFloat(topupAmount) >= 500 ? "+฿20.00" : parseFloat(topupAmount) >= 250 ? "+฿10.00" : "ไม่มีโบนัส"}
                      </span>
                    </div>
                    <div className="border-t border-blue-200 pt-2 mt-2 flex justify-between">
                      <span className="font-semibold text-slate-900">Total to be Credited:</span>
                      <span className="font-bold text-lg text-green-700">
                        ฿{(
                          parseFloat(topupAmount) + (
                            parseFloat(topupAmount) >= 500 ? 20 :
                            parseFloat(topupAmount) >= 250 ? 10 : 0
                          )
                        ).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 2. QR Payment Block */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-slate-800">{t("wallet.scanQRToPayment")}</h3>
              <Card className="p-6 bg-slate-50 border-2 border-slate-200">
                <div className="flex flex-col items-center">
                  <img
                    src={QR_PAYMENT_IMAGE}
                    alt="QR Payment"
                    className="w-full max-w-sm aspect-square object-contain rounded-lg"
                  />
                </div>
              </Card>
              <p className="text-sm text-slate-600 mt-3 text-center">
                {t("wallet.qrPaymentHelper")}
              </p>
              <p className="text-sm text-slate-500 mt-2 text-center">
                โอนตามยอดที่กรอกด้านบน
              </p>
            </div>

            {/* 3. Slip Upload */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                {t("wallet.selectPaymentSlip")}
              </label>
              
              {/* Custom File Input */}
              <div className="relative">
                <input
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
                  disabled={isUploading || isCreatingRequest}
                  className="hidden"
                  id="slip-file-input"
                />
                <label
                  htmlFor="slip-file-input"
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition"
                >
                  <Upload className="w-5 h-5 text-slate-600" />
                  <span className="text-sm font-medium text-slate-700">
                    {selectedFile ? t("wallet.selected") : "เลือกรูปสลิป"}
                  </span>
                </label>
              </div>
              
              {/* Selected File Info */}
              {selectedFile && (
                <div className="bg-green-50 p-3 rounded-lg border border-green-200 flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-green-900 truncate">{selectedFile.name}</p>
                      <p className="text-xs text-green-700">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedFile(null);
                      setFilePreview(null);
                      const input = document.getElementById("slip-file-input") as HTMLInputElement;
                      if (input) input.value = "";
                    }}
                    className="text-green-600 hover:text-green-700 flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
              
              {/* Image Preview */}
              {filePreview && (
                <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50 p-2">
                  <img
                    src={filePreview}
                    alt="Slip preview"
                    className="w-full max-h-48 object-contain rounded"
                  />
                </div>
              )}
              
              <p className="text-xs text-slate-500">
                {t("wallet.acceptedFormats")}
              </p>
            </div>

            {/* 4. Submit Button */}
            <div className="flex gap-2">
              <Button
                onClick={handleCreateTopupWithSlip}
                disabled={!topupAmount || !selectedFile || isUploading || isCreatingRequest}
                className="flex-1"
              >
                {isUploading || isCreatingRequest ? t("common.pleaseWait") : t("wallet.createRequest")}
              </Button>
              <Button variant="outline" onClick={() => {
                setShowTopupForm(false);
                setTopupAmount("");
                setSelectedFile(null);
              }} disabled={isUploading || isCreatingRequest}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Bonus Rule Hint */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm">
          <p className="font-semibold text-blue-900 mb-1">กติกาโบนัส:</p>
          <ul className="text-blue-800 text-xs space-y-1">
            <li>• ยอดเติมน้อยกว่า ฿250: ไม่มีโบนัส</li>
            <li>• ยอดเติม ฿250 - ฿499: รับโบนัสเพิ่ม ฿10</li>
            <li>• ยอดเติม ฿500 ขึ้นไป: รับโบนัสเพิ่ม ฿20</li>
          </ul>
        </div>

        {/* Top-up Requests List */}
        <div className="mt-6 space-y-3">
          {summary?.recentTopups && summary.recentTopups.length > 0 ? (
            summary.recentTopups.map((topup: any) => (
              <div key={topup.id} className="border rounded p-3 flex justify-between items-start">
                <div className="flex-1">
                  <div className="font-semibold">฿{topup.requestedAmount}</div>
                  {(topup.bonusAmount || topup.creditedAmount) && (
                    <div className="text-xs text-gray-600 mt-1">
                      {topup.bonusAmount && <div>Bonus: +฿{topup.bonusAmount}</div>}
                      {topup.creditedAmount && <div className="font-semibold text-green-700">Total Credited: ฿{topup.creditedAmount}</div>}
                    </div>
                  )}
                  <div className="text-sm text-gray-600 mt-1">{new Date(topup.createdAt).toLocaleDateString()}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge variant={topup.status === "pending" ? "outline" : topup.status === "approved" ? "default" : "destructive"}>
                    {topup.status === "pending" && t("order.status.pending")}
                    {topup.status === "approved" && t("order.status.approved")}
                    {topup.status === "rejected" && t("order.status.rejected")}
                  </Badge>
                  {topup.status === "rejected" && topup.rejectionReason && (
                    <p className="text-xs text-red-600 max-w-xs text-right">{topup.rejectionReason}</p>
                  )}

                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">{t("wallet.noTopups")}</p>
          )}
        </div>
      </Card>

      {/* Transactions */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">{t("wallet.recentTransactions")}</h2>
        <div className="space-y-2">
          {summary?.recentTransactions && summary.recentTransactions.length > 0 ? (
            summary.recentTransactions.map((tx: any) => (
              <div key={tx.id} className="flex justify-between text-sm py-2 border-b">
                <div>{tx.type === "debit" ? t("wallet.debit") : t("wallet.credit")}</div>
                <div className={tx.type === "debit" ? "text-red-600" : "text-green-600"}>
                  {tx.type === "debit" ? "-" : "+"}฿{tx.amount}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">{t("wallet.noTransactions")}</p>
          )}
        </div>
      </Card>
    </div>
  );
}
