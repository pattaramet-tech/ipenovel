"use server";

import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System
 * Handles extraction, normalization, and verification of Thai bank slip data
 * Explicitly tied to order/payment records for safe auto-approval
 */

// Merchant configuration
const MERCHANT_CONFIG = {
  shopNameAliases: ["Ipe Novel", "Ipenovel", "IPE NOVEL", "ipe novel", "ipenovel"],
  merchantCode: "KB000002283068",
  merchantTransactionCode: "KPS004KB000002283068",
};

// Thai month mapping
const THAI_MONTHS: Record<string, number> = {
  "มกราคม": 1,
  "กุมภาพันธ์": 2,
  "มีนาคม": 3,
  "เมษายน": 4,
  "พฤษภาคม": 5,
  "มิถุนายน": 6,
  "กรกฎาคม": 7,
  "สิงหาคม": 8,
  "กันยายน": 9,
  "ตุลาคม": 10,
  "พฤศจิกายน": 11,
  "ธันวาคม": 12,
  // English aliases
  "Jan": 1,
  "Feb": 2,
  "Mar": 3,
  "Apr": 4,
  "May": 5,
  "Jun": 6,
  "Jul": 7,
  "Aug": 8,
  "Sep": 9,
  "Oct": 10,
  "Nov": 11,
  "Dec": 12,
};

export interface ExtractedSlipData {
  shopName?: string;
  merchantCode?: string;
  merchantTransactionCode?: string;
  amount?: number;
  transactionDate?: Date;
  reference?: string;
  rawText?: string;
  confidence?: number; // 0-100
}

export interface OrderPaymentContext {
  orderId: number;
  paymentId: number;
  orderTotal: number;
  orderCreatedAt: Date;
  paymentCreatedAt: Date;
}

export interface VerificationResult {
  isAutoApproved: boolean;
  status: "approved" | "pending_review";
  reviewReason?: string;
  extractedData: ExtractedSlipData;
  fingerprint: string;
  linkedOrderId: number;
  linkedPaymentId: number;
}

/**
 * Normalize Thai text for matching
 * Removes extra spaces, converts to lowercase, removes special characters
 */
function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\u0E00-\u0E7Fa-z0-9\s]/g, ""); // Keep Thai chars, alphanumeric, spaces
}

/**
 * Extract shop name from OCR text
 * Looks for common Thai bank slip labels and extracts following text
 */
function extractShopName(text: string): string | undefined {
  const patterns = [
    /ชื่อร้านค้า\s*[:：]\s*([^\n]+)/i,
    /ชื่อ\s*[:：]\s*([^\n]+)/i,
    /shop\s*name\s*[:：]\s*([^\n]+)/i,
    /merchant\s*name\s*[:：]\s*([^\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Extract merchant code from OCR text
 */
function extractMerchantCode(text: string): string | undefined {
  const patterns = [
    /รหัสร้านค้า\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*id\s*[:：]\s*([A-Z0-9]+)/i,
    /([A-Z]{2}\d{12})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Extract merchant transaction code from OCR text
 * Looks for patterns like KPS004KB000002283068
 */
function extractMerchantTransactionCode(text: string): string | undefined {
  const patterns = [
    /รหัสธุรกรรม\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /([A-Z]{3}\d{3}[A-Z]{2}\d{12})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Extract payment amount from OCR text
 */
function extractAmount(text: string): number | undefined {
  const patterns = [
    /จำนวนเงิน\s*[:：]\s*([\d,]+\.?\d*)/i,
    /amount\s*[:：]\s*([\d,]+\.?\d*)/i,
    /total\s*[:：]\s*([\d,]+\.?\d*)/i,
    /ยอดเงิน\s*[:：]\s*([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const amountStr = match[1].replace(/,/g, "");
      const amount = parseFloat(amountStr);
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }

  return undefined;
}

/**
 * Extract transaction reference from OCR text
 */
function extractReference(text: string): string | undefined {
  const patterns = [
    /เลขที่อ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /หมายเลขอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /เลขที่รายการ\s*[:：]\s*([A-Z0-9]+)/i,
    /รหัสอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /reference\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*ref\s*[:：]\s*([A-Z0-9]+)/i,
    /([A-Z0-9]{10,20})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Extract transaction date from OCR text
 * Supports Thai date format with Buddhist year
 */
function extractTransactionDate(text: string): Date | undefined {
  const patterns = [
    /วันที่\s*[:：]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/i,
    /date\s*[:：]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/i,
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/,  // Prioritize 4-digit year
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2})/,   // Then 2-digit year
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let day = parseInt(match[1]);
      let month = parseInt(match[2]);
      let year = parseInt(match[3]);

      // Convert Buddhist year to Gregorian if needed (Thai year is 543 years ahead)
      if (year > 2500) {
        year -= 543;
      } else if (year < 100) {
        // Handle 2-digit years
        year += year < 50 ? 2000 : 1900;
      }

      // Validate date
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        try {
          const date = new Date(year, month - 1, day);
          // Check if date is valid and reasonable (within last 90 days for flexibility)
          const now = new Date();
          const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          if (date <= now && date >= ninetyDaysAgo) {
            return date;
          }
        } catch {
          // Invalid date
        }
      }
    }
  }

  return undefined;
}

/**
 * Extract all data from OCR text
 */
export function extractSlipData(ocrText: string): ExtractedSlipData {
  if (!ocrText || ocrText.trim().length === 0) {
    return { confidence: 0 };
  }

  const shopName = extractShopName(ocrText);
  const merchantCode = extractMerchantCode(ocrText);
  const merchantTransactionCode = extractMerchantTransactionCode(ocrText);
  const amount = extractAmount(ocrText);
  const transactionDate = extractTransactionDate(ocrText);
  const reference = extractReference(ocrText);

  // Calculate confidence based on extracted fields
  let confidence = 0;
  if (shopName) confidence += 15;
  if (merchantCode) confidence += 20;
  if (merchantTransactionCode) confidence += 15;
  if (amount) confidence += 20;
  if (transactionDate) confidence += 15;
  if (reference) confidence += 15;

  return {
    shopName,
    merchantCode,
    merchantTransactionCode,
    amount,
    transactionDate,
    reference,
    rawText: ocrText,
    confidence: Math.min(confidence, 100),
  };
}

/**
 * Verify extracted slip data against specific order/payment record
 * Ensures slip is correctly linked to the exact pending order/payment
 */
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>
): VerificationResult {
  const result: VerificationResult = {
    isAutoApproved: false,
    status: "pending_review",
    extractedData: extracted,
    fingerprint: generateFingerprint(extracted),
    linkedOrderId: context.orderId,
    linkedPaymentId: context.paymentId,
  };

  // Check 1: Shop name verification
  if (!extracted.shopName) {
    result.reviewReason = "MISSING_SHOP_NAME";
    return result;
  }

  const normalizedShopName = normalizeText(extracted.shopName);
  const shopNameMatches = MERCHANT_CONFIG.shopNameAliases.some(
    (alias) => normalizeText(alias) === normalizedShopName
  );

  if (!shopNameMatches) {
    result.reviewReason = "SHOP_NAME_MISMATCH";
    return result;
  }

  // Check 2: Merchant code verification
  if (!extracted.merchantCode) {
    result.reviewReason = "MISSING_MERCHANT_CODE";
    return result;
  }

  if (extracted.merchantCode !== MERCHANT_CONFIG.merchantCode) {
    result.reviewReason = "MERCHANT_CODE_MISMATCH";
    return result;
  }

  // Check 3: Merchant transaction code (if present, must match)
  if (
    extracted.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    result.reviewReason = "MERCHANT_TRANSACTION_CODE_MISMATCH";
    return result;
  }

  // Check 4: Amount verification (must match exactly)
  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    return result;
  }

  if (Math.abs(extracted.amount - context.orderTotal) > 0.001) {
    result.reviewReason = "AMOUNT_MISMATCH";
    return result;
  }

  // Check 5: Transaction date verification and time window validation
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    return result;
  }

  // Verify transaction is within acceptable time window relative to payment submission
  // Transaction should be before or shortly after payment submission (allow 5 min clock skew)
  const paymentTime = context.paymentCreatedAt.getTime();
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = paymentTime - transactionTime;
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours before payment
  const minAgeMs = -5 * 60 * 1000; // 5 minutes after payment (clock skew tolerance)

  if (timeDiffMs > maxAgeMs || timeDiffMs < minAgeMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    return result;
  }

  // Check 6: Reference verification (duplicate detection)
  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    return result;
  }

  if (existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    return result;
  }

  // Check 7: Confidence level - must be >= 85 for auto-approval
  if ((extracted.confidence || 0) < 85) {
    result.reviewReason = "LOW_CONFIDENCE";
    result.status = "pending_review";
    return result;
  }

  // All checks passed - auto-approve
  result.isAutoApproved = true;
  result.status = "approved";
  return result;
}

/**
 * Generate fingerprint for duplicate detection
 * Uses reference + amount + merchant code + date
 */
export function generateFingerprint(extracted: ExtractedSlipData): string {
  const fingerprintData = [
    extracted.reference || "",
    extracted.amount?.toString() || "",
    extracted.merchantCode || "",
    extracted.transactionDate?.toISOString().split("T")[0] || "",
  ].join("|");

  return crypto.createHash("sha256").update(fingerprintData).digest("hex");
}

/**
 * Parse OCR text from image URL using Manus LLM
 * This would be called from the backend when slip is uploaded
 */
export async function parseSlipImage(imageUrl: string): Promise<string> {
  try {
    // invokeLLM is already imported at the top of the file
    
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are an expert at extracting text from Thai bank slip images. Extract ALL visible text from the slip image, preserving the structure and labels. Focus on extracting: shop name (ชื่อร้านค้า), merchant code (รหัสร้านค้า), merchant transaction code (รหัสธุรกรรม), amount (จำนวนเงิน), transaction date (วันที่), and bank reference number (เลขที่อ้างอิง). Return the extracted text exactly as it appears on the slip.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please extract all text from this bank slip image:",
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    return "";
  } catch (error) {
    console.error("Error parsing slip image:", error);
    return "";
  }
}
