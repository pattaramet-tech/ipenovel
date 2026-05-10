import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface ExtractedData {
  shopName?: string;
  merchantCode?: string;
  amount?: number;
  reference?: string;
  transactionDate?: string;
  transactionTime?: string;
  bankName?: string;
  recipientName?: string;
  visionConfidence?: number;
  structuredConfidence?: number;
  finalConfidence?: number;
  [key: string]: any;
}

interface OCRResultPanelProps {
  payment: {
    id: number;
    extractedData?: string | ExtractedData | null;
    ocrDecision?: string | null;
    ocrConfidence?: number | null;
    fingerprint?: string | null;
    reviewReason?: string | null;
    approvalSource?: string | null;
    order?: { totalAmount: number | string };
  };
}

export function OCRResultPanel({ payment }: OCRResultPanelProps) {
  const [showRawJson, setShowRawJson] = useState(false);

  // Parse extracted data safely
  let extractedData: ExtractedData | null = null;
  if (payment.extractedData) {
    if (typeof payment.extractedData === "string") {
      try {
        extractedData = JSON.parse(payment.extractedData);
      } catch (e) {
        console.error("Failed to parse extractedData:", e);
      }
    } else {
      extractedData = payment.extractedData;
    }
  }

  // If no OCR data, don't show panel
  if (!extractedData && !payment.ocrDecision && !payment.ocrConfidence) {
    return null;
  }

  // Helper to get OCR decision badge
  const getOCRDecisionBadge = (decision?: string | null) => {
    if (!decision) return null;

    const badges: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
      auto_approved: {
        color: "bg-green-100 text-green-800",
        icon: <CheckCircle2 className="w-4 h-4" />,
        label: "Auto-Approved",
      },
      needs_review: {
        color: "bg-yellow-100 text-yellow-800",
        icon: <AlertTriangle className="w-4 h-4" />,
        label: "Needs Review",
      },
      rejected: {
        color: "bg-red-100 text-red-800",
        icon: <AlertCircle className="w-4 h-4" />,
        label: "Rejected",
      },
      ocr_disabled: {
        color: "bg-gray-100 text-gray-800",
        icon: <EyeOff className="w-4 h-4" />,
        label: "OCR Disabled",
      },
      shadow_auto_approved: {
        color: "bg-blue-100 text-blue-800",
        icon: <CheckCircle2 className="w-4 h-4" />,
        label: "Shadow Auto-Approved",
      },
    };

    const badge = badges[decision];
    if (!badge) return null;

    return (
      <Badge className={`${badge.color} flex items-center gap-1 w-fit`}>
        {badge.icon}
        {badge.label}
      </Badge>
    );
  };

  // Expected amount from order
  const expectedAmount = payment.order?.totalAmount
    ? parseFloat(payment.order.totalAmount.toString())
    : null;
  const extractedAmount = extractedData?.amount;
  const amountMatch =
    expectedAmount && extractedAmount ? Math.abs(expectedAmount - extractedAmount) < 0.01 : null;

  return (
    <Card className="border-blue-200 bg-blue-50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-blue-600" />
            OCR Verification Result
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRawJson(!showRawJson)}
            className="text-xs"
          >
            {showRawJson ? (
              <>
                <EyeOff className="w-3 h-3 mr-1" />
                Hide JSON
              </>
            ) : (
              <>
                <Eye className="w-3 h-3 mr-1" />
                Show JSON
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* OCR Decision */}
        {payment.ocrDecision && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">OCR Decision</p>
            {getOCRDecisionBadge(payment.ocrDecision)}
          </div>
        )}

        {/* OCR Confidence Scores */}
        {(payment.ocrConfidence !== null ||
          extractedData?.visionConfidence !== undefined ||
          extractedData?.structuredConfidence !== undefined ||
          extractedData?.finalConfidence !== undefined) && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">Confidence Scores</p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {extractedData?.visionConfidence !== undefined && (
                <div className="bg-white p-2 rounded border border-blue-200">
                  <p className="text-slate-600">Vision</p>
                  <p className="font-semibold text-blue-700">{extractedData.visionConfidence}%</p>
                </div>
              )}
              {extractedData?.structuredConfidence !== undefined && (
                <div className="bg-white p-2 rounded border border-blue-200">
                  <p className="text-slate-600">Structured</p>
                  <p className="font-semibold text-blue-700">{extractedData.structuredConfidence}%</p>
                </div>
              )}
              {extractedData?.finalConfidence !== undefined && (
                <div className="bg-white p-2 rounded border border-blue-200">
                  <p className="text-slate-600">Final</p>
                  <p className="font-semibold text-blue-700">{extractedData.finalConfidence}%</p>
                </div>
              )}
              {payment.ocrConfidence !== null && (
                <div className="bg-white p-2 rounded border border-blue-200">
                  <p className="text-slate-600">Overall</p>
                  <p className="font-semibold text-blue-700">{payment.ocrConfidence}%</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Payment Matching Details */}
        {extractedData && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">Payment Details</p>
            <div className="space-y-2 text-sm bg-white p-3 rounded border border-blue-200">
              {/* Amount */}
              {expectedAmount !== null && (
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Expected Amount:</span>
                  <span className="font-semibold">฿{expectedAmount.toFixed(2)}</span>
                </div>
              )}
              {extractedAmount !== undefined && (
                <div className="flex justify-between items-center">
                  <span className="text-slate-600">Extracted Amount:</span>
                  <span className={`font-semibold ${amountMatch ? "text-green-700" : "text-red-700"}`}>
                    ฿{extractedAmount.toFixed(2)}
                  </span>
                </div>
              )}
              {amountMatch !== null && (
                <div className="flex justify-between items-center pt-1 border-t border-slate-200">
                  <span className="text-slate-600">Amount Match:</span>
                  <Badge className={amountMatch ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}>
                    {amountMatch ? "✓ Match" : "✗ Mismatch"}
                  </Badge>
                </div>
              )}

              {/* Transaction Date/Time */}
              {(extractedData.transactionDate || extractedData.transactionTime) && (
                <div className="pt-2 border-t border-slate-200">
                  {extractedData.transactionDate && (
                    <p className="text-slate-600">
                      <span className="font-semibold">Date:</span> {extractedData.transactionDate}
                    </p>
                  )}
                  {extractedData.transactionTime && (
                    <p className="text-slate-600">
                      <span className="font-semibold">Time:</span> {extractedData.transactionTime}
                    </p>
                  )}
                </div>
              )}

              {/* Reference */}
              {extractedData.reference && (
                <div className="pt-2 border-t border-slate-200">
                  <p className="text-slate-600">
                    <span className="font-semibold">Reference:</span> {extractedData.reference}
                  </p>
                </div>
              )}

              {/* Bank/Source */}
              {extractedData.bankName && (
                <div className="text-slate-600">
                  <span className="font-semibold">Bank:</span> {extractedData.bankName}
                </div>
              )}

              {/* Recipient/Merchant */}
              {(extractedData.recipientName || extractedData.shopName || extractedData.merchantCode) && (
                <div className="pt-2 border-t border-slate-200">
                  {extractedData.shopName && (
                    <p className="text-slate-600">
                      <span className="font-semibold">Shop:</span> {extractedData.shopName}
                    </p>
                  )}
                  {extractedData.recipientName && (
                    <p className="text-slate-600">
                      <span className="font-semibold">Recipient:</span> {extractedData.recipientName}
                    </p>
                  )}
                  {extractedData.merchantCode && (
                    <p className="text-slate-600">
                      <span className="font-semibold">Merchant Code:</span> {extractedData.merchantCode}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Duplicate Detection */}
        {payment.fingerprint && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">Duplicate Detection</p>
            <div className="space-y-2 text-sm bg-white p-3 rounded border border-blue-200">
              <div>
                <p className="text-slate-600 break-all">
                  <span className="font-semibold">Fingerprint:</span> {payment.fingerprint.substring(0, 32)}...
                </p>
              </div>
              <div className="pt-2 border-t border-slate-200">
                <Badge className="bg-blue-100 text-blue-800">Fingerprint Stored</Badge>
              </div>
            </div>
          </div>
        )}

        {/* Review/Admin Details */}
        {(payment.reviewReason || payment.approvalSource) && (
          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">Review Details</p>
            <div className="space-y-2 text-sm bg-white p-3 rounded border border-blue-200">
              {payment.reviewReason && (
                <div>
                  <p className="text-slate-600">
                    <span className="font-semibold">Review Reason:</span> {payment.reviewReason}
                  </p>
                </div>
              )}
              {payment.approvalSource && (
                <div className="pt-2 border-t border-slate-200">
                  <p className="text-slate-600">
                    <span className="font-semibold">Approval Source:</span> {payment.approvalSource}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Raw JSON (Collapsed by default) */}
        {showRawJson && extractedData && (
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Raw OCR Data (Debug)</p>
            <pre className="bg-white p-2 rounded border border-slate-200 text-xs overflow-auto max-h-40 text-slate-700">
              {JSON.stringify(extractedData, null, 2)}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
