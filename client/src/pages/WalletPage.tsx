import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";

export default function WalletPage() {
  const auth = useAuth();
  const { t } = useLanguage();
  const [showTopupForm, setShowTopupForm] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const { data: summary, isLoading } = trpc.wallet.getSummary.useQuery();
  const createTopupMutation = trpc.wallet.createTopupRequest.useMutation();
  const uploadSlipMutation = trpc.wallet.uploadTopupSlip.useMutation();

  const handleCreateTopup = async () => {
    if (!topupAmount || parseFloat(topupAmount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }
    try {
      await createTopupMutation.mutateAsync({ requestedAmount: topupAmount });
      setTopupAmount("");
      setShowTopupForm(false);
      toast.success("Top-up request created");
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
      const url = await uploadFile(selectedFile);
      await uploadSlipMutation.mutateAsync({ topupId, slipImageUrl: url });
      setSelectedFile(null);
      toast.success("Slip uploaded successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to upload slip");
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
              <div className="flex items-center gap-2">
                <Badge variant={topup.status === "pending" ? "outline" : topup.status === "approved" ? "default" : "destructive"}>
                  {topup.status}
                </Badge>
                {topup.status === "pending" && !topup.slipImageUrl && (
                  <div className="flex gap-2">
                    <input
                      type="file"
                      onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                      className="text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={() => handleUploadSlip(topup.id)}
                      disabled={uploadSlipMutation.isPending}
                    >
                      {uploadSlipMutation.isPending ? "Uploading..." : "Upload"}
                    </Button>
                  </div>
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
