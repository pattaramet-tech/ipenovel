import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System — Hardened v3
 *
 * Major improvements:
 * - Canonical OCR normalization layer (JSON parsing, flattening, field mapping)
 * - Fixed Thai Buddhist year parsing (69 → 2026, not 2069)
 * - Support for nested JSON fields (transaction_id_or_reference_number.value)
 * - Thai label mapping (เลขที่รายการ → reference, จำนวนเงิน → amount)
 * - Improved OCR confidence extraction (multiple formats)
 * - Better duplicate detection with strong fingerprints
 * - Safety: OCR errors don't crash checkout, fallback to manual review
 * - Detailed response status (pending_review vs pending)
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
    patterns: ["ธนาคารกสิกรไทย", "Kasikorn", "KBank", "KBANK", "กสิกรไทย", "K+"],
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
  visionConfidence?: number;
  structuredConfidence?: number;
  finalConfidence?: number;
  rawText?: string;
}

export interface OrderPaymentContext {
  orderId: number;
  paymentId: number;
  orderTotal: number;
  orderCreatedAt: Date;
  paymentCreatedAt: Date;
  slipSubmittedAt?: Date;
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

// ─── Canonical OCR normalization layer ────────────────────────────────────────
/**
 * Normalize OCR rawText by:
 * 1. Stripping markdown code fences
 * 2. Detecting and parsing JSON
 * 3. Flattening nested objects
 * 4. Mapping Thai/English labels to canonical fields
 */
export function normalizeOcrText(rawText: string): Record<string, any> {
  if (!rawText || rawText.trim().length === 0) {
    return {};
  }

  let text = rawText.trim();

  // Strip markdown code fences
  text = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "");

  // Try to parse as JSON
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON, treat as plain text
    return { rawText: text };
  }

  // Flatten nested objects recursively
  const flattened = flattenObject(parsed);

  // Map canonical field names
  const canonical = mapCanonicalFields(flattened);

  return canonical;
}

function flattenObject(obj: any, prefix = ""): Record<string, any> {
  const result: Record<string, any> = {};

  if (typeof obj !== "object" || obj === null) {
    return { value: obj };
  }

  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;

    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Recursively flatten nested objects
      Object.assign(result, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      result[newKey] = value;
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function mapCanonicalFields(flattened: Record<string, any>): Record<string, any> {
  const canonical: Record<string, any> = { ...flattened };

  // Map amount
  const amountKeys = [
    "amount",
    "จำนวนเงิน",
    "จำนวน",
    "amount.value",
    "ยอดเงิน",
    "ยอดโอน",
  ];
  for (const key of amountKeys) {
    if (flattened[key]) {
      canonical.amount = flattened[key];
      break;
    }
  }

  // Map transaction date/time - prefer date_time or วันที่_เวลา
  const dateKeys = [
    "date_time",
    "วันที่_เวลา",
    "date",
    "วันที่",
    "time",
    "datetime",
    "transactionDate",
  ];
  for (const key of dateKeys) {
    if (flattened[key]) {
      canonical.dateTime = flattened[key];
      break;
    }
  }

  // Map reference - handle nested objects
  const refKeys = [
    "transaction_id_or_reference_number.value",
    "transaction_id_or_reference_number",
    "reference",
    "reference_number",
    "เลขที่รายการ",
    "รหัสรายการ",
    "รหัสอ้างอิง",
    "หมายเลขอ้างอิง",
    "transaction_id",
  ];
  for (const key of refKeys) {
    if (flattened[key]) {
      let val = flattened[key];
      // If it's a nested object with 'value' field, extract it
      if (typeof val === "object" && val !== null && "value" in val) {
        val = val.value;
      }
      if (val) {
        canonical.reference = val;
        break;
      }
    }
  }

  // Map shop/receiver name
  const shopKeys = [
    "receiver_shop_name",
    "ชื่อร้านค้า_หรือ_ชื่อผู้รับ",
    "ชื่อร้านค้า / ชื่อผู้รับ",
    "ชื่อร้านค้า",
    "receiver_name",
    "ผู้รับ",
    "shopName",
    "receiverName",
  ];
  for (const key of shopKeys) {
    if (flattened[key]) {
      let val = flattened[key];
      // If it's a nested object with 'value' field, extract it
      if (typeof val === "object" && val !== null && "value" in val) {
        val = val.value;
      }
      if (val) {
        canonical.shopName = val;
        break;
      }
    }
  }

  // Map merchant code
  const merchantKeys = [
    "merchant_code",
    "รหัสร้านค้า",
    "merchantCode",
  ];
  for (const key of merchantKeys) {
    if (flattened[key]) {
      canonical.merchantCode = flattened[key];
      break;
    }
  }

  // Map transaction code
  const txnCodeKeys = [
    "transaction_code",
    "รหัสธุรกรรม",
    "merchantTransactionCode",
  ];
  for (const key of txnCodeKeys) {
    if (flattened[key]) {
      canonical.merchantTransactionCode = flattened[key];
      break;
    }
  }

  // Map bank
  const bankKeys = [
    "bank_name",
    "sender_bank",
    "ธนาคาร",
    "ธ.กสิกรไทย",
    "detectedBank",
  ];
  for (const key of bankKeys) {
    if (flattened[key]) {
      canonical.bank = flattened[key];
      break;
    }
  }

  // Map masked account
  const accountKeys = [
    "sender_account_number_masked",
    "sender_account_number",
    "เลขที่บัญชี_masked",
    "เลขที่บัญชีผู้ส่ง (masked)",
    "maskedAccount",
  ];
  for (const key of accountKeys) {
    if (flattened[key]) {
      canonical.maskedAccount = flattened[key];
      break;
    }
  }

  return canonical;
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
function extractShopName(text: string, normalized: Record<string, any>): string | undefined {
  // First check normalized fields
  if (normalized.shopName) {
    const val = String(normalized.shopName).trim();
    if (val.length > 2) return val;
  }

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

function extractReceiverName(text: string, normalized: Record<string, any>): string | undefined {
  if (normalized.shopName) {
    const val = String(normalized.shopName).trim();
    if (val.length > 2) return val;
  }

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

function extractMaskedAccount(text: string, normalized: Record<string, any>): string | undefined {
  if (normalized.maskedAccount) {
    return String(normalized.maskedAccount).trim();
  }

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

function extractMerchantCode(text: string, normalized: Record<string, any>): string | undefined {
  if (normalized.merchantCode) {
    return String(normalized.merchantCode).trim();
  }

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

function extractMerchantTransactionCode(text: string, normalized: Record<string, any>): string | undefined {
  if (normalized.merchantTransactionCode) {
    return String(normalized.merchantTransactionCode).trim();
  }

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

function extractAmount(text: string, normalized: Record<string, any>): number | undefined {
  // First check normalized fields
  if (normalized.amount) {
    let amountVal = normalized.amount;
    // If it's a nested object with 'value' field, extract it
    if (typeof amountVal === "object" && amountVal !== null && "value" in amountVal) {
      amountVal = amountVal.value;
    }
    const amountStr = String(amountVal);
    const numStr = amountStr.replace(/[^\d.]/g, "");
    const num = parseFloat(numStr);
    if (!isNaN(num) && num > 0) return num;
  }
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

function extractReference(text: string, normalized: Record<string, any>): string | undefined {
  // First check normalized fields
  if (normalized.reference) {
    const val = String(normalized.reference).trim().toUpperCase();
    if (val.length >= 4) return val;
  }

  const patterns = [
    /เลขที่อ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /หมายเลขอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
    /เลขที่รายการ\s*[:：]\s*([A-Z0-9]+)/i,
    /รหัสรายการ\s*[:：]\s*([A-Z0-9]+)/i,
    /รหัสอ้างอิง\s*[:：]\s*([A-Z0-9]+)/i,
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

/**
 * Parse transaction date with proper Thai Buddhist year handling.
 * Candidate-based approach:
 * - AD short year: 2000 + yy
 * - Buddhist short year: 2500 + yy - 543
 * Choose candidate within allowed window and not far future.
 */
function extractTransactionDate(text: string, normalized: Record<string, any>): { date?: Date; dateTime?: Date } {
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

      // Handle Thai Buddhist year
      if (y > 2400) {
        // Definitely Buddhist year, convert to AD
        y = y - 543;
      } else if (y >= 50 && y <= 99) {
        // Short year: could be AD (2050-2099) or Buddhist (2550-2599 → 2007-2056)
        // Use candidate-based approach
        const adYear = 2000 + y;
        const buddhYear = 2500 + y - 543;

        // Choose the one within the allowed window
        const adDate = new Date(adYear, month - 1, day);
        const buddhDate = new Date(buddhYear, month - 1, day);

        if (adDate <= now && adDate >= ninetyDaysAgo) {
          y = adYear;
        } else if (buddhDate <= now && buddhDate >= ninetyDaysAgo) {
          y = buddhYear;
        } else {
          // Neither fits, prefer AD
          y = adYear;
        }
      } else if (y < 50) {
        // Very small year, assume 2000+yy
        y = 2000 + y;
      }

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

  // First check normalized dateTime field
  if (normalized.dateTime) {
    const dateStr = String(normalized.dateTime);
    // Try to parse it
    const result = parseDateString(dateStr, buildDate);
    if (result) return result;
  }

  const timeSuffix = /(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;

  // Pattern: "23 พ.ค. 69 22:48 น."
  {
    const monthNames = Object.keys(THAI_MONTHS).join("|");
    const re = new RegExp(
      `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})` + timeSuffix.source + "\\s*น\\.?",
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

  // Pattern: "23 พ.ค. 69 22:48"
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

  // Pattern: "23/05/2026"
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

  // Pattern: "23-05-2026"
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

  // Pattern: "2026-05-23"
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

function parseDateString(
  dateStr: string,
  buildDate: (day: number, month: number, year: number, hour?: number, minute?: number, second?: number) => any
): { date?: Date; dateTime?: Date } | undefined {
  const timeSuffix = /(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/;
  const monthNames = Object.keys(THAI_MONTHS).join("|");

  // Try Thai month pattern
  {
    const re = new RegExp(
      `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})` + timeSuffix.source,
      "i"
    );
    const m = dateStr.match(re);
    if (m) {
      const month = THAI_MONTHS[m[2]];
      if (month) {
        return buildDate(
          parseInt(m[1]),
          month,
          parseInt(m[3]),
          m[4] !== undefined ? parseInt(m[4]) : undefined,
          m[5] !== undefined ? parseInt(m[5]) : undefined,
          m[6] !== undefined ? parseInt(m[6]) : undefined
        );
      }
    }
  }

  return undefined;
}

function detectBank(text: string, normalized: Record<string, any>): { code?: string; name?: string } {
  // Check normalized bank field first
  if (normalized.bank) {
    const bankStr = String(normalized.bank).toLowerCase();
    for (const bank of BANK_PATTERNS) {
      if (bank.patterns.some((p) => bankStr.includes(p.toLowerCase()))) {
        return { code: bank.code, name: bank.name };
      }
    }
  }

  const lower = text.toLowerCase();
  for (const bank of BANK_PATTERNS) {
    if (bank.patterns.some((p) => lower.includes(p.toLowerCase()))) {
      return { code: bank.code, name: bank.name };
    }
  }
  return {};
}

// ─── Main extraction function ────────────────────────────────────────────────────
export function extractSlipData(
  ocrText: string,
  visionConfidence?: number
): ExtractedSlipData {
  if (!ocrText || ocrText.trim().length === 0) {
    const safeVisionConfidence = typeof visionConfidence === "number" ? visionConfidence : 0;
    return {
      confidence: 0,
      visionConfidence: safeVisionConfidence,
      structuredConfidence: 0,
      finalConfidence: 0,
    };
  }

  // Normalize OCR text (JSON parsing, flattening, field mapping)
  const normalized = normalizeOcrText(ocrText);

  const text = preprocessOcrText(ocrText);
  const shopName = extractShopName(text, normalized);
  const receiverName = extractReceiverName(text, normalized);
  const maskedAccount = extractMaskedAccount(text, normalized);
  const merchantCode = extractMerchantCode(text, normalized);
  const merchantTransactionCode = extractMerchantTransactionCode(text, normalized);
  const amount = extractAmount(text, normalized);
  const { date: transactionDate, dateTime: transactionDateTime } =
    extractTransactionDate(text, normalized);
  const reference = extractReference(text, normalized);
  const { code: detectedBank, name: detectedBankName } = detectBank(text, normalized);

  // ─── Confidence scoring ─────────────────────────────────────────────────
  let structuredConfidence = 0;
  if (amount) structuredConfidence += 25;
  if (transactionDate) structuredConfidence += 20;
  if (reference) structuredConfidence += 20;
  if (detectedBank) structuredConfidence += 10;
  if (shopName) structuredConfidence += 10;
  if (merchantCode) structuredConfidence += 10;
  if (merchantTransactionCode) structuredConfidence += 5;
  if (transactionDateTime) structuredConfidence += 5;
  if (receiverName || maskedAccount) structuredConfidence += 5;
  structuredConfidence = Math.min(structuredConfidence, 100);

  const normalizedVisionConfidence = Math.max(
    0,
    Math.min(100, typeof visionConfidence === "number" ? visionConfidence : structuredConfidence)
  );

  const finalConfidence = Math.round(
    normalizedVisionConfidence * 0.4 + structuredConfidence * 0.6
  );

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
    confidence: finalConfidence,
    visionConfidence: normalizedVisionConfidence,
    structuredConfidence,
    finalConfidence,
    rawText: ocrText,
  };
}

// ─── Fingerprint generation ───────────────────────────────────────────────────
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

// ─── Verification function ────────────────────────────────────────────────────
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>,
  existingFingerprints: Set<string> = new Set(),
  minConfidence: number = 85,
  maxTimeWindowMinutes: number = 120
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

  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    breakdown.failureReason = "No amount detected in slip";
    return result;
  }

  if (Math.abs(extracted.amount - context.orderTotal) > 0.01) {
    result.reviewReason = "AMOUNT_MISMATCH";
    breakdown.failureReason = `Amount mismatch: slip=${extracted.amount}, order=${context.orderTotal}`;
    return result;
  }
  breakdown.amountMatched = true;

  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    breakdown.failureReason = "No transaction date detected in slip";
    return result;
  }
  breakdown.datePresent = true;

  // Use transactionDateTime if available, otherwise transactionDate
  const transactionTime = (extracted.transactionDateTime ?? extracted.transactionDate)!.getTime();
  const verificationTime = (context.slipSubmittedAt ?? context.paymentCreatedAt).getTime();
  const timeDiffMs = verificationTime - transactionTime;
  const clockSkewMs = 5 * 60 * 1000;

  const safeMaxWindowMinutes = Number.isFinite(maxTimeWindowMinutes)
    ? Math.max(5, maxTimeWindowMinutes)
    : 120;

  let maxAgeMs: number;
  if (extracted.transactionDateTime) {
    maxAgeMs = safeMaxWindowMinutes * 60 * 1000;
  } else {
    maxAgeMs = Math.max(safeMaxWindowMinutes, 24 * 60) * 60 * 1000;
  }

  if (timeDiffMs > maxAgeMs || timeDiffMs < -clockSkewMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    breakdown.failureReason = `Transaction outside time window: ${timeDiffMs}ms (max: ${maxAgeMs}ms)`;
    return result;
  }
  breakdown.dateWithinWindow = true;

  if (!extracted.reference) {
    result.reviewReason = "MISSING_REFERENCE";
    breakdown.failureReason = "No reference number detected in slip";
    return result;
  }
  breakdown.referencePresent = true;

  if (existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    breakdown.duplicateReference = true;
    breakdown.failureReason = "Reference already used in another payment";
    return result;
  }

  if (existingFingerprints.has(fingerprint)) {
    result.reviewReason = "DUPLICATE_FINGERPRINT";
    breakdown.duplicateFingerprint = true;
    breakdown.failureReason = "Duplicate payment detected (fingerprint match)";
    return result;
  }

  if (
    extracted.merchantCode &&
    extracted.merchantCode !== MERCHANT_CONFIG.merchantCode
  ) {
    result.reviewReason = "MERCHANT_CODE_MISMATCH";
    breakdown.failureReason = `Merchant code mismatch: ${extracted.merchantCode}`;
    return result;
  }

  if (
    extracted.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    result.reviewReason = "MERCHANT_TRANSACTION_CODE_MISMATCH";
    breakdown.failureReason = `Transaction code mismatch: ${extracted.merchantTransactionCode}`;
    return result;
  }

  // ===== OPTIONAL MERCHANT CHECKS ============================================

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

  if ((extracted.confidence ?? 0) < minConfidence) {
    result.reviewReason = "LOW_CONFIDENCE";
    breakdown.failureReason = `OCR confidence too low: ${extracted.confidence}% (minimum: ${minConfidence}%)`;
    return result;
  }

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

// ─── Improved OCR confidence extraction ────────────────────────────────────────
export function extractOcrConfidence(text: string): number {
  // Try multiple confidence formats
  const patterns = [
    /\*\*OCR\s*Confidence\s*Score\s*:\s*\*\*(\d+)\/100/i,
    /OCR\s*Confidence\s*Score\s*:\s*(\d+)\s*\/\s*100/i,
    /OCR\s*Confidence\s*Score\s*:\s*(\d+)/i,
    /"ocr_confidence"\s*:\s*(\d+)/i,
    /ocr_confidence\s*[:=]\s*(\d+)/i,
    /"OCR_Confidence_Score"\s*:\s*(\d+)/i,
    /OCR_Confidence_Score\s*[:=]\s*(\d+)/i,
    /confidence\s*[:=]\s*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const parsed = parseInt(match[1]);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        return parsed;
      }
    }
  }

  return 0; // No confidence found
}

// ─── LLM-based slip image parsing ──────────────────────────────────────────────
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

    // Extract OCR confidence using improved parser
    let ocrConfidence = extractOcrConfidence(content);
    if (ocrConfidence === 0) {
      ocrConfidence = 85; // Default reasonable confidence
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
