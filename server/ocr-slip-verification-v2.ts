import { invokeLLM } from "./_core/llm";
import crypto from "crypto";

/**
 * OCR Slip Verification System — Production Hardened
 *
 * Fixes applied:
 * - Fenced JSON parsing with trailing text support
 * - SCB JSON extraction (amount, reference, merchant codes, time)
 * - KBank nested/Thai extraction (nested fields, Thai labels, amounts)
 * - Thai Buddhist year parsing (69 → 2026, not 2069)
 * - Timezone handling (Asia/Bangkok to UTC conversion)
 * - Verification datetime comparison (transactionDateTime > transactionDate)
 * - Confidence parsing (multiple formats)
 * - Pending review response with clear ocrDecision
 * - Safety behavior (OCR errors don't crash, fallback to manual review)
 * - Strict duplicate detection
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
  receiverAccountOrId?: string; // KBank receiver account or biller ID
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
  technicalError?: boolean; // true if OCR/LLM technical error occurred
}

// ─── Fenced JSON parsing with trailing text support ────────────────────────────
/**
 * Extract JSON from rawText that may be:
 * - Fenced with ```json ... ```
 * - Followed by additional text like "**OCR Confidence Score:** 98/100"
 * - Plain JSON without fences
 */
function extractJsonFromText(rawText: string): { json: any; confidence: number } | null {
  if (!rawText || rawText.trim().length === 0) {
    return null;
  }

  let text = rawText.trim();

  // Try to extract fenced JSON
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const jsonStr = fenceMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      // Extract confidence from text after fence
      const confidence = extractOcrConfidence(text);
      return { json: parsed, confidence };
    } catch {
      // Fall through to other methods
    }
  }

  // Try to extract balanced JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const confidence = extractOcrConfidence(text);
      return { json: parsed, confidence };
    } catch {
      // Fall through
    }
  }

  return null;
}

// ─── Field extraction helpers ─────────────────────────────────────────────────
function normalizeThaiNumerals(text: string): string {
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
      Object.assign(result, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      result[newKey] = value;
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

function getFieldBySuffixMatch(flattened: Record<string, any>, suffixes: string[]): any {
  for (const suffix of suffixes) {
    for (const key in flattened) {
      if (key.endsWith(suffix) || key === suffix) {
        return flattened[key];
      }
    }
  }
  return undefined;
}

function extractOcrConfidence(text: string): number {
  const patterns = [
    /\*\*OCR\s*Confidence\s*Score\s*:\s*\*\*\s*(\d+)\/100/i,
    /\*\*OCR\s*Confidence\s*Score\s*:\s*\*\*\s*(\d+)/i,
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

  return 0;
}

function extractAmount(flattened: Record<string, any>, text: string): number | undefined {
  // Try flattened fields first
  let amountVal = getFieldBySuffixMatch(flattened, [
    "amount",
    "จำนวนเงิน",
    "จำนวน",
    "ยอดเงิน",
    "ยอดโอน",
  ]);

  if (amountVal) {
    // Handle nested objects with 'value' field
    if (typeof amountVal === "object" && amountVal !== null && "value" in amountVal) {
      amountVal = amountVal.value;
    }
    const amountStr = String(amountVal);
    const numStr = amountStr.replace(/[^\d.]/g, "");
    const num = parseFloat(numStr);
    if (!isNaN(num) && num > 0) return num;
  }

  // Fallback to regex patterns
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

function extractReference(flattened: Record<string, any>, text: string): string | undefined {
  let refVal = getFieldBySuffixMatch(flattened, [
    "transaction_id_or_reference_number.value",
    "transaction_id_or_reference_number",
    "reference",
    "reference_number",
    "เลขที่รายการ",
    "รหัสรายการ",
    "รหัสอ้างอิง",
    "หมายเลขอ้างอิง",
    "transaction_id",
  ]);

  if (refVal) {
    // Handle nested objects with 'value' field
    if (typeof refVal === "object" && refVal !== null && "value" in refVal) {
      refVal = refVal.value;
    }
    const val = String(refVal).trim().toUpperCase();
    if (val.length >= 4) return val;
  }

  // Fallback to regex
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

function extractShopName(flattened: Record<string, any>, text: string): string | undefined {
  let shopVal = getFieldBySuffixMatch(flattened, [
    "receiver_shop_name",
    "ชื่อร้านค้า_หรือ_ชื่อผู้รับ",
    "ชื่อร้านค้า",
    "receiver_name",
    "ผู้รับ",
    "shopName",
    "receiverName",
  ]);

  if (shopVal) {
    // Handle nested objects with 'value' field
    if (typeof shopVal === "object" && shopVal !== null && "value" in shopVal) {
      shopVal = shopVal.value;
    }
    const val = String(shopVal).trim().replace(/\s+/g, " ").substring(0, 100);
    if (val.length > 2) return val;
  }

  // Fallback to regex
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

function extractMaskedAccount(flattened: Record<string, any>, text: string): string | undefined {
  let accountVal = getFieldBySuffixMatch(flattened, [
    "sender_account_number_masked",
    "sender_account_number",
    "เลขที่บัญชี_masked",
    "เลขที่บัญชีผู้ส่ง",
    "maskedAccount",
  ]);

  if (accountVal) {
    const val = String(accountVal).trim().substring(0, 30);
    if (val.length > 4) return val;
  }

  // Fallback to regex
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

function extractMerchantCode(flattened: Record<string, any>, text: string): string | undefined {
  let codeVal = getFieldBySuffixMatch(flattened, [
    "merchant_code",
    "รหัสร้านค้า",
    "merchantCode",
  ]);

  if (codeVal) {
    return String(codeVal).trim();
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

function extractMerchantTransactionCode(flattened: Record<string, any>, text: string): string | undefined {
  let txnCodeVal = getFieldBySuffixMatch(flattened, [
    "transaction_code",
    "รหัสธุรกรรม",
    "merchantTransactionCode",
  ]);

  if (txnCodeVal) {
    return String(txnCodeVal).trim();
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

function extractBillerId(flattened: Record<string, any>, text: string): string | undefined {
  let receiverAccountOrIdVal = getFieldBySuffixMatch(flattened, [
    "biller_id",
    "receiverAccountOrId",
    "รหัสบิลเลอร์",
    "Biller ID",
  ]);

  if (receiverAccountOrIdVal) {
    return String(receiverAccountOrIdVal).trim();
  }

  const patterns = [
    /รหัสบิลเลอร์\s*[:：]\s*([0-9]+)/i,
    /biller\s*id\s*[:：]\s*([0-9]+)/i,
    /biller_id\s*[:：]\s*([0-9]+)/i,
    /([0-9]{12,15})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return undefined;
}

function detectBank(flattened: Record<string, any>, text: string): { code?: string; name?: string } {
  let bankVal = getFieldBySuffixMatch(flattened, [
    "bank_name",
    "sender_bank",
    "ธนาคาร",
    "detectedBank",
  ]);

  if (bankVal) {
    const bankStr = String(bankVal).toLowerCase();
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

// ─── Thai Buddhist year parsing with candidate-based resolution ────────────────
function extractTransactionDate(flattened: Record<string, any>, text: string): { date?: Date; dateTime?: Date } | undefined {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Bangkok timezone offset: UTC+7
  const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

  function buildDate(day: number, month: number, year: number, hour?: number, minute?: number, second?: number): { date?: Date; dateTime?: Date } | undefined {
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

        // Create candidates
        const adDate = new Date(Date.UTC(adYear, month - 1, day));
        const buddhDate = new Date(Date.UTC(buddhYear, month - 1, day));

        // Choose the one within the allowed window
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

      // Create date in Bangkok timezone, then convert to UTC
      if (hour !== undefined && minute !== undefined) {
        // Create UTC date at Bangkok time, then adjust
        const bangkokDate = new Date(Date.UTC(y, month - 1, day, hour, minute, second ?? 0));
        // Subtract Bangkok offset to get UTC equivalent
        const utcDate = new Date(bangkokDate.getTime() - BANGKOK_OFFSET_MS);
        const dateOnly = new Date(Date.UTC(y, month - 1, day));

        if (utcDate > now || utcDate < ninetyDaysAgo) return undefined;
        return { date: dateOnly, dateTime: utcDate };
      } else {
        const d = new Date(Date.UTC(y, month - 1, day));
        if (d > now || d < ninetyDaysAgo) return undefined;
        return { date: d };
      }
    } catch {
      return undefined;
    }
  }

  // Check flattened fields first
  const dateTimeVal = getFieldBySuffixMatch(flattened, [
    "date_time",
    "วันที่_เวลา",
    "date",
    "วันที่",
    "datetime",
  ]);

  if (dateTimeVal) {
    const dateStr = String(dateTimeVal);
    // Try to parse it
    const monthNames = Object.keys(THAI_MONTHS).join("|");

    // Pattern: "23 พ.ค. 69 22:48 น."
    {
      const re = new RegExp(
        `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*น\\.?`,
        "i"
      );
      const m = dateStr.match(re);
      if (m) {
        const month = THAI_MONTHS[m[2]];
        if (month) {
          const r = buildDate(
            parseInt(m[1]),
            month,
            parseInt(m[3]),
            parseInt(m[4]),
            parseInt(m[5]),
            m[6] !== undefined ? parseInt(m[6]) : undefined
          );
          if (r) return r;
        }
      }
    }

    // Pattern: "23 พ.ค. 69 22:48"
    {
      const re = new RegExp(
        `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?`,
        "i"
      );
      const m = dateStr.match(re);
      if (m) {
        const month = THAI_MONTHS[m[2]];
        if (month) {
          const r = buildDate(
            parseInt(m[1]),
            month,
            parseInt(m[3]),
            parseInt(m[4]),
            parseInt(m[5]),
            m[6] !== undefined ? parseInt(m[6]) : undefined
          );
          if (r) return r;
        }
      }
    }
  }

  // ── SCB separate date + time fields (JSON) ────────────────────────────────────────
  // SCB JSON has: date = "23 พ.ค. 2569", time = "23:01"
  const dateVal = getFieldBySuffixMatch(flattened, ["date"]);
  const timeVal = getFieldBySuffixMatch(flattened, ["time"]);

  if (dateVal && timeVal) {
    const dateStr = String(dateVal);
    const timeStr = String(timeVal);
    const monthNames = Object.keys(THAI_MONTHS).join("|");

    // Parse date: "23 พ.ค. 2569" or "23 พ.ค. 69" (FIXED: properly escape regex)
    const dateRe = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})`, "i");
    const dateMatch = dateStr.match(dateRe);

    // Parse time: "23:01" or "17:29"
    const timeRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
    const timeMatch = timeStr.match(timeRe);

    if (dateMatch && timeMatch) {
      const month = THAI_MONTHS[dateMatch[2]];
      if (month) {
        const r = buildDate(
          parseInt(dateMatch[1]),
          month,
          parseInt(dateMatch[3]),
          parseInt(timeMatch[1]),
          parseInt(timeMatch[2]),
          timeMatch[3] !== undefined ? parseInt(timeMatch[3]) : undefined
        );
        if (r) return r;
      }
    }
  }

  // ── SCB separate date + time fields (plain text) ────────────────────────────────────────
  // SCB plain text has: วันที่: 23 พ.ค. 2569, เวลา: 17:29
  // Extract from raw text before JSON parsing
  {
    const monthNames = Object.keys(THAI_MONTHS).join("|");
    // Match Thai date pattern: "23 พ.ค. 2569" or "23 พ.ค. 69"
    const dateRe = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})`, "i");
    const dateMatch = text.match(dateRe);
    
    if (dateMatch) {
      // Look for separate time pattern: "HH:MM" or "HH:MM:SS"
      const timeRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
      const timeMatch = text.match(timeRe);
      
      if (timeMatch) {
        const month = THAI_MONTHS[dateMatch[2]];
        if (month) {
          const r = buildDate(
            parseInt(dateMatch[1]),
            month,
            parseInt(dateMatch[3]),
            parseInt(timeMatch[1]),
            parseInt(timeMatch[2]),
            timeMatch[3] !== undefined ? parseInt(timeMatch[3]) : undefined
          );
          if (r) return r;
        }
      }
    }
  }

  // Pattern: "23 พ.ค. 2569" or "23 พ.ค. 69" (date only, no time)
  // Only use this if no time was found in plain text fallback above
  {
    const monthNames = Object.keys(THAI_MONTHS).join("|");
    const re = new RegExp(
      `(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})`,
      "i"
    );
    const m = text.match(re);
    if (m) {
      const month = THAI_MONTHS[m[2]];
      if (month) {
        const r = buildDate(parseInt(m[1]), month, parseInt(m[3]));
        if (r) return r;
      }
    }
  }

  // Pattern: "23/05/2026" with optional time
  {
    const re = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/;
    const m = text.match(re);
    if (m) {
      const r = buildDate(
        parseInt(m[1]),
        parseInt(m[2]),
        parseInt(m[3]),
        m[4] !== undefined ? parseInt(m[4]) : undefined,
        m[5] !== undefined ? parseInt(m[5]) : undefined
      );
      if (r) return r;
    }
  }

  // Pattern: "2026-05-23"
  {
    const re = /(\d{4})-(\d{2})-(\d{2})/;
    const m = text.match(re);
    if (m) {
      const r = buildDate(parseInt(m[3]), parseInt(m[2]), parseInt(m[1]));
      if (r) return r;
    }
  }

  return {};
}

// ─── Main extraction function ────────────────────────────────────────────────────
export function extractSlipData(ocrText: string, visionConfidence?: number): ExtractedSlipData {
  if (!ocrText || ocrText.trim().length === 0) {
    return {
      confidence: 0,
      visionConfidence: typeof visionConfidence === "number" ? visionConfidence : 0,
      structuredConfidence: 0,
      finalConfidence: 0,
    };
  }

  // Extract JSON and confidence from fenced text
  const jsonResult = extractJsonFromText(ocrText);
  const flattened = jsonResult ? flattenObject(jsonResult.json) : {};
  const extractedConfidence = jsonResult?.confidence ?? extractOcrConfidence(ocrText);

  const text = normalizeThaiNumerals(ocrText);

  const amount = extractAmount(flattened, text);
  const transactionDateResult = extractTransactionDate(flattened, text);
  const { date: transactionDate, dateTime: transactionDateTime } = transactionDateResult || {};
  const reference = extractReference(flattened, text);
  const shopName = extractShopName(flattened, text);
  const maskedAccount = extractMaskedAccount(flattened, text);
  const merchantCode = extractMerchantCode(flattened, text);
  const merchantTransactionCode = extractMerchantTransactionCode(flattened, text);
  const receiverAccountOrId = extractBillerId(flattened, text);
  const { code: detectedBank, name: detectedBankName } = detectBank(flattened, text);

  // ─── Confidence scoring ─────────────────────────────────────────────────
  let structuredConfidence = 0;
  if (amount) structuredConfidence += 25;
  if (transactionDate || transactionDateTime) structuredConfidence += 20;
  if (reference) structuredConfidence += 20;
  if (detectedBank) structuredConfidence += 10;
  if (shopName) structuredConfidence += 10;
  if (merchantCode) structuredConfidence += 10;
  if (merchantTransactionCode) structuredConfidence += 5;
  if (transactionDateTime) structuredConfidence += 5;
  if (maskedAccount) structuredConfidence += 5;
  structuredConfidence = Math.min(structuredConfidence, 100);

  const normalizedVisionConfidence = Math.max(
    0,
    Math.min(100, typeof visionConfidence === "number" ? visionConfidence : extractedConfidence)
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
    receiverAccountOrId,
    shopName,
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

// ─── LLM-based slip image parsing ──────────────────────────────────────────────
export async function parseSlipImage(imageUrl: string): Promise<ParseSlipImageResult> {
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
      technicalError: true, // Flag OCR/LLM technical failure
    };
  }
}
