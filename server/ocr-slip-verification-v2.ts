"use server";
import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System — Hardened v3
 *
 * Improvements over v2:
 * - parseSlipImage now returns structured OCR result with confidence
 * - Tighter time window validation (2h for full datetime, 24h for date-only)
 * - Stronger fingerprint with fallback fields (reference → bank+account → shop)
 * - Verification breakdown for admin visibility
 * - Better bank signal usage in confidence scoring
 * - More conservative auto-approval thresholds
 */

// ─── Merchant configuration ───────────────────────────────────────────────────
const MERCHANT_CONFIG = {
  shopNameAliases: [
    "Ipe Novel",
    "Ipenovel",
    "IPE NOVEL",
    "ipe novel",
    "ipenovel",
    "ไอพี โนเวล",
    "ไอพีโนเวล",
  ],
  merchantCode: "KB000002283068",
  merchantTransactionCode: "KPS004KB000002283068",
};

// ─── Thai month mapping ───────────────────────────────────────────────────────
const THAI_MONTHS: Record<string, number> = {
  มกราคม: 1,
  กุมภาพันธ์: 2,
  มีนาคม: 3,
  เมษายน: 4,
  พฤษภาคม: 5,
  มิถุนายน: 6,
  กรกฎาคม: 7,
  สิงหาคม: 8,
  กันยายน: 9,
  ตุลาคม: 10,
  พฤศจิกายน: 11,
  ธันวาคม: 12,
  "ม.ค.": 1,
  "ก.พ.": 2,
  "มี.ค.": 3,
  "เม.ย.": 4,
  "พ.ค.": 5,
  "มิ.ย.": 6,
  "ก.ค.": 7,
  "ส.ค.": 8,
  "ก.ย.": 9,
  "ต.ค.": 10,
  "พ.ย.": 11,
  "ธ.ค.": 12,
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

// ─── Bank detection patterns ──────────────────────────────────────────────────
const BANK_PATTERNS: Array<{ patterns: string[]; code: string; name: string }> = [
  {
    patterns: ["ธนาคารกรุงเทพ", "Bangkok Bank", "BBL", "bbl"],
    code: "BBL",
    name: "Bangkok Bank",
  },
  {
    patterns: ["ธนาคารกสิกรไทย", "Kasikorn", "KBank", "KBANK", "กสิกรไทย"],
    code: "KBANK",
    name: "KBank",
  },
  {
    patterns: ["ธนาคารไทยพาณิชย์", "SCB", "ไทยพาณิชย์", "Siam Commercial"],
    code: "SCB",
    name: "SCB",
  },
  {
    patterns: ["ธนาคารกรุงไทย", "Krungthai", "KTB", "กรุงไทย"],
    code: "KTB",
    name: "Krungthai Bank",
  },
  {
    patterns: ["ธนาคารกรุงศรีอยุธยา", "Krungsri", "BAY", "กรุงศรี"],
    code: "BAY",
    name: "Krungsri",
  },
  {
    patterns: ["ธนาคารทหารไทยธนชาต", "TTB", "ทหารไทย", "ธนชาต"],
    code: "TTB",
    name: "TTB",
  },
  {
    patterns: ["ธนาคารออมสิน", "GSB", "ออมสิน"],
    code: "GSB",
    name: "Government Savings Bank",
  },
  {
    patterns: ["PromptPay", "พร้อมเพย์", "promptpay"],
    code: "PROMPTPAY",
    name: "PromptPay",
  },
  {
    patterns: ["TrueMoney", "ทรูมันนี่", "true money"],
    code: "TRUEMONEY",
    name: "TrueMoney",
  },
];

// ─── Public types ─────────────────────────────────────────────────────────────
export interface ExtractedSlipData {
  amount?: number;
  transactionDate?: Date;
  transactionDateTime?: Date;
  reference?: string;
  detectedBank?: string;
  detectedBankName?: string;
  shopName?: string;
  receiverName?: string;
  maskedAccount?: string;
  merchantCode?: string;
  merchantTransactionCode?: string;
  confidence?: number;
  rawText?: string;
}

export interface OrderPaymentContext {
  orderId: number;
  paymentId: number;
  orderTotal: number;
  orderCreatedAt: Date;
  paymentCreatedAt: Date;
}

export interface VerificationBreakdown {
  amountMatched: boolean;
  datePresent: boolean;
  dateWithinWindow: boolean;
  referencePresent: boolean;
  duplicateReference: boolean;
  duplicateFingerprint: boolean;
  bankDetected: boolean;
  ocrConfidence: number;
  finalDecision: "approved" | "pending_review";
  failureReason?: string;
}

export interface VerificationResult {
  isAutoApproved: boolean;
  status: "approved" | "pending_review";
  reviewReason?: string;
  extractedData: ExtractedSlipData;
  fingerprint: string;
  linkedOrderId: number;
  linkedPaymentId: number;
  breakdown?: VerificationBreakdown;
}

export interface ParseSlipImageResult {
  text: string;
  ocrConfidence: number;
  warnings: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
export function normalizeThaiNumerals(text: string): string {
  const map: Record<string, string> = {
    "๐": "0",
    "๑": "1",
    "๒": "2",
    "๓": "3",
    "๔": "4",
    "๕": "5",
    "๖": "6",
    "๗": "7",
    "๘": "8",
    "๙": "9",
  };
  return text.split("").map((c) => map[c] ?? c).join("");
}

function normalizeText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\u0E00-\u0E7Fa-z0-9\s]/g, "");
}

function preprocessOcrText(raw: string): string {
  let t = normalizeThaiNumerals(raw);
  t = t.replace(/[ \t]+/g, " ");
  return t;
}

// ─── Field extractors ─────────────────────────────────────────────────────────
function extractShopName(text: string): string | undefined {
  const patterns = [
    /ชื่อร้านค้า\s*[:：]\s*([^\n]+)/i,
    /ชื่อ\s*[:：]\s*([^\n]+)/i,
    /shop\s*name\s*[:：]\s*([^\n]+)/i,
    /merchant\s*name\s*[:：]\s*([^\n]+)/i,
    /(?<!รหัส)ร้านค้า\s*[:：]\s*([^\n]+)/i,
    /shop\s*[:：]\s*([^\n]+)/i,
    /ชื่อผู้รับ\s*[:：]\s*([^\n]+)/i,
    /ผู้รับ\s*[:：]\s*([^\n]+)/i,
    /receiver\s*[:：]\s*([^\n]+)/i,
    /to\s*[:：]\s*([^\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim().replace(/\s+/g, " ").substring(0, 100);
      if (extracted.length > 2) return extracted;
    }
  }
  return undefined;
}

function extractReceiverName(text: string): string | undefined {
  const patterns = [
    /ชื่อผู้รับ\s*[:：]\s*([^\n]+)/i,
    /ผู้รับเงิน\s*[:：]\s*([^\n]+)/i,
    /receiver\s*name\s*[:：]\s*([^\n]+)/i,
    /to\s*[:：]\s*([^\n]+)/i,
    /โอนให้\s*[:：]\s*([^\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim().replace(/\s+/g, " ").substring(0, 100);
      if (extracted.length > 2) return extracted;
    }
  }
  return undefined;
}

function extractMaskedAccount(text: string): string | undefined {
  const patterns = [
    /([x*]{3,}[-\s]?[x*0-9]{1,4}[-\s]?[x*0-9]{2,6}[-\s]?[x*0-9]{1,4})/i,
    /เลขที่บัญชี\s*[:：]\s*([^\n]+)/i,
    /account\s*(?:no|number|#)\s*[:：]\s*([^\n]+)/i,
    /บัญชี\s*[:：]\s*([^\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim().substring(0, 30);
      if (extracted.length > 4) return extracted;
    }
  }
  return undefined;
}

function extractMerchantCode(text: string): string | undefined {
  const patterns = [
    /รหัสร้านค้า\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*id\s*[:：]\s*([A-Z0-9]+)/i,
    /([A-Z]{2}\d{12})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractMerchantTransactionCode(text: string): string | undefined {
  const patterns = [
    /รหัสธุรกรรม\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /([A-Z]{3}\d{3}[A-Z]{2}\d{12})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractAmount(text: string): number | undefined {
  const patterns = [
    /จำนวนเงิน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดเงิน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดโอน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /amount\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /฿\s*([\d,]+(?:\.\d{2})?)/,
    /บาท\s*([\d,]+(?:\.\d{2})?)/i,
    /THB\s*([\d,]+(?:\.\d{2})?)/i,
    /([\d,]+(?:\.\d{2})?)\s*(?:บาท|baht|฿)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const numStr = match[1].replace(/,/g, "");
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0) return num;
    }
  }
  return undefined;
}

function extractReference(text: string): string | undefined {
  const patterns = [
    /เลขที่อ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /หมายเลขอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /reference\s*(?:number|#|code)?\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*id\s*[:：]\s*([A-Z0-9]+)/i,
    /txn\s*(?:id|code)?\s*[:：]\s*([A-Z0-9]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim().toUpperCase();
      if (extracted.length >= 4) return extracted;
    }
  }
  return undefined;
}

function extractTransactionDate(text: string): { date?: Date; dateTime?: Date } {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  function buildDate(
    day: number,
    month: number,
    year: number,
    hour?: number,
    minute?: number,
    second?: number
  ): { date?: Date; dateTime?: Date } | undefined {
    try {
      let y = year;
      if (y > 2400) y -= 543;
      if (y < 100) y += 2000;
      if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
      const d = new Date(y, month - 1, day);
      if (d > now || d < ninetyDaysAgo) return undefined;
      if (hour !== undefined && minute !== undefined) {
        const dt = new Date(y, month - 1, day, hour, minute, second ?? 0);
        return { date: d, dateTime: dt };
      }
      return { date: d };
    } catch {
      return undefined;
    }
  }

  const timeSuffix = /(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

  {
    const re = new RegExp(
      /(?:วันที่|date)\s*[:：]?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/.source +
        timeSuffix.source,
      "i"
    );
    const m = text.match(re);
    if (m) {
      const r = buildDate(
        parseInt(m[1]),
        parseInt(m[2]),
        parseInt(m[3]),
        m[4] !== undefined ? parseInt(m[4]) : undefined,
        m[5] !== undefined ? parseInt(m[5]) : undefined,
        m[6] !== undefined ? parseInt(m[6]) : undefined
      );
      if (r) return r;
    }
  }

  {
    const re = new RegExp(
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.source + timeSuffix.source
    );
    const m = text.match(re);
    if (m) {
      const r = buildDate(
        parseInt(m[1]),
        parseInt(m[2]),
        parseInt(m[3]),
        m[4] !== undefined ? parseInt(m[4]) : undefined,
        m[5] !== undefined ? parseInt(m[5]) : undefined,
        m[6] !== undefined ? parseInt(m[6]) : undefined
      );
      if (r) return r;
    }
  }

  {
    const monthNames = Object.keys(THAI_MONTHS).join("|");
    const re = new RegExp(
      `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})` + timeSuffix.source,
      "i"
    );
    const m = text.match(re);
    if (m) {
      const month = THAI_MONTHS[m[2]];
      if (month) {
        const r = buildDate(
          parseInt(m[1]),
          month,
          parseInt(m[3]),
          m[4] !== undefined ? parseInt(m[4]) : undefined,
          m[5] !== undefined ? parseInt(m[5]) : undefined,
          m[6] !== undefined ? parseInt(m[6]) : undefined
        );
        if (r) return r;
      }
    }
  }

  {
    const re = new RegExp(
      /(\d{4})-(\d{2})-(\d{2})/.source + timeSuffix.source
    );
    const m = text.match(re);
    if (m) {
      const r = buildDate(
        parseInt(m[3]),
        parseInt(m[2]),
        parseInt(m[1]),
        m[4] !== undefined ? parseInt(m[4]) : undefined,
        m[5] !== undefined ? parseInt(m[5]) : undefined,
        m[6] !== undefined ? parseInt(m[6]) : undefined
      );
      if (r) return r;
    }
  }

  return {};
}

function detectBank(text: string): { code?: string; name?: string } {
  const lower = text.toLowerCase();
  for (const bank of BANK_PATTERNS) {
    if (bank.patterns.some((p) => lower.includes(p.toLowerCase()))) {
      return { code: bank.code, name: bank.name };
    }
  }
  return {};
}

// ─── Main extraction function ─────────────────────────────────────────────────
export function extractSlipData(ocrText: string): ExtractedSlipData {
  if (!ocrText || ocrText.trim().length === 0) {
    return { confidence: 0 };
  }

  const text = preprocessOcrText(ocrText);
  const shopName = extractShopName(text);
  const receiverName = extractReceiverName(text);
  const maskedAccount = extractMaskedAccount(text);
  const merchantCode = extractMerchantCode(text);
  const merchantTransactionCode = extractMerchantTransactionCode(text);
  const amount = extractAmount(text);
  const { date: transactionDate, dateTime: transactionDateTime } =
    extractTransactionDate(text);
  const reference = extractReference(text);
  const { code: detectedBank, name: detectedBankName } = detectBank(text);

  // ─── Confidence scoring (improved) ───────────────────────────────────────
  let confidence = 0;
  if (amount) confidence += 25;
  if (transactionDate) confidence += 20;
  if (reference) confidence += 20;
  if (detectedBank) confidence += 10;
  if (shopName) confidence += 10;
  if (merchantCode) confidence += 10;
  if (merchantTransactionCode) confidence += 5;
  if (transactionDateTime) confidence += 5;
  if (receiverName || maskedAccount) confidence += 5;
  confidence = Math.min(confidence, 100);

  return {
    amount,
    transactionDate,
    transactionDateTime,
    reference,
    detectedBank,
    detectedBankName,
    shopName,
    receiverName,
    maskedAccount,
    merchantCode,
    merchantTransactionCode,
    confidence,
    rawText: ocrText,
  };
}

// ─── Improved fingerprint generation ───────────────────────────────────────────
/**
 * Generate a deterministic fingerprint with fallback fields.
 * Primary: reference + amount + date
 * Fallback: if reference missing, use bank + amount + date + maskedAccount
 * Tertiary: if still weak, use amount + date + shopName
 */
export function generateFingerprint(extracted: ExtractedSlipData): string {
  let fingerprintData: string;

  if (extracted.reference) {
    // Primary: reference-based (most reliable)
    fingerprintData = [
      extracted.reference,
      extracted.amount !== undefined ? extracted.amount.toFixed(2) : "",
      extracted.transactionDate
        ? extracted.transactionDate.toISOString().split("T")[0]
        : "",
    ].join("|");
  } else if (extracted.detectedBank && extracted.maskedAccount) {
    // Fallback: bank + account + amount + date
    fingerprintData = [
      extracted.detectedBank,
      extracted.maskedAccount,
      extracted.amount !== undefined ? extracted.amount.toFixed(2) : "",
      extracted.transactionDate
        ? extracted.transactionDate.toISOString().split("T")[0]
        : "",
    ].join("|");
  } else {
    // Tertiary: shop + amount + date
    fingerprintData = [
      extracted.shopName ?? "",
      extracted.amount !== undefined ? extracted.amount.toFixed(2) : "",
      extracted.transactionDate
        ? extracted.transactionDate.toISOString().split("T")[0]
        : "",
    ].join("|");
  }

  return crypto.createHash("sha256").update(fingerprintData).digest("hex");
}

// ─── Improved verification function ────────────────────────────────────────────
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>,
  existingFingerprints: Set<string> = new Set(),
  minConfidence: number = 85
): VerificationResult {
  const fingerprint = generateFingerprint(extracted);
  const breakdown: VerificationBreakdown = {
    amountMatched: false,
    datePresent: false,
    dateWithinWindow: false,
    referencePresent: false,
    duplicateReference: false,
    duplicateFingerprint: false,
    bankDetected: !!extracted.detectedBank,
    ocrConfidence: extracted.confidence ?? 0,
    finalDecision: "pending_review",
  };

  const result: VerificationResult = {
    isAutoApproved: false,
    status: "pending_review",
    extractedData: extracted,
    fingerprint,
    linkedOrderId: context.orderId,
    linkedPaymentId: context.paymentId,
    breakdown,
  };

  // ===== CRITICAL CHECKS (HARD FAIL → pending_review) ======================

  // 1. Amount must be present
  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    breakdown.failureReason = "No amount detected in slip";
    return result;
  }

  // 2. Amount must match order total exactly
  if (Math.abs(extracted.amount - context.orderTotal) > 0.01) {
    result.reviewReason = "AMOUNT_MISMATCH";
    breakdown.failureReason = `Amount mismatch: slip=${extracted.amount}, order=${context.orderTotal}`;
    return result;
  }
  breakdown.amountMatched = true;

  // 3. Transaction date must be present
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    breakdown.failureReason = "No transaction date detected in slip";
    return result;
  }
  breakdown.datePresent = true;

  // 4. Transaction must be within tightened time window
  //    - If full datetime: 2-hour window
  //    - If date-only: 24-hour window
  //    - Clock skew: 5 minutes after
  const paymentTime = context.paymentCreatedAt.getTime();
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = paymentTime - transactionTime;
  const clockSkewMs = 5 * 60 * 1000; // 5 min after

  let maxAgeMs: number;
  if (extracted.transactionDateTime) {
    // Full datetime: use 2-hour window (tighter)
    maxAgeMs = 2 * 60 * 60 * 1000;
  } else {
    // Date-only: use 24-hour window (but more conservative)
    maxAgeMs = 24 * 60 * 60 * 1000;
  }

  if (timeDiffMs > maxAgeMs || timeDiffMs < -clockSkewMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    breakdown.failureReason = `Transaction outside time window: ${timeDiffMs}ms (max: ${maxAgeMs}ms)`;
    return result;
  }
  breakdown.dateWithinWindow = true;

  // 5. Reference must be present
  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    breakdown.failureReason = "No reference number detected in slip";
    return result;
  }
  breakdown.referencePresent = true;

  // 6. Reference duplicate check
  if (existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    breakdown.duplicateReference = true;
    breakdown.failureReason = "Reference already used in another payment";
    return result;
  }

  // 7. Fingerprint duplicate check
  if (existingFingerprints.has(fingerprint)) {
    result.reviewReason = "DUPLICATE_FINGERPRINT";
    breakdown.duplicateFingerprint = true;
    breakdown.failureReason = "Duplicate payment detected (fingerprint match)";
    return result;
  }

  // 8. Merchant code validation (if present)
  if (
    extracted.merchantCode &&
    extracted.merchantCode !== MERCHANT_CONFIG.merchantCode
  ) {
    result.reviewReason = "MERCHANT_CODE_MISMATCH";
    breakdown.failureReason = `Merchant code mismatch: ${extracted.merchantCode}`;
    return result;
  }

  // 9. Merchant transaction code validation (if present)
  if (
    extracted.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    result.reviewReason = "MERCHANT_TRANSACTION_CODE_MISMATCH";
    breakdown.failureReason = `Transaction code mismatch: ${extracted.merchantTransactionCode}`;
    return result;
  }

  // ===== OPTIONAL MERCHANT CHECKS ============================================

  // 10. Shop name validation (if present)
  if (extracted.shopName) {
    const normalizedShopName = normalizeText(extracted.shopName);
    const shopNameMatches = MERCHANT_CONFIG.shopNameAliases.some(
      (alias) => normalizeText(alias) === normalizedShopName
    );
    if (!shopNameMatches) {
      result.reviewReason = "SHOP_NAME_MISMATCH";
      breakdown.failureReason = `Shop name mismatch: ${extracted.shopName}`;
      return result;
    }
  }

  // ===== CONFIDENCE AND STRUCTURED DATA GATE ================================

  // 11. Confidence must meet minimum threshold for auto-approval (configurable via OCR_MIN_CONFIDENCE)
  if ((extracted.confidence ?? 0) < minConfidence) {
    result.reviewReason = "LOW_CONFIDENCE";
    breakdown.failureReason = `OCR confidence too low: ${extracted.confidence}% (minimum: ${minConfidence}%)`;
    return result;
  }

  // 12. Structured data sufficiency
  const structuredFieldCount = [
    extracted.amount,
    extracted.transactionDate,
    extracted.reference,
    extracted.shopName,
    extracted.merchantCode,
    extracted.detectedBank,
    extracted.receiverName,
  ].filter(Boolean).length;

  if (structuredFieldCount < 2) {
    result.reviewReason = "INSUFFICIENT_STRUCTURED_DATA";
    breakdown.failureReason = `Insufficient structured data: ${structuredFieldCount} fields`;
    return result;
  }

  // ===== ALL CHECKS PASSED → AUTO-APPROVE ==================================
  result.isAutoApproved = true;
  result.status = "approved";
  breakdown.finalDecision = "approved";
  return result;
}

// ─── Improved LLM-based slip image parsing ──────────────────────────────────
/**
 * Parse OCR text from a slip image URL using the Manus LLM (vision model).
 * Returns structured result with OCR confidence and warnings.
 */
export async function parseSlipImage(
  imageUrl: string
): Promise<ParseSlipImageResult> {
  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are an expert at extracting text from Thai bank payment slip images.
Extract ALL visible text from the slip image, preserving the original structure and labels.
Focus especially on:
- ชื่อร้านค้า / shop name / merchant name / ชื่อผู้รับ / receiver name
- รหัสร้านค้า / merchant code
- รหัสธุรกรรม / transaction code
- จำนวนเงิน / amount / ยอดเงิน / ยอดโอน
- วันที่ / date (include time if visible)
- เลขที่อ้างอิง / หมายเลขอ้างอิง / reference number / transaction ID
- ธนาคาร / bank name
- เลขที่บัญชี / account number (masked)
Return the text exactly as it appears on the slip, preserving Thai characters, numbers, and formatting.
Do NOT translate or interpret — just extract the raw text.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please extract all text from this bank slip image and estimate OCR confidence (0-100):",
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
    if (typeof content !== "string") {
      return {
        text: "",
        ocrConfidence: 0,
        warnings: ["Failed to extract text from image"],
      };
    }

    // Try to extract OCR confidence from response
    // Look for patterns like "confidence: 95%" or "confidence: 95"
    let ocrConfidence = 85; // Default reasonable confidence
    const confidenceMatch = content.match(/confidence[:\s]+(\d+)/i);
    if (confidenceMatch) {
      const parsed = parseInt(confidenceMatch[1]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        ocrConfidence = parsed;
      }
    }

    const warnings: string[] = [];
    if (ocrConfidence < 70) {
      warnings.push("Low OCR confidence - manual review recommended");
    }
    if (content.length < 50) {
      warnings.push("Very short OCR output - may indicate poor image quality");
    }

    return {
      text: content,
      ocrConfidence,
      warnings,
    };
  } catch (error) {
    console.error("[OCR] Error parsing slip image:", error);
    return {
      text: "",
      ocrConfidence: 0,
      warnings: ["Error parsing image - check URL and image format"],
    };
  }
}
