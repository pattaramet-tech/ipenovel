import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { Upload, CheckCircle, AlertCircle } from "lucide-react";

const QR_PAYMENT_IMAGE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_8beb9f9a.jpeg";

export default function WalletPage() {
  const auth = useAuth();
  const { t } = useLanguage();
  const [showTopupForm, setShowTopupForm] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [activeTopupId, setActiveTopupId] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: summary, isLoading, refetch: refetchSummary } = trpc.wallet.getSummary.useQuery();
  const createTopupMutation = trpc.wallet.createTopupRequest.useMutation();
  const uploadSlipMutation = trpc.wallet.uploadTopupSlip.useMutation();

  const handleCreateTopup = async () => {
    if (!topupAmount || parseFloat(topupAmount) <= 0) {
      toast.error(t("wallet.pleaseEnterValidAmount"));
      return;
    }
    try {
      const result = await createTopupMutation.mutateAsync({ requestedAmount: topupAmount });
      setTopupAmount("");
      setShowTopupForm(false);
      // Immediately show payment step for the newly created top-up
      setActiveTopupId(result.id);
      toast.success(t("wallet.topupRequestCreated"));
    } catch (error: any) {
      toast.error(error.message || t("wallet.failedToCreateTopup"));
    }
  };

  const handleUploadSlip = async (topupId: number) => {
    if (!selectedFile) {
      toast.error(t("wallet.pleaseSelectFile"));
      return;
    }
    try {
      setIsUploading(true);
      const url = await uploadFile(selectedFile);
      await uploadSlipMutation.mutateAsync({ topupId, slipImageUrl: url });
      setSelectedFile(null);
      setActiveTopupId(null);
      toast.success(t("wallet.slipUploadedSuccessfully"));
      refetchSummary();
    } catch (error: any) {
      toast.error(error.message || t("wallet.failedToUploadSlip"));
    } finally {
      setIsUploading(false);
    }
  };

  const uploadFile = async (file: File): Promise<string> => {
    // Convert file to base64 and upload via JSON (same as PaymentPage)
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

  if (isLoading) return <div className="p-4 text-center">{t("common.loading")}</div>;

  // Policy message for non-refundable wallet (use translation keys)

  // Find the active top-up for payment step
  const activeTopup = activeTopupId
    ? summary?.recentTopups?.find((t: any) => t.id === activeTopupId)
    : null;

  // Show payment step if user just created a top-up
  if (activeTopup) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">  return (
    <div className="container mx-auto px-4 max-w-2xl py-8">
      {/* Policy Warning Banner */}
      <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
        <p className="text-sm text-amber-900 font-semibold mb-2">{t("wallet.policyWarning")}</p>
        <p className="text-xs text-amber-800 leading-relaxed">{t("wallet.policyMessage")}</p>
      </div>          {/* Top-up Summary */}
          <Card>
            <div className="bg-blue-50 p-6 rounded-t-lg">
              <h1 className="text-2xl font-bold text-blue-900">{t("wallet.completeTopup")}</h1>
              <p className="text-blue-700 mt-2">{t("wallet.pleaseFollowSteps")}</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-slate-600">{t("wallet.topupAmountLabel")}</span>
                <span className="text-2xl font-bold text-blue-600">฿{activeTopup.requestedAmount}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600">{t("wallet.requestIdLabel")}</span>
                <span className="font-mono text-sm">{activeTopup.id}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600">{t("wallet.statusLabel")}</span>
                <Badge variant="outline">{t("wallet.waitingForSlip")}</Badge>
              </div>
            </div>
          </Card>

          {/* Short Warning Banner for Payment Step */}
          <div className="mb-6 p-4 bg-amber-50 border-l-4 border-l-amber-500 rounded">
            <div className="flex gap-2">
              <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <p className="font-semibold mb-1">เติมเงินแล้วไม่สามารถถอนหรือขอคืนได้</p>
                <p>เมื่ออนุมัติแล้วจะไม่สามารถย้อนคืนได้</p>
              </div>
            </div>
          </div>

          {/* QR Code Payment */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">{t("wallet.step1ScanQR")}</h2>
              <div className="space-y-4">
                <img src={QR_PAYMENT_IMAGE} alt="QR Code" className="w-64 h-64 mx-auto border rounded" />
                <p className="text-sm text-slate-600 text-center">
                  {t("wallet.scanQRInstructions")} <strong>฿{activeTopup.requestedAmount}</strong>
                </p>
              </div>
            </div>
          </Card>

          {/* Slip Upload */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">{t("wallet.step2UploadSlip")}</h2>
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  {t("wallet.afterPayingInstructions")}
                </p>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    {t("wallet.selectPaymentSlip")}
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    disabled={isUploading}
                    className="w-full px-3 py-2 border rounded text-sm"
                  />
                  <p className="text-xs text-slate-500">
                    {t("wallet.acceptedFormats")}
                  </p>
                </div>

                {selectedFile && (
                  <div className="bg-green-50 p-3 rounded text-sm text-green-800 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4" />
                    {t("wallet.selected")} {selectedFile.name}
                  </div>
                )}

                <Button
                  onClick={() => handleUploadSlip(activeTopup.id)}
                  disabled={!selectedFile || isUploading}
                  className="w-full"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {isUploading ? t("wallet.uploading") : t("wallet.uploadSlipButton")}
                </Button>
              </div>
            </div>
          </Card>

          {/* Help Section */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">{t("wallet.whatHappensNext")}</h2>
              <div className="space-y-2 text-sm text-slate-600">
                <p>{t("wallet.slipWillBeReviewed")}</p>
                <p>{t("wallet.youWillReceiveNotification")}</p>
                <p>{t("wallet.balanceWillBeUpdated")}</p>
                <p>{t("wallet.ifIssueWeWillContact")}</p>
              </div>
            </div>
          </Card>

          {/* Cancel Button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setActiveTopupId(null)}
          >
            {t("wallet.backToWallet")}
          </Button>
        </div>
      </div>
    );
  }

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
          <div className="space-y-4">
            <input
              type="number"
              placeholder={t("wallet.topupAmount")}
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              className="w-full px-3 py-2 border rounded"
            />
            <div className="flex gap-2">
              <Button onClick={handleCreateTopup} disabled={createTopupMutation.isPending}>
                {createTopupMutation.isPending ? t("common.pleaseWait") : t("wallet.createRequest")}
              </Button>
              <Button variant="outline" onClick={() => setShowTopupForm(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Top-up Requests List */}
        <div className="mt-6 space-y-3">
          {summary?.recentTopups && summary.recentTopups.length > 0 ? (
            summary.recentTopups.map((topup: any) => (
              <div key={topup.id} className="border rounded p-3 flex justify-between items-start">
                <div>
                  <div className="font-semibold">฿{topup.requestedAmount}</div>
                  <div className="text-sm text-gray-600">{new Date(topup.createdAt).toLocaleDateString()}</div>
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
                  {topup.status === "pending" && !topup.slipImageUrl && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setActiveTopupId(topup.id)}
                    >
                      {t("wallet.uploadSlip")}
                    </Button>
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
