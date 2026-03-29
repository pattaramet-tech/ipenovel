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
      toast.error("Please enter a valid amount");
      return;
    }
    try {
      const result = await createTopupMutation.mutateAsync({ requestedAmount: topupAmount });
      setTopupAmount("");
      setShowTopupForm(false);
      // Immediately show payment step for the newly created top-up
      setActiveTopupId(result.id);
      toast.success("Top-up request created. Please proceed with payment.");
    } catch (error: any) {
      toast.error(error.message || "Failed to create top-up");
    }
  };

  const handleUploadSlip = async (topupId: number) => {
    if (!selectedFile) {
      toast.error("Please select a file");
      return;
    }
    try {
      setIsUploading(true);
      const url = await uploadFile(selectedFile);
      await uploadSlipMutation.mutateAsync({ topupId, slipImageUrl: url });
      setSelectedFile(null);
      setActiveTopupId(null);
      toast.success("Slip uploaded successfully. Waiting for admin review.");
      refetchSummary();
    } catch (error: any) {
      toast.error(error.message || "Failed to upload slip");
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

  // Find the active top-up for payment step
  const activeTopup = activeTopupId
    ? summary?.recentTopups?.find((t: any) => t.id === activeTopupId)
    : null;

  // Show payment step if user just created a top-up
  if (activeTopup) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="container mx-auto px-4 max-w-2xl space-y-6">
          {/* Top-up Summary */}
          <Card>
            <div className="bg-blue-50 p-6 rounded-t-lg">
              <h1 className="text-2xl font-bold text-blue-900">Complete Your Top-up</h1>
              <p className="text-blue-700 mt-2">Please follow the steps below to complete your wallet top-up request.</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Top-up Amount:</span>
                <span className="text-2xl font-bold text-blue-600">฿{activeTopup.requestedAmount}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Request ID:</span>
                <span className="font-mono text-sm">{activeTopup.id}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-600">Status:</span>
                <Badge variant="outline">waiting_for_slip</Badge>
              </div>
            </div>
          </Card>

          {/* QR Code Payment */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">Step 1: Scan QR Code to Pay</h2>
              <div className="space-y-4">
                <img src={QR_PAYMENT_IMAGE} alt="QR Code" className="w-64 h-64 mx-auto border rounded" />
                <p className="text-sm text-slate-600 text-center">
                  Scan this QR code with your mobile banking app and pay exactly <strong>฿{activeTopup.requestedAmount}</strong>
                </p>
              </div>
            </div>
          </Card>

          {/* Slip Upload */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">Step 2: Upload Payment Slip</h2>
              <div className="space-y-4">
                <p className="text-sm text-slate-600">
                  After paying, take a screenshot of the payment confirmation and upload it below.
                </p>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    Select Payment Slip Image
                  </label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    disabled={isUploading}
                    className="w-full px-3 py-2 border rounded text-sm"
                  />
                  <p className="text-xs text-slate-500">
                    Accepted formats: JPEG, PNG, PDF. Max size: 5MB
                  </p>
                </div>

                {selectedFile && (
                  <div className="bg-green-50 p-3 rounded text-sm text-green-800 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4" />
                    Selected: {selectedFile.name}
                  </div>
                )}

                <Button
                  onClick={() => handleUploadSlip(activeTopup.id)}
                  disabled={!selectedFile || isUploading}
                  className="w-full"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {isUploading ? "Uploading..." : "Upload Slip"}
                </Button>
              </div>
            </div>
          </Card>

          {/* Help Section */}
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold mb-4">What Happens Next?</h2>
              <div className="space-y-2 text-sm text-slate-600">
                <p>• Your slip will be reviewed by our admin team</p>
                <p>• You'll receive a notification when your top-up is approved</p>
                <p>• Your wallet balance will be updated immediately after approval</p>
                <p>• If there's an issue, we'll contact you with the rejection reason</p>
              </div>
            </div>
          </Card>

          {/* Cancel Button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => setActiveTopupId(null)}
          >
            Back to Wallet
          </Button>
        </div>
      </div>
    );
  }

  // Main wallet page
  return (
    <div className="container max-w-2xl py-8">
      <h1 className="text-3xl font-bold mb-6">My Wallet</h1>

      {/* Balance Card */}
      <Card className="p-6 mb-6">
        <div className="text-sm text-gray-600">Current Balance</div>
        <div className="text-4xl font-bold">฿{summary?.balance || "0.00"}</div>
      </Card>

      {/* Top-up Section */}
      <Card className="p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">My Top-up Requests</h2>
        {!showTopupForm ? (
          <Button onClick={() => setShowTopupForm(true)}>Request Top-up</Button>
        ) : (
          <div className="space-y-4">
            <input
              type="number"
              placeholder="Amount"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              className="w-full px-3 py-2 border rounded"
            />
            <div className="flex gap-2">
              <Button onClick={handleCreateTopup} disabled={createTopupMutation.isPending}>
                {createTopupMutation.isPending ? "Creating..." : "Create Request"}
              </Button>
              <Button variant="outline" onClick={() => setShowTopupForm(false)}>
                Cancel
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
                    {topup.status}
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
                      Upload Slip
                    </Button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">No top-up requests yet</p>
          )}
        </div>
      </Card>

      {/* Transactions */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">Recent Transactions</h2>
        <div className="space-y-2">
          {summary?.recentTransactions && summary.recentTransactions.length > 0 ? (
            summary.recentTransactions.map((tx: any) => (
              <div key={tx.id} className="flex justify-between text-sm py-2 border-b">
                <div>{tx.type}</div>
                <div className={tx.type === "debit" ? "text-red-600" : "text-green-600"}>
                  {tx.type === "debit" ? "-" : "+"}฿{tx.amount}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">No transactions yet</p>
          )}
        </div>
      </Card>
    </div>
  );
}
