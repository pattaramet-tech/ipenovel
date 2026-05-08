import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { Upload, CheckCircle, AlertCircle, X, Loader2, FileText, Clock, CheckCheck, XCircle } from "lucide-react";

const QR_PAYMENT_IMAGE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663334918622/HEFiacXNVZGj8v7VkecB9b/IMG_8158_19d96370.JPG";

// File validation constants
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "application/pdf"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TOPUP_AMOUNT = 100000;

export default function WalletPage() {
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Form state ────────────────────────────────────────────────────────────
  const [showTopupForm, setShowTopupForm] = useState(false);
  const [topupAmount, setTopupAmount] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isCreatingRequest, setIsCreatingRequest] = useState(false);
  const [calculatedBonus, setCalculatedBonus] = useState("0.00");
  const [activeHistoryTab, setActiveHistoryTab] = useState<"topups" | "purchases" | "transactions">("topups");

  // ─── tRPC queries ──────────────────────────────────────────────────────────
  const { data: summary, isLoading, refetch: refetchSummary } = trpc.wallet.getSummary.useQuery();
  const { data: bonusRulesData, isLoading: bonusRulesLoading } = trpc.wallet.getBonusRules.useQuery();
  const createTopupMutation = trpc.wallet.createTopupRequest.useMutation();

  // ─── Calculate bonus based on rules when amount changes ────────────────────
  useEffect(() => {
    if (!topupAmount || parseFloat(topupAmount) <= 0) {
      setCalculatedBonus("0.00");
      return;
    }

    const amount = parseFloat(topupAmount);
    const rules = bonusRulesData?.rules || [];
    const enabledRules = rules.filter((r: any) => r.enabled).sort((a: any, b: any) => a.threshold - b.threshold);

    let bonus = 0;
    for (const rule of enabledRules) {
      if (amount >= rule.threshold) {
        bonus = rule.bonus;
      } else {
        break;
      }
    }

    setCalculatedBonus(bonus.toFixed(2));
  }, [topupAmount, bonusRulesData]);

  // ─── Validate top-up amount format ─────────────────────────────────────────
  const isValidTopupAmount = (amount: string): boolean => {
    if (!amount || amount.trim() === "") return false;
    
    // Reject exponential notation
    if (amount.includes("e") || amount.includes("E")) return false;
    
    const num = parseFloat(amount);
    
    // Check if valid number
    if (isNaN(num)) return false;
    
    // Check if positive
    if (num <= 0) return false;
    
    // Check if exceeds max
    if (num > MAX_TOPUP_AMOUNT) return false;
    
    // Check decimal places (max 2)
    const decimalPart = amount.split(".")[1];
    if (decimalPart && decimalPart.length > 2) return false;
    
    return true;
  };

  // ─── Validate file ────────────────────────────────────────────────────────
  const validateFile = (file: File): { valid: boolean; error?: string } => {
    // Check file type
    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      return {
        valid: false,
        error: `Invalid file type. Allowed: JPEG, PNG, PDF. Got: ${file.type}`,
      };
    }

    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return {
        valid: false,
        error: `File too large. Max size: 5MB. Got: ${(file.size / 1024 / 1024).toFixed(1)}MB`,
      };
    }

    return { valid: true };
  };

  // ─── File selection handler ────────────────────────────────────────────────
  const handleFileSelect = (file: File | null) => {
    if (!file) {
      setSelectedFile(null);
      setFilePreview(null);
      return;
    }

    const validation = validateFile(file);
    if (!validation.valid) {
      toast.error(validation.error || "Invalid file");
      return;
    }

    setSelectedFile(file);

    // Generate preview for images
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  // ─── Remove selected file ──────────────────────────────────────────────────
  const handleRemoveFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ─── Clear form ────────────────────────────────────────────────────────────
  const clearForm = () => {
    setTopupAmount("");
    setSelectedFile(null);
    setFilePreview(null);
    setCalculatedBonus("0.00");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ─── Cancel form ───────────────────────────────────────────────────────────
  const handleCancel = () => {
    clearForm();
    setShowTopupForm(false);
  };

  // ─── Upload file to server ─────────────────────────────────────────────────
  const uploadFile = async (file: File): Promise<string> => {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = async (e) => {
        try {
          const base64 = e.target?.result as string;
          const response = await fetch("/api/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file: base64,
              filename: file.name,
              type: file.type,
              uploadType: "payment-slip",
            }),
          });

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || "Upload failed");
          }

          const data = await response.json();
          return resolve(data.url);
        } catch (error: any) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error("File read failed"));
      reader.readAsDataURL(file);
    });
  };

  // ─── Create top-up request ───────────────────────────────────────────────
  const handleCreateTopupWithSlip = async () => {
    // Validate amount
    if (!isValidTopupAmount(topupAmount)) {
      toast.error("Please enter a valid amount (0 - 100000, max 2 decimals)");
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
      await createTopupMutation.mutateAsync({
        requestedAmount: topupAmount,
        slipImageUrl,
      });

      // Success: Clear form and show confirmation
      clearForm();
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

  // ─── Format date helper ────────────────────────────────────────────────────
  const formatDate = (date: string | Date): string => {
    const d = new Date(date);
    return d.toLocaleDateString("th-TH", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // ─── Get status badge ──────────────────────────────────────────────────────
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge className="bg-yellow-100 text-yellow-800"><Clock className="w-3 h-3 mr-1" /> Pending</Badge>;
      case "approved":
        return <Badge className="bg-green-100 text-green-800"><CheckCheck className="w-3 h-3 mr-1" /> Approved</Badge>;
      case "rejected":
        return <Badge className="bg-red-100 text-red-800"><XCircle className="w-3 h-3 mr-1" /> Rejected</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  if (isLoading) return <div className="p-4 text-center">{t("common.loading")}</div>;

  // ─── Main wallet page ────────────────────────────────────────────────────
  return (
    <div className="container max-w-4xl py-8">
      <h1 className="text-3xl font-bold mb-6">{t("wallet.title")}</h1>

      {/* Policy Notice Card */}
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
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-600">Total Approved Top-ups</div>
            <div className="text-lg font-semibold">฿{summary?.totalTopupApproved || "0.00"}</div>
          </div>
          <div>
            <div className="text-gray-600">Total Spent</div>
            <div className="text-lg font-semibold">฿{summary?.totalSpent || "0.00"}</div>
          </div>
        </div>
      </Card>

      {/* Top-up Section */}
      <Card className="p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">{t("wallet.topupTitle")}</h2>
          {!showTopupForm && (
            <Button onClick={() => setShowTopupForm(true)}>{t("wallet.createTopup")}</Button>
          )}
        </div>

        {showTopupForm && (
          <div className="space-y-4 border-t pt-4">
            {/* 1. Amount Input */}
            <div>
              <label className="block text-sm font-medium mb-2">{t("wallet.amount")}</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="0.00"
                  value={topupAmount}
                  onChange={(e) => setTopupAmount(e.target.value)}
                  disabled={isUploading || isCreatingRequest}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  step="0.01"
                  min="0"
                />
                <span className="flex items-center text-lg font-semibold">฿</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Max: ฿{MAX_TOPUP_AMOUNT}</p>
            </div>

            {/* 2. Bonus Preview */}
            {isValidTopupAmount(topupAmount) && (
              <div className="bg-blue-50 border border-blue-200 rounded p-3">
                <p className="text-sm text-blue-900">
                  <span className="font-semibold">Bonus:</span> ฿{calculatedBonus}
                </p>
                <p className="text-xs text-blue-700 mt-1">
                  Total to receive: ฿{(parseFloat(topupAmount) + parseFloat(calculatedBonus)).toFixed(2)}
                </p>
              </div>
            )}

            {/* 3. File Upload */}
            <div>
              <label className="block text-sm font-medium mb-2">{t("wallet.paymentSlip")}</label>
              <input
                ref={fileInputRef}
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
                  {selectedFile ? t("wallet.selected") : "Select payment slip"}
                </span>
              </label>
            </div>
            {/* Selected File Info */}
            {selectedFile && (
              <div className="bg-green-50 p-3 rounded-lg border border-green-200 flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {selectedFile.type.startsWith("image/") ? (
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <FileText className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-green-900 truncate">{selectedFile.name}</p>
                    <p className="text-xs text-green-700">{(selectedFile.size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>
                <button
                  onClick={handleRemoveFile}
                  className="text-green-600 hover:text-green-700 flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            {/* Image Preview (only for images) */}
            {filePreview && selectedFile?.type.startsWith("image/") && (
              <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-50 p-2">
                <img
                  src={filePreview}
                  alt="Slip preview"
                  className="w-full max-h-48 object-contain rounded"
                />
              </div>
            )}
            <p className="text-xs text-slate-500">
              {t("wallet.acceptedFormats")} (Max 5MB)
            </p>
            {/* 4. Submit Button */}
            <div className="flex gap-2">
              <Button
                onClick={handleCreateTopupWithSlip}
                disabled={!isValidTopupAmount(topupAmount) || !selectedFile || isUploading || isCreatingRequest}
                className="flex-1"
              >
                {isUploading || isCreatingRequest ? t("common.pleaseWait") : t("wallet.createRequest")}
              </Button>
              <Button
                variant="outline"
                onClick={handleCancel}
                disabled={isUploading || isCreatingRequest}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
        {/* Bonus Rule Hint */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm mt-4">
          <p className="font-semibold text-blue-900 mb-1">กติกาโบนัส:</p>
          {bonusRulesData?.rules && bonusRulesData.rules.filter((r: any) => r.enabled).length > 0 ? (
            <ul className="space-y-1 text-blue-800">
              {bonusRulesData.rules
                .filter((r: any) => r.enabled)
                .sort((a: any, b: any) => a.threshold - b.threshold)
                .map((rule: any) => (
                  <li key={rule.id}>
                    ฿{rule.threshold} ขึ้นไป → +฿{rule.bonus}
                    {rule.label && <span className="text-xs text-blue-700 ml-2">({rule.label})</span>}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-blue-700">ไม่มีโบนัส</p>
          )}
        </div>
      </Card>

      {/* History Tabs */}
      <Card className="p-6">
        <h2 className="text-xl font-bold mb-4">History</h2>
        
        {/* Tab Navigation */}
        <div className="flex gap-2 mb-6 border-b">
          <button
            onClick={() => setActiveHistoryTab("topups")}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeHistoryTab === "topups"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Top-up History
          </button>
          <button
            onClick={() => setActiveHistoryTab("purchases")}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeHistoryTab === "purchases"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Purchase History
          </button>
          <button
            onClick={() => setActiveHistoryTab("transactions")}
            className={`px-4 py-2 font-medium border-b-2 transition ${
              activeHistoryTab === "transactions"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-600 hover:text-gray-900"
            }`}
          >
            Transactions
          </button>
        </div>

        {/* Top-up History Tab */}
        {activeHistoryTab === "topups" && (
          <div className="space-y-3">
            {summary?.recentTopups && summary.recentTopups.length > 0 ? (
              summary.recentTopups.map((topup: any) => (
                <div key={topup.id} className="border rounded-lg p-4 hover:bg-gray-50 transition">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="font-semibold">฿{topup.requestedAmount}</p>
                      <p className="text-xs text-gray-500">{formatDate(topup.createdAt)}</p>
                    </div>
                    {getStatusBadge(topup.status)}
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-sm mt-3 pt-3 border-t">
                    <div>
                      <p className="text-gray-600">Bonus</p>
                      <p className="font-semibold">฿{topup.bonus || "0.00"}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Credited</p>
                      <p className="font-semibold">฿{topup.creditedAmount || "0.00"}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Reference</p>
                      <p className="font-mono text-xs">{topup.reference || "-"}</p>
                    </div>
                  </div>
                  {topup.rejectionReason && (
                    <div className="mt-3 pt-3 border-t bg-red-50 p-2 rounded text-sm text-red-700">
                      <p className="font-semibold">Rejection Reason:</p>
                      <p>{topup.rejectionReason}</p>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="text-center text-gray-500 py-8">No top-up history yet.</p>
            )}
          </div>
        )}

        {/* Purchase History Tab */}
        {activeHistoryTab === "purchases" && (
          <div className="space-y-3">
            {summary?.recentTransactions && summary.recentTransactions.filter((t: any) => t.type === "purchase").length > 0 ? (
              summary.recentTransactions
                .filter((t: any) => t.type === "purchase")
                .map((transaction: any) => (
                  <div key={transaction.id} className="border rounded-lg p-4 hover:bg-gray-50 transition">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <p className="font-semibold">฿{transaction.amount}</p>
                        <p className="text-xs text-gray-500">{formatDate(transaction.createdAt)}</p>
                      </div>
                      <Badge className="bg-blue-100 text-blue-800">Purchase</Badge>
                    </div>
                    <div className="mt-3 text-sm">
                      <p className="text-gray-600">
                        <span className="font-semibold">Reference:</span> {transaction.reference || "-"}
                      </p>
                      {transaction.note && (
                        <p className="text-gray-600 mt-1">
                          <span className="font-semibold">Note:</span> {transaction.note}
                        </p>
                      )}
                    </div>
                  </div>
                ))
            ) : (
              <p className="text-center text-gray-500 py-8">No purchase history yet.</p>
            )}
          </div>
        )}

        {/* Transactions Tab */}
        {activeHistoryTab === "transactions" && (
          <div className="space-y-3">
            {summary?.recentTransactions && summary.recentTransactions.length > 0 ? (
              summary.recentTransactions.map((transaction: any) => (
                <div key={transaction.id} className="border rounded-lg p-4 hover:bg-gray-50 transition">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="font-semibold">฿{transaction.amount}</p>
                      <p className="text-xs text-gray-500">{formatDate(transaction.createdAt)}</p>
                    </div>
                    <Badge className={
                      transaction.type === "topup" ? "bg-green-100 text-green-800" :
                      transaction.type === "purchase" ? "bg-blue-100 text-blue-800" :
                      "bg-gray-100 text-gray-800"
                    }>
                      {transaction.type}
                    </Badge>
                  </div>
                  <div className="mt-3 text-sm">
                    <p className="text-gray-600">
                      <span className="font-semibold">Reference:</span> {transaction.reference || "-"}
                    </p>
                    {transaction.note && (
                      <p className="text-gray-600 mt-1">
                        <span className="font-semibold">Note:</span> {transaction.note}
                      </p>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-center text-gray-500 py-8">No transactions yet.</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
