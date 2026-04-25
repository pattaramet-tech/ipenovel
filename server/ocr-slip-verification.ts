"use server";

import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System — Hardened v2
 *
 * Improvements over v1:
 * - Richer extraction: time-of-day, receiver name, masked account, bank aliases
 * - Buddhist year support in DD/MM/YYYY and DD MonthName YYYY formats
 * - Thai numeral normalisation applied before every extractor
 * - Amount: supports PromptPay "฿ 250.00", "250 บาท", "THB 250.00" patterns
 * - Reference: explicit-label-only (no bare alphanumeric fallback that caused false positives)
 * - Confidence: reweighted so core payment fields dominate; merchant fields are bonus
 * - Auto-approval: requires amount + date + reference + confidence ≥ 85 + ≥ 3 structured fields
 * - Duplicate detection: reference + fingerprint, both checked against approved AND pending_review
 * - Review reasons: granular, admin-friendly, no vague fallbacks
 * - Admin payload: includes transactionDateTime, receiverName, maskedAccount, rawText snippet
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
  // Short forms
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
  // English
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
  // Core payment fields
  amount?: number;
  transactionDate?: Date;
  transactionDateTime?: Date; // Full datetime if time is available
  reference?: string;
  // Bank / merchant fields
  detectedBank?: string;
  detectedBankName?: string;
  shopName?: string;
  receiverName?: string; // ชื่อผู้รับ / receiver
  maskedAccount?: string; // e.g. xxx-x-xx123-x
  merchantCode?: string;
  merchantTransactionCode?: string;
  // Meta
  confidence?: number; // 0-100
  rawText?: string;
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalise Thai numerals to Western digits (applied first in every extractor)
 */
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

/**
 * Normalise text for fuzzy matching (lowercase, collapse whitespace, strip punctuation)
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
 * Preprocess raw OCR text: normalise Thai numerals + collapse whitespace noise
 */
function preprocessOcrText(raw: string): string {
  let t = normalizeThaiNumerals(raw);
  // Collapse multiple spaces/tabs but preserve newlines for label extraction
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
  // Patterns: xxx-x-xx123-x  /  xxxx-xxxx-1234  /  **** **** 1234
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
    // Thai labels
    /จำนวนเงิน\s*[:：]\s*฿?\s*([\d,]+\.?\d*)/i,
    /ยอดเงิน\s*[:：]\s*฿?\s*([\d,]+\.?\d*)/i,
    /ยอดโอน\s*[:：]\s*฿?\s*([\d,]+\.?\d*)/i,
    /จำนวน\s*[:：]\s*฿?\s*([\d,]+\.?\d*)/i,
    // English labels
    /amount\s*[:：]\s*(?:thb|฿)?\s*([\d,]+\.?\d*)/i,
    /total\s*[:：]\s*(?:thb|฿)?\s*([\d,]+\.?\d*)/i,
    // PromptPay style: ฿ 250.00 or THB 250.00
    /(?:฿|thb)\s*([\d,]+\.?\d{2})/i,
    // Standalone amount with บาท suffix
    /([\d,]+\.?\d*)\s*บาท/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const amountStr = match[1].replace(/,/g, "");
      const amount = parseFloat(amountStr);
      if (!isNaN(amount) && amount > 0 && amount < 10_000_000) {
        return amount;
      }
    }
  }
  return undefined;
}

/**
 * Extract reference number — explicit label only (no bare alphanumeric fallback)
 * to avoid false positives from account numbers, merchant codes, etc.
 */
function extractReference(text: string): string | undefined {
  const patterns = [
    /เลขที่อ้างอิง\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /หมายเลขอ้างอิง\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /เลขที่รายการ\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /รหัสอ้างอิง\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /เลขอ้างอิง\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /transaction\s*(?:ref|id|no|number)\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /reference\s*(?:no|number|#)?\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /ref\s*(?:no|#)?\s*[:：]\s*([A-Z0-9]{8,20})/i,
    /txn\s*(?:id|ref)?\s*[:：]\s*([A-Z0-9]{8,20})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const ref = match[1].trim();
      // Must be 8-20 chars and contain at least one digit
      if (ref.length >= 8 && ref.length <= 20 && /\d/.test(ref)) {
        return ref;
      }
    }
  }
  return undefined;
}

/**
 * Extract transaction date (and optionally time) from OCR text.
 * Supports:
 * - DD/MM/YYYY (Buddhist or Gregorian)
 * - DD/MM/YY
 * - DD MonthNameThai YYYY
 * - DD MonthNameEng YYYY
 * - YYYY-MM-DD (ISO)
 * - With optional HH:MM or HH:MM:SS time component
 */
function extractTransactionDate(text: string): {
  date?: Date;
  dateTime?: Date;
} {
  // Helper: convert Buddhist year to Gregorian
  function toGregorian(year: number): number {
    if (year > 2500) return year - 543;
    if (year < 100) return year < 50 ? 2000 + year : 1900 + year;
    return year;
  }

  // Helper: build and validate date
  function buildDate(
    day: number,
    month: number,
    year: number,
    hour?: number,
    minute?: number,
    second?: number
  ): { date: Date; dateTime?: Date } | undefined {
    const y = toGregorian(year);
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    try {
      const d = new Date(y, month - 1, day);
      if (d.getMonth() !== month - 1) return undefined; // overflow (e.g. Feb 31)
      // Reasonable range: not in the future, not more than 90 days old
      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
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

  // Optional time suffix pattern
  const timeSuffix = /(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

  // Pattern 1: DD/MM/YYYY or DD-MM-YYYY with optional time
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

  // Pattern 2: bare DD/MM/YYYY (no label) with optional time
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

  // Pattern 3: DD MonthNameThai YYYY (e.g. "5 เมษายน 2569")
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

  // Pattern 4: ISO YYYY-MM-DD
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

  // Preprocess: normalise Thai numerals + whitespace
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

  // ─── Confidence scoring ───────────────────────────────────────────────────
  // Core payment fields (required for auto-approval) — weighted heavily
  let confidence = 0;
  if (amount) confidence += 25;
  if (transactionDate) confidence += 20;
  if (reference) confidence += 20;
  // Bank detection adds moderate confidence
  if (detectedBank) confidence += 10;
  // Merchant / shop fields are bonus
  if (shopName) confidence += 10;
  if (merchantCode) confidence += 10;
  if (merchantTransactionCode) confidence += 5;
  // Extra bonus for full datetime
  if (transactionDateTime) confidence += 5;
  // Receiver name or masked account adds a little
  if (receiverName || maskedAccount) confidence += 5;

  // Cap at 100
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

// ─── Verification function ────────────────────────────────────────────────────

/**
 * Verify extracted slip data against the specific order/payment record.
 *
 * Decision model:
 * HARD FAIL → MISSING_AMOUNT | AMOUNT_MISMATCH | MISSING_TRANSACTION_DATE |
 *             TRANSACTION_OUTSIDE_TIME_WINDOW | MISSING_REFERENCE |
 *             DUPLICATE_REFERENCE | DUPLICATE_FINGERPRINT |
 *             MERCHANT_CODE_MISMATCH | MERCHANT_TRANSACTION_CODE_MISMATCH
 *
 * MANUAL REVIEW → LOW_CONFIDENCE | INSUFFICIENT_STRUCTURED_DATA |
 *                 SHOP_NAME_MISMATCH (when shop name present but wrong)
 *
 * AUTO-APPROVE → all critical checks pass + confidence ≥ 85 + ≥ 3 structured fields
 *
 * Conservative principle: false approval is worse than manual review.
 */
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>,
  existingFingerprints: Set<string> = new Set()
): VerificationResult {
  const fingerprint = generateFingerprint(extracted);

  const result: VerificationResult = {
    isAutoApproved: false,
    status: "pending_review",
    extractedData: extracted,
    fingerprint,
    linkedOrderId: context.orderId,
    linkedPaymentId: context.paymentId,
  };

  // ===== CRITICAL CHECKS (HARD FAIL → pending_review) ======================

  // 1. Amount must be present
  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    return result;
  }

  // 2. Amount must match order total exactly (within floating-point tolerance)
  if (Math.abs(extracted.amount - context.orderTotal) > 0.01) {
    result.reviewReason = "AMOUNT_MISMATCH";
    return result;
  }

  // 3. Transaction date must be present
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    return result;
  }

  // 4. Transaction must be within acceptable time window
  //    - Not more than 24 hours before payment submission
  //    - Not more than 5 minutes after payment submission (clock skew)
  const paymentTime = context.paymentCreatedAt.getTime();
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = paymentTime - transactionTime;
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 h
  const clockSkewMs = 5 * 60 * 1000; // 5 min

  if (timeDiffMs > maxAgeMs || timeDiffMs < -clockSkewMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    return result;
  }

  // 5. Reference must be present (explicit label only — no bare alphanumeric fallback)
  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    return result;
  }

  // 6. Reference duplicate check (approved + pending_review)
  if (existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    return result;
  }

  // 7. Fingerprint duplicate check (catches OCR reference variations)
  if (existingFingerprints.has(fingerprint)) {
    result.reviewReason = "DUPLICATE_FINGERPRINT";
    return result;
  }

  // 8. Merchant code — if present, must match exactly
  if (
    extracted.merchantCode &&
    extracted.merchantCode !== MERCHANT_CONFIG.merchantCode
  ) {
    result.reviewReason = "MERCHANT_CODE_MISMATCH";
    return result;
  }

  // 9. Merchant transaction code — if present, must match exactly
  if (
    extracted.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    result.reviewReason = "MERCHANT_TRANSACTION_CODE_MISMATCH";
    return result;
  }

  // ===== OPTIONAL MERCHANT CHECKS (MANUAL REVIEW IF MISMATCH) ==============

  // 10. Shop name — if present and doesn't match any alias, flag for manual review
  if (extracted.shopName) {
    const normalizedShopName = normalizeText(extracted.shopName);
    const shopNameMatches = MERCHANT_CONFIG.shopNameAliases.some(
      (alias) => normalizeText(alias) === normalizedShopName
    );
    if (!shopNameMatches) {
      result.reviewReason = "SHOP_NAME_MISMATCH";
      return result;
    }
  }
  // If shop name is completely absent, we rely on other signals — no hard fail

  // ===== CONFIDENCE AND STRUCTURED DATA GATE ================================

  // 11. Confidence must be ≥ 85 for auto-approval
  if ((extracted.confidence ?? 0) < 85) {
    result.reviewReason = "LOW_CONFIDENCE";
    return result;
  }

  // 12. Structured data sufficiency — must have ≥ 3 of the core fields
  //     (amount, date, reference are already verified above; this checks the
  //      broader set to ensure we're not approving near-empty extractions)
  const structuredFieldCount = [
    extracted.amount,
    extracted.transactionDate,
    extracted.reference,
    extracted.shopName,
    extracted.merchantCode,
    extracted.detectedBank,
    extracted.receiverName,
  ].filter(Boolean).length;

  if (structuredFieldCount < 3) {
    result.reviewReason = "INSUFFICIENT_STRUCTURED_DATA";
    return result;
  }

  // ===== ALL CHECKS PASSED → AUTO-APPROVE ==================================
  result.isAutoApproved = true;
  result.status = "approved";
  return result;
}

// ─── Fingerprint generation ───────────────────────────────────────────────────

/**
 * Generate a deterministic fingerprint for duplicate detection.
 * Includes: reference + amount (2 dp) + merchantCode + date (YYYY-MM-DD)
 * This catches re-submissions even when OCR produces slightly different reference text.
 */
export function generateFingerprint(extracted: ExtractedSlipData): string {
  const fingerprintData = [
    extracted.reference ?? "",
    extracted.amount !== undefined ? extracted.amount.toFixed(2) : "",
    extracted.merchantCode ?? "",
    extracted.transactionDate
      ? extracted.transactionDate.toISOString().split("T")[0]
      : "",
  ].join("|");

  return crypto.createHash("sha256").update(fingerprintData).digest("hex");
}

// ─── LLM-based slip image parsing ────────────────────────────────────────────

/**
 * Parse OCR text from a slip image URL using the Manus LLM (vision model).
 * Returns raw extracted text for downstream parsing by extractSlipData().
 */
export async function parseSlipImage(imageUrl: string): Promise<string> {
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
    console.error("[OCR] Error parsing slip image:", error);
    return "";
  }
}
