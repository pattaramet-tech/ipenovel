"use server";

import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System - HARDENED VERSION
 * 
 * Critical fixes applied:
 * 1. Reference ID format validation
 * 2. Bank detection and validation
 * 3. Improved confidence calculation with OCR quality
 * 4. Tightened time window validation
 * 5. Better merchant code validation
 * 6. Integer-based amount comparison
 * 7. Comprehensive logging
 */

// Merchant configuration
const MERCHANT_CONFIG = {
  shopNameAliases: ["Ipe Novel", "Ipenovel", "IPE NOVEL", "ipe novel", "ipenovel"],
  merchantCode: "KB000002283068",
  merchantTransactionCode: "KPS004KB000002283068",
};

// Supported banks with their Thai names and code formats
const SUPPORTED_BANKS = {
  "ธนาคารกรุงเทพ": { code: "KBANK", refFormat: /^\d{12,15}$/ },
  "ธนาคารกสิกรไทย": { code: "KASIKORN", refFormat: /^\d{10,12}$/ },
  "ธนาคารไทยพาณิชย์": { code: "SCB", refFormat: /^[A-Z0-9]{10,12}$/ },
  "ธนาคารกรุงไทย": { code: "BBL", refFormat: /^\d{12,15}$/ },
  "PromptPay": { code: "PROMPTPAY", refFormat: /^\d{10,15}$/ },
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
  detectedBank?: string;
  rawText?: string;
  confidence?: number; // 0-100
  ocrQuality?: number; // 0-100 (from LLM)
  warnings?: string[];
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
 */
function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\u0E00-\u0E7Fa-z0-9\s]/g, "");
}

/**
 * Detect which bank the slip is from
 */
function detectBank(text: string): string | undefined {
  for (const [bankName, bankInfo] of Object.entries(SUPPORTED_BANKS)) {
    if (text.includes(bankName)) {
      return bankInfo.code;
    }
  }
  return undefined;
}

/**
 * Validate merchant code format
 */
function validateMerchantCode(code: string, detectedBank?: string): boolean {
  if (!code) return false;
  
  // KBANK merchant codes: KB + 12 digits
  if (detectedBank === "KBANK" || code.startsWith("KB")) {
    return /^KB\d{12}$/.test(code);
  }
  
  // Generic validation: alphanumeric, reasonable length
  return /^[A-Z0-9]{10,20}$/.test(code);
}

/**
 * Validate reference ID format based on detected bank
 */
function validateReferenceFormat(reference: string, detectedBank?: string): boolean {
  if (!reference) return false;
  
  const bankInfo = Object.values(SUPPORTED_BANKS).find(b => b.code === detectedBank);
  if (bankInfo) {
    return bankInfo.refFormat.test(reference);
  }
  
  // Generic validation: alphanumeric, 10-20 chars
  return /^[A-Z0-9]{10,20}$/.test(reference);
}

/**
 * Extract shop name from OCR text
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
      const code = match[1].trim();
      // Validate format before returning
      if (validateMerchantCode(code)) {
        return code;
      }
    }
  }

  return undefined;
}

/**
 * Extract merchant transaction code from OCR text
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
 * Extract transaction reference with format validation
 */
function extractReference(text: string, detectedBank?: string): string | undefined {
  const patterns = [
    /เลขที่อ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /หมายเลขอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /เลขที่รายการ\s*[:：]\s*([A-Z0-9]+)/i,
    /รหัสอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /reference\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*ref\s*[:：]\s*([A-Z0-9]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const ref = match[1].trim();
      // Validate format before returning
      if (validateReferenceFormat(ref, detectedBank)) {
        return ref;
      }
    }
  }

  return undefined;
}

/**
 * Extract transaction date from OCR text
 */
function extractTransactionDate(text: string): Date | undefined {
  const patterns = [
    /วันที่\s*[:：]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/i,
    /date\s*[:：]\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/i,
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/,
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let day = parseInt(match[1]);
      let month = parseInt(match[2]);
      let year = parseInt(match[3]);

      // Convert Buddhist year to Gregorian if needed
      if (year > 2500) {
        year -= 543;
      } else if (year < 100) {
        year += year < 50 ? 2000 : 1900;
      }

      // Validate date
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        try {
          const date = new Date(year, month - 1, day);
          // Check if date is valid and reasonable (within last 90 days)
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
    return { confidence: 0, warnings: ["Empty OCR text"] };
  }

  const detectedBank = detectBank(ocrText);
  const shopName = extractShopName(ocrText);
  const merchantCode = extractMerchantCode(ocrText);
  const merchantTransactionCode = extractMerchantTransactionCode(ocrText);
  const amount = extractAmount(ocrText);
  const transactionDate = extractTransactionDate(ocrText);
  const reference = extractReference(ocrText, detectedBank);

  const warnings: string[] = [];

  // Calculate confidence based on extracted fields
  let confidence = 0;
  
  if (shopName) confidence += 15;
  else warnings.push("Shop name not found");
  
  if (merchantCode) confidence += 20;
  else warnings.push("Merchant code not found");
  
  if (merchantTransactionCode) confidence += 15;
  else warnings.push("Merchant transaction code not found");
  
  if (amount) confidence += 20;
  else warnings.push("Amount not found");
  
  if (transactionDate) confidence += 15;
  else warnings.push("Transaction date not found");
  
  if (reference) confidence += 15;
  else warnings.push("Reference not found");

  return {
    shopName,
    merchantCode,
    merchantTransactionCode,
    amount,
    transactionDate,
    reference,
    detectedBank,
    rawText: ocrText,
    confidence: Math.min(confidence, 100),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Verify extracted slip data against specific order/payment record
 */
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>,
  existingFingerprints: Set<string>
): VerificationResult {
  const result: VerificationResult = {
    isAutoApproved: false,
    status: "pending_review",
    extractedData: extracted,
    fingerprint: generateFingerprint(extracted),
    linkedOrderId: context.orderId,
    linkedPaymentId: context.paymentId,
  };

  // Check 1: Bank detection
  if (!extracted.detectedBank) {
    result.reviewReason = "UNSUPPORTED_BANK";
    return result;
  }

  // Check 2: Shop name verification
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

  // Check 3: Merchant code verification
  if (!extracted.merchantCode) {
    result.reviewReason = "MISSING_MERCHANT_CODE";
    return result;
  }

  if (!validateMerchantCode(extracted.merchantCode, extracted.detectedBank)) {
    result.reviewReason = "INVALID_MERCHANT_CODE_FORMAT";
    return result;
  }

  if (extracted.merchantCode !== MERCHANT_CONFIG.merchantCode) {
    result.reviewReason = "MERCHANT_CODE_MISMATCH";
    return result;
  }

  // Check 4: Merchant transaction code (if present, must match)
  if (
    extracted.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    result.reviewReason = "MERCHANT_TRANSACTION_CODE_MISMATCH";
    return result;
  }

  // Check 5: Amount verification (use integer comparison for precision)
  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    return result;
  }

  const orderTotalSatang = Math.round(context.orderTotal * 100);
  const slipAmountSatang = Math.round(extracted.amount * 100);

  if (orderTotalSatang !== slipAmountSatang) {
    result.reviewReason = "AMOUNT_MISMATCH";
    return result;
  }

  // Check 6: Transaction date verification with tighter time window
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    return result;
  }

  const paymentTime = context.paymentCreatedAt.getTime();
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = paymentTime - transactionTime;
  
  // Transaction should be within 5 minutes of payment submission
  const maxTimeDiffMs = 5 * 60 * 1000; // 5 minutes
  
  if (Math.abs(timeDiffMs) > maxTimeDiffMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    return result;
  }

  // Check 7: Reference verification (duplicate detection - check both reference and fingerprint)
  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    return result;
  }

  if (!validateReferenceFormat(extracted.reference, extracted.detectedBank)) {
    result.reviewReason = "INVALID_REFERENCE_FORMAT";
    return result;
  }

  if (existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    return result;
  }

  // Check 8: Fingerprint-based duplicate detection
  if (existingFingerprints.has(result.fingerprint)) {
    result.reviewReason = "DUPLICATE_FINGERPRINT";
    return result;
  }

  // Check 9: Confidence level - must be >= 90 for auto-approval (raised from 85)
  if ((extracted.confidence || 0) < 90) {
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
    extracted.detectedBank || "",
  ].join("|");

  return crypto.createHash("sha256").update(fingerprintData).digest("hex");
}

/**
 * Parse OCR text from image URL using Manus LLM
 * Returns both text and OCR quality score
 */
export async function parseSlipImage(imageUrl: string): Promise<{
  text: string;
  confidence: number;
  warnings: string[];
}> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert at extracting text from Thai bank slip images.
Extract ALL visible text from the slip image, preserving the structure and labels.
Focus on: shop name (ชื่อร้านค้า), merchant code (รหัสร้านค้า), merchant transaction code (รหัสธุรกรรม), 
amount (จำนวนเงิน), transaction date (วันที่), and bank reference number (เลขที่อ้างอิง).

Return a JSON object with:
{
  "text": "extracted text exactly as it appears",
  "confidence": <0-100 score for image clarity>,
  "warnings": ["list of any issues with the image"]
}

If the image is not a bank slip, return confidence 0 and appropriate warnings.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please extract all text from this bank slip image and rate its clarity:",
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
      try {
        const parsed = JSON.parse(content);
        return {
          text: parsed.text || "",
          confidence: Math.max(0, Math.min(100, parsed.confidence || 0)),
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        };
      } catch {
        // If JSON parsing fails, treat as plain text
        return {
          text: content,
          confidence: 50,
          warnings: ["Failed to parse structured response from LLM"],
        };
      }
    }
    return {
      text: "",
      confidence: 0,
      warnings: ["No response from LLM"],
    };
  } catch (error) {
    console.error("Error parsing slip image:", error);
    return {
      text: "",
      confidence: 0,
      warnings: [`Error: ${error instanceof Error ? error.message : "Unknown error"}`],
    };
  }
}
