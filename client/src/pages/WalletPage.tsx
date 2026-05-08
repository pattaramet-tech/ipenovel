"use client";

import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useLanguage } from "@/contexts/LanguageContext";
import { Upload, CheckCircle, AlertCircle, X, Loader2, FileText } from "lucide-react";

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

  // ─── Handle file selection ─────────────────────────────────────────────────
  const handleFileSelect = (file: File | null) => {
    if (!file) {
      setSelectedFile(null);
      setFilePreview(null);
      return;
    }

    // Validate file
    const validation = validateFile(file);
    if (!validation.valid) {
      toast.error(validation.error || "Invalid file");
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    // Store file
    setSelectedFile(file);

    // Generate preview for images only
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setFilePreview(e.target?.result as string);
      };
      reader.onerror = () => {
        toast.error("Failed to read file");
        setFilePreview(null);
      };
      reader.readAsDataURL(file);
    } else {
      // For PDF, don't show image preview
      setFilePreview(null);
    }
  };

  // ─── Clear form completely ────────────────────────────────────────────────
  const clearForm = () => {
    setTopupAmount("");
    setSelectedFile(null);
    setFilePreview(null);
    setCalculatedBonus("0.00");
    // Reset file input element
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ─── Handle cancel button ─────────────────────────────────────────────────
  const handleCancel = () => {
    clearForm();
    setShowTopupForm(false);
  };

  // ─── Remove selected file ────────────────────────────────────────────────
  const handleRemoveFile = () => {
    setSelectedFile(null);
    setFilePreview(null);
    // Reset file input element
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ─── Upload file to backend ──────────────────────────────────────────────
  const uploadFile = async (file: File): Promise<string> => {
    // Convert file to base64
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
        uploadType: "payment-slip",
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Upload failed");
    }

    const data = await response.json();
    return data.url;
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

  if (isLoading) return <div className="p-4 text-center">{t("common.loading")}</div>;

  // ─── Main wallet page ────────────────────────────────────────────────────
  return (
    <div className="container max-w-2xl py-8">
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
                type="text"
                placeholder="e.g., 250.00"
                value={topupAmount}
                onChange={(e) => setTopupAmount(e.target.value)}
                disabled={isUploading || isCreatingRequest}
                className="w-full px-3 py-2 border rounded"
              />

              {/* Live Bonus Preview */}
              {bonusRulesLoading ? (
                <div className="mt-3 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm text-gray-600">Loading bonus rules...</span>
                </div>
              ) : topupAmount && isValidTopupAmount(topupAmount) ? (
                <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-700">Requested Amount:</span>
                      <span className="font-semibold">฿{parseFloat(topupAmount).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-700">Bonus:</span>
                      <span className="font-semibold text-green-600">
                        {parseFloat(calculatedBonus) > 0 ? `+฿${calculatedBonus}` : "No bonus"}
                      </span>
                    </div>
                    <div className="border-t border-blue-200 pt-2 mt-2 flex justify-between">
                      <span className="font-semibold text-slate-900">Total to be Credited:</span>
                      <span className="font-bold text-lg text-green-700">
                        ฿{(parseFloat(topupAmount) + parseFloat(calculatedBonus)).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : null}
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
            </div>

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
    </div>
  );
}
