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
  reference?: string;
  transactionDate?: Date;
  rawText?: string;
  confidence?: number; // 0-100
}

export interface OrderPaymentContext {
  orderId: number;
  paymentId: number;
  orderTotal: number;
  orderCreatedAt: Date;
  paymentCreatedAt: Date;
  slipSubmittedAt?: Date; // When slip was submitted (preferred for time window check)
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
 * Extract text from Thai bank slip image or PDF
 * Supports both JPG, PNG (via image_url) and PDF (via file_url)
 */
export async function parseSlipImage(imageUrl: string): Promise<string> {
  try {
    // Detect file type from URL: PDF or image
    const isPDF = imageUrl.toLowerCase().endsWith(".pdf");
    
    // Build content array based on file type
    const contentArray: any[] = [
      {
        type: "text",
        text: "Please extract all text from this bank slip:",
      },
    ];
    
    if (isPDF) {
      // PDF support via file_url
      contentArray.push({
        type: "file_url",
        file_url: {
          url: imageUrl,
          mime_type: "application/pdf",
        },
      });
    } else {
      // Image support via image_url (JPG, PNG)
      contentArray.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          detail: "high",
        },
      });
    }
    
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are an expert at extracting text from Thai bank slip images and PDFs. Extract ALL visible text from the slip, preserving the structure and labels. Focus on extracting: shop name (ชื่อร้านค้า), merchant code (รหัสร้านค้า), merchant transaction code (รหัสธุรกรรม), amount (จำนวนเงิน), transaction date (วันที่), and bank reference number (เลขที่อ้างอิง). Return the extracted text exactly as it appears on the slip.",
        },
        {
          role: "user",
          content: contentArray,
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

/**
 * Parse Thai date string (Buddhist year) to standard Date
 * Handles formats like "25/01/2568" (Buddhist year) or "25/01/2025" (AD year)
 */
function parseThaiDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  
  // Try to parse various Thai date formats
  const patterns = [
    /(\d{1,2})[\s\/\-](\d{1,2})[\s\/\-](\d{4})/,  // DD/MM/YYYY or DD-MM-YYYY
    /(\d{4})[\s\/\-](\d{1,2})[\s\/\-](\d{1,2})/,  // YYYY/MM/DD
  ];
  
  for (const pattern of patterns) {
    const match = dateStr.match(pattern);
    if (match) {
      let day, month, year;
      
      if (match[3].length === 4) {
        // First pattern: DD/MM/YYYY
        day = parseInt(match[1]);
        month = parseInt(match[2]);
        year = parseInt(match[3]);
      } else {
        // Second pattern: YYYY/MM/DD
        year = parseInt(match[1]);
        month = parseInt(match[2]);
        day = parseInt(match[3]);
      }
      
      // Convert Buddhist year to AD if needed
      // Buddhist year is typically 543 years ahead of AD
      if (year > 2500) {
        year = year - 543;
      }
      
      // Validate date
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
      }
      
      return new Date(year, month - 1, day);
    }
  }
  
  return null;
}

/**
 * Extract structured data from OCR text
 */
function extractStructuredData(ocrText: string): ExtractedSlipData {
  const data: ExtractedSlipData = {
    rawText: ocrText,
  };
  
  // Extract shop name (look for common patterns)
  const shopNameMatch = ocrText.match(/(?:ชื่อร้านค้า|shop name|merchant)[:\s]+([^\n]+)/i);
  if (shopNameMatch) {
    data.shopName = shopNameMatch[1].trim();
  }
  
  // Extract merchant code
  const merchantCodeMatch = ocrText.match(/(?:รหัสร้านค้า|merchant code|terminal)[:\s]+([A-Z0-9]+)/i);
  if (merchantCodeMatch) {
    data.merchantCode = merchantCodeMatch[1].trim();
  }
  
  // Extract merchant transaction code
  const txCodeMatch = ocrText.match(/(?:รหัสธุรกรรม|transaction code)[:\s]+([A-Z0-9]+)/i);
  if (txCodeMatch) {
    data.merchantTransactionCode = txCodeMatch[1].trim();
  }
  
  // Extract amount (look for currency patterns)
  const amountMatch = ocrText.match(/(?:จำนวนเงิน|amount)[:\s]+([0-9,]+\.?[0-9]*)/i);
  if (amountMatch) {
    const amountStr = amountMatch[1].replace(/,/g, "");
    data.amount = parseFloat(amountStr);
  }
  
  // Extract reference number
  const refMatch = ocrText.match(/(?:เลขที่อ้างอิง|reference|ref)[:\s]+([A-Z0-9]+)/i);
  if (refMatch) {
    data.reference = refMatch[1].trim();
  }
  
  // Extract transaction date
  const dateMatch = ocrText.match(/(?:วันที่|date)[:\s]+([0-9\/\-\s]+)/i);
  if (dateMatch) {
    const parsedDate = parseThaiDate(dateMatch[1]);
    if (parsedDate) {
      data.transactionDate = parsedDate;
    }
  }
  
  // Estimate confidence based on data completeness
  let confidence = 50;
  if (data.shopName) confidence += 10;
  if (data.merchantCode) confidence += 10;
  if (data.amount) confidence += 15;
  if (data.reference) confidence += 10;
  if (data.transactionDate) confidence += 15;
  
  data.confidence = Math.min(100, confidence);
  
  return data;
}

/**
 * Verify slip data against order/payment context
 * Returns auto-approval decision and reason codes
 */
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext
): VerificationResult {
  const result: VerificationResult = {
    isAutoApproved: false,
    status: "pending_review",
    extractedData: extracted,
    fingerprint: "",
    linkedOrderId: context.orderId,
    linkedPaymentId: context.paymentId,
  };

  // Check 1: Confidence threshold (must be >= 85 for auto-approval)
  if (!extracted.confidence || extracted.confidence < 85) {
    result.reviewReason = "LOW_CONFIDENCE";
    result.status = "pending_review";
    return result;
  }

  // Check 2: Amount verification (exact match required)
  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    return result;
  }

  if (Math.abs(extracted.amount - context.orderTotal) > 0.001) {
    result.reviewReason = "AMOUNT_MISMATCH";
    return result;
  }

  // Check 3: Shop name verification
  if (!extracted.shopName) {
    result.reviewReason = "MISSING_SHOP_NAME";
    return result;
  }

  const normalizedShopName = extracted.shopName.toLowerCase().trim();
  const isValidShopName = MERCHANT_CONFIG.shopNameAliases.some(alias =>
    normalizedShopName.includes(alias.toLowerCase())
  );

  if (!isValidShopName) {
    result.reviewReason = "INVALID_SHOP_NAME";
    return result;
  }

  // Check 4: Merchant code verification
  if (!extracted.merchantCode) {
    result.reviewReason = "MISSING_MERCHANT_CODE";
    return result;
  }

  if (extracted.merchantCode !== MERCHANT_CONFIG.merchantCode) {
    result.reviewReason = "INVALID_MERCHANT_CODE";
    return result;
  }

  // Check 5: Transaction date verification
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    return result;
  }

  // Verify transaction is within acceptable time window relative to slip submission
  // Use slipSubmittedAt if available (when slip was actually uploaded), fallback to paymentCreatedAt
  // Transaction should be before or shortly after slip submission (allow 5 min clock skew)
  const referenceTime = context.slipSubmittedAt || context.paymentCreatedAt;
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = referenceTime.getTime() - transactionTime;
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours before slip submission
  const minAgeMs = -5 * 60 * 1000; // 5 minutes after slip submission (clock skew tolerance)

  if (timeDiffMs > maxAgeMs || timeDiffMs < minAgeMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    return result;
  }

  // Check 6: Reference verification (duplicate detection)
  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    return result;
  }

  // Check 7: Generate fingerprint for duplicate detection
  const fingerprintData = `${extracted.amount}-${extracted.reference}-${extracted.transactionDate.toISOString()}`;
  result.fingerprint = crypto.createHash("sha256").update(fingerprintData).digest("hex");

  // All checks passed - auto-approve
  result.isAutoApproved = true;
  result.status = "approved";
  result.reviewReason = undefined;

  return result;
}

/**
 * Central OCR verification flow
 * Parses image, extracts data, verifies against order/payment context
 * Returns verification result with auto-approval decision
 */
export async function processSlipVerification(
  slipImageUrl: string,
  context: OrderPaymentContext,
  existingReferences?: Set<string>
): Promise<VerificationResult> {
  // Step 1: Parse slip image to extract OCR text
  const ocrText = await parseSlipImage(slipImageUrl);
  
  if (!ocrText) {
    return {
      isAutoApproved: false,
      status: "pending_review",
      reviewReason: "OCR_EXTRACTION_FAILED",
      extractedData: {},
      fingerprint: "",
      linkedOrderId: context.orderId,
      linkedPaymentId: context.paymentId,
    };
  }

  // Step 2: Extract structured data from OCR text
  const extracted = extractStructuredData(ocrText);

  // Step 3: Verify slip data against order/payment context
  const result = verifySlipData(extracted, context);

  // Step 4: Check for duplicate slips (if existing references provided)
  if (existingReferences && extracted.reference && existingReferences.has(extracted.reference)) {
    result.isAutoApproved = false;
    result.status = "pending_review";
    result.reviewReason = "DUPLICATE_SLIP";
  }

  return result;
}
