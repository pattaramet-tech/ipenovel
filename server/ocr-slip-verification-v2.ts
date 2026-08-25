import { invokeLLM, LLMInvokeError, type InvokeParams, type InvokeResult } from "./_core/llm";
import crypto from "crypto";
import { formatMoney } from "./helpers/moneyNormalizer";
import {
  buildSemanticFingerprint,
  hashSlipReference,
  normalizeOcrTextForParsing,
  normalizeSlipReference,
} from "./services/slipIdentifierService";
import {
  describeProviderFailure,
  type ProviderDiagnostic,
} from "./services/ocrDiagnosticsService";
import {
  effectiveFreshnessWindowMinutes,
  isWithinFreshnessWindow,
} from "@shared/slipFreshness";

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
  /** Bill-payment slips (SCB/KTB) print this instead of a merchant code. */
  billerId: "010753600031501",
};

export type RecipientEvidenceType =
  | "merchant_transaction_code"
  | "merchant_code"
  | "biller_id"
  | "shop_alias"
  | "receiver_name"
  | "insufficient";

export type RecipientEvidenceStrength = "strong" | "fallback" | "none";

export interface RecipientVerificationResult {
  recipientVerified: boolean;
  recipientEvidenceType: RecipientEvidenceType;
  recipientEvidenceStrength: RecipientEvidenceStrength;
}

/**
 * SERVER-SIDE recipient verification - the authority for whether the money
 * actually reached IpeNovel.
 *
 * This deliberately lives beside verifySlipData rather than in the admin
 * panel: the panel is a renderer, and a financial gate implemented only in
 * client constants would let auto-approval proceed without ever proving the
 * recipient. The UI now renders THIS result.
 *
 * Evidence is GRADED rather than requiring one identical field from every
 * bank, because Thai banks genuinely print different things - a KBank
 * transfer slip carries a receiver name and no merchant code, while an
 * SCB/KTB bill-payment slip carries merchant/biller codes. Demanding a
 * merchant code from every bank would reject legitimate transfers.
 *
 *   strong   - an exact match on merchantTransactionCode, merchantCode or
 *              billerId. Unambiguous: these identify our merchant account.
 *   fallback - an approved shop/receiver alias ("Ipe Novel"/"Ipenovel").
 *              Documented, weaker, and sufficient only because plain
 *              transfer slips expose nothing stronger.
 *   none     - insufficient evidence -> RECIPIENT_NOT_VERIFIED -> review.
 *
 * Never rejects. Insufficient evidence routes to a human.
 */
export function verifyRecipient(extracted: ExtractedSlipData): RecipientVerificationResult {
  if (extracted.merchantTransactionCode === MERCHANT_CONFIG.merchantTransactionCode) {
    return {
      recipientVerified: true,
      recipientEvidenceType: "merchant_transaction_code",
      recipientEvidenceStrength: "strong",
    };
  }

  if (extracted.merchantCode === MERCHANT_CONFIG.merchantCode) {
    return {
      recipientVerified: true,
      recipientEvidenceType: "merchant_code",
      recipientEvidenceStrength: "strong",
    };
  }

  if (extracted.receiverAccountOrId === MERCHANT_CONFIG.billerId) {
    return {
      recipientVerified: true,
      recipientEvidenceType: "biller_id",
      recipientEvidenceStrength: "strong",
    };
  }

  // ── FIELD-BOUND, EXACT RECIPIENT IDENTITY ─────────────────────────────
  // EXACT match against an explicit allowlist, never a substring.
  //
  // `includes(alias)` made this gate satisfiable by any value that merely
  // CONTAINED an approved name: "Ipe Novel Fake", "Fake Ipe Novel" and
  // "Ipe Novel Shop 2" all verified as the shop. Recipient verification
  // participates in AUTO_APPROVE, so that was a financial authority bug -
  // a transfer to a different recipient could fund an order.
  //
  // Normalization is limited to what OCR genuinely perturbs: Unicode form,
  // surrounding whitespace, internal whitespace runs, and Latin case. It must
  // never discard a prefix or a suffix, because that is precisely how an
  // impostor value would be reshaped into an approved one.
  const normalize = (value?: string) =>
    (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

  const allowedIdentities = new Set(
    MERCHANT_CONFIG.shopNameAliases.map(normalize).filter(Boolean)
  );

  const shopName = normalize(extracted.shopName);
  if (shopName && allowedIdentities.has(shopName)) {
    return {
      recipientVerified: true,
      recipientEvidenceType: "shop_alias",
      recipientEvidenceStrength: "fallback",
    };
  }

  const receiverName = normalize(extracted.receiverName);
  if (receiverName && allowedIdentities.has(receiverName)) {
    return {
      recipientVerified: true,
      recipientEvidenceType: "receiver_name",
      recipientEvidenceStrength: "fallback",
    };
  }

  // A bare mention of the shop somewhere in the OCR text is NOT recipient
  // evidence - it can come from a note, a memo, the sender field, or a
  // footer. It is carried for display only (see recipientRawTextMention) and
  // deliberately cannot reach this point as verification.
  return {
    recipientVerified: false,
    recipientEvidenceType: "insufficient",
    recipientEvidenceStrength: "none",
  };
}

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
  /** Upper-cased reference. Legacy contract - kept for existing rows/tests. */
  reference?: string;
  /** Reference exactly as printed, original casing intact. For admin display. */
  referenceRaw?: string;
  /** Whitespace-stripped, case-preserving reference used for comparison. */
  referenceNormalized?: string;
  /** SHA-256 of referenceNormalized. STRONG anti-replay identifier. */
  referenceHash?: string;
  /** Coarse bank/account/amount/date hash. WEAK risk signal only, never proof. */
  semanticFingerprint?: string;
  /**
   * False when neither the caller nor the model supplied a confidence.
   * Unknown confidence MUST NOT auto-approve - see verifySlipData's
   * UNKNOWN_CONFIDENCE gate.
   */
  confidenceKnown?: boolean;
  detectedBank?: string;
  detectedBankName?: string;
  shopName?: string;
  receiverName?: string;
  maskedAccount?: string;
  merchantCode?: string;
  merchantTransactionCode?: string;
  receiverAccountOrId?: string; // KBank receiver account or biller ID
  /**
   * DIAGNOSTIC ONLY. An approved shop alias appears somewhere in the OCR text
   * without being bound to a recipient field. Never financial evidence - see
   * detectRecipientRawTextMention.
   */
  recipientRawTextMention?: boolean;
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
  /**
   * How much the duplicate signal is actually worth. "weak" must never be
   * presented to an admin as a confirmed duplicate.
   */
  duplicateEvidenceStrength?: "strong" | "weak";
  /** SERVER-side proof the money reached IpeNovel. See verifyRecipient. */
  recipientVerified?: boolean;
  recipientEvidenceType?: RecipientEvidenceType;
  recipientEvidenceStrength?: RecipientEvidenceStrength;
  /** False when no confidence was reported at all (distinct from a low one). */
  confidenceKnown?: boolean;
  /**
   * The allowance actually applied to THIS result - the configured window,
   * or at least a day when only a calendar date could be read. Surfaced so
   * the admin panel shows the number the server really judged against.
   */
  effectiveWindowMinutes?: number;
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
  /**
   * False when the provider never reported a confidence. `ocrConfidence` is
   * then 0 as a placeholder ONLY - it must not be read as "0% confident",
   * and it must never satisfy an auto-approval threshold.
   */
  confidenceKnown?: boolean;
  warnings: string[];
  technicalError?: boolean; // true if OCR/LLM technical error occurred
  /** Stable technical failure code (see OcrTechnicalFailureCode). */
  technicalErrorCode?: string;
  /**
   * Sanitized provider metadata for the failure - HTTP status, runtime mode
   * and attempt count only. Present whenever technicalError is true so the
   * caller can record and display WHY, instead of "an OCR error occurred".
   */
  providerDiagnostic?: ProviderDiagnostic;
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
  // Try exact suffix match first
  for (const suffix of suffixes) {
    for (const key in flattened) {
      if (key.endsWith(suffix) || key === suffix) {
        return flattened[key];
      }
    }
  }
  
  // Fallback: Try normalized key matching for multilingual keys
  // Normalize: lowercase, remove spaces, slashes, underscores, parentheses
  const normalizedSuffixes = suffixes.map(s => 
    s.toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[/_()]/g, '')
  );
  
  for (const key in flattened) {
    const normalizedKey = key
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[/_()]/g, '');
    
    // Check if normalized key contains any normalized suffix
    for (const normSuffix of normalizedSuffixes) {
      if (normalizedKey.includes(normSuffix)) {
        return flattened[key];
      }
    }
  }
  
  return undefined;
}

/**
 * Parses a self-reported OCR confidence out of the model's text.
 *
 * Returns `undefined` when NO confidence statement is present. That is a
 * meaningfully different state from "0%" and callers must keep it distinct:
 * an unknown confidence must route to review (UNKNOWN_CONFIDENCE), never be
 * back-filled with an invented number. See parseSlipImage(), which used to
 * substitute a hard-coded 85 here.
 *
 * The label alternation covers every phrasing observed from the provider:
 * "OCR Confidence Score", "Estimated OCR Confidence" and "OCR Confidence
 * Estimation", each in both `99%` and `99/100` forms, with or without
 * markdown emphasis around the label or the value.
 */
export function parseOcrConfidence(text: string): number | undefined {
  if (!text) return undefined;

  // Markdown emphasis is stripped first so a single label alternation covers
  // "**OCR Confidence Score:** 99%" and "OCR Confidence Score: 99%" alike.
  const flat = text.replace(/[*_`]+/g, "");

  const label = String.raw`(?:Estimated\s*OCR\s*Confidence(?:\s*(?:Score|Estimation))?|OCR\s*Confidence\s*(?:Score|Estimation|Level)?|OCR[_\s]*Confidence[_\s]*Score)`;

  const patterns = [
    // "<label>: 99/100" - the /100 form must be tried before the bare form
    // so the denominator is never mistaken for the score.
    new RegExp(String.raw`${label}\s*[:=]?\s*(\d{1,3})\s*/\s*100`, "i"),
    // "<label>: 99%" / "<label>: 99"
    new RegExp(String.raw`${label}\s*[:=]?\s*(\d{1,3})\s*%?`, "i"),
    // JSON-ish shapes emitted inside the fenced block.
    /"?ocr[_\s]*confidence(?:[_\s]*score)?"?\s*[:=]\s*"?(\d{1,3})\s*\/\s*100"?/i,
    /"?ocr[_\s]*confidence(?:[_\s]*score)?"?\s*[:=]\s*"?(\d{1,3})"?/i,
    /"?confidence"?\s*[:=]\s*"?(\d{1,3})\s*\/\s*100"?/i,
    /"?confidence"?\s*[:=]\s*"?(\d{1,3})\s*%/i,
    /"?confidence"?\s*[:=]\s*"?(\d{1,3})"?/i,
  ];

  for (const pattern of patterns) {
    const match = flat.match(pattern);
    if (match?.[1]) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        return parsed;
      }
    }
  }

  return undefined;
}

/**
 * Backward-compatible wrapper: existing callers that need a plain number
 * still get 0 for "not stated". New code should prefer parseOcrConfidence()
 * so it can tell "unknown" apart from a genuine zero.
 */
function extractOcrConfidence(text: string): number {
  return parseOcrConfidence(text) ?? 0;
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
    // Amount labels with colon/colon-like separator
    /จำนวนเงิน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดเงิน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดโอน\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /amount\s*[:：]\s*฿?\s*([\d,]+(?:\.\d{2})?)/i,
    // Amount labels followed by newline (SCB pattern) - flexible whitespace
    /จำนวนเงิน[\s\n]+฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดเงิน[\s\n]+฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /ยอดโอน[\s\n]+฿?\s*([\d,]+(?:\.\d{2})?)/i,
    /amount[\s\n]+฿?\s*([\d,]+(?:\.\d{2})?)/i,
    // BAY/Krungsri table layout: จำนวนเงิน\nค่าธรรมเนียม\n96.00 THB\n0.00 THB
    // Capture first positive THB amount after fee label
    /จำนวนเงิน[\s\n]+ค่าธรรมเนียม[\s\n]+([\d,]+(?:\.\d{2})?)\s*(?:THB|บาท)/i,
    /amount[\s\n]+fee[\s\n]+([\d,]+(?:\.\d{2})?)\s*(?:THB|บาท)/i,
    // Currency symbols
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

/**
 * Thai/English labels that introduce a real BANK TRANSACTION REFERENCE.
 *
 * `เลขที่รายการ` / `เลขรายการ` are included because KBank prints the
 * transaction reference under exactly that label (e.g.
 * `เลขที่รายการ: 016234222922AQR05745`). Their absence here is what produced
 * a false MISSING_REFERENCE on otherwise perfectly readable KBank slips.
 *
 * Deliberately EXCLUDES receiver-account/biller labels. A KBank bill-payment
 * slip also carries a receiver id such as `202608223588503`, and silently
 * promoting that to "the transaction reference" would give two different
 * transfers to the same merchant the same identifier - the exact false-match
 * class the strong/weak split exists to prevent. Receiver ids are captured
 * separately by extractBillerId().
 */
const REFERENCE_LABEL_PATTERN = String.raw`(?:เลขที่รายการ|เลขรายการ|เลขที่อ้างอิง|เลขอ้างอิง|รหัสอ้างอิง|หมายเลขอ้างอิง|รหัสรายการ|Transaction\s*(?:ID|Reference|No\.?|Number)|Reference\s*(?:No\.?|Number|Code|#)?|Ref\.?(?:\s*No\.?)?|Txn\s*(?:ID|Code|No\.?)?)`;

/**
 * Reference token charset.
 *
 * Case-SENSITIVE on purpose: SCB emits mixed-case references such as
 * `202608225ApOyxElgdOo7YVwv`, so the raw casing must survive extraction to
 * be shown to an admin and to be normalized/hashed without collisions. The
 * legacy `.toUpperCase()` applied here is preserved for the returned
 * `reference` field only (see extractSlipData, which also records the
 * untouched raw value).
 */
const REFERENCE_TOKEN = String.raw`([A-Za-z0-9][A-Za-z0-9\-/]{3,63})`;

/**
 * Extracts the RAW transaction reference exactly as printed - original
 * casing preserved, no upper-casing. Callers decide how to normalize.
 */
export function extractReferenceRaw(
  flattened: Record<string, any>,
  text: string
): string | undefined {
  let refVal = getFieldBySuffixMatch(flattened, [
    "transaction_id_or_reference_number.value",
    "transaction_id_or_reference_number",
    "reference",
    "reference_number",
    "เลขที่รายการ",
    "เลขรายการ",
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
    const val = String(refVal).trim();
    if (val.length >= 4) return val;
  }

  // Regex fallback over the raw text. Two passes: an explicit separator
  // (`:` / `：` / `-` / `=`) first, then the "label on one line, value on the
  // next" layout, so a labelled value is always preferred over a positional
  // guess.
  const patterns = [
    new RegExp(
      String.raw`${REFERENCE_LABEL_PATTERN}\s*[:：=-]\s*${REFERENCE_TOKEN}`,
      "i"
    ),
    new RegExp(String.raw`${REFERENCE_LABEL_PATTERN}[ \t]*\n[ \t]*${REFERENCE_TOKEN}`, "i"),
    new RegExp(String.raw`${REFERENCE_LABEL_PATTERN}\s+${REFERENCE_TOKEN}`, "i"),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim().replace(/[.,;]+$/, "");
      if (extracted.length >= 4) return extracted;
    }
  }

  return undefined;
}

function extractReference(flattened: Record<string, any>, text: string): string | undefined {
  const raw = extractReferenceRaw(flattened, text);
  // Legacy contract: the `reference` field has always been upper-cased, and
  // historical rows/tests depend on that. The untouched value is surfaced
  // separately as `referenceRaw`.
  return raw ? raw.toUpperCase() : undefined;
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

  // NO WHOLE-TEXT FALLBACK.
  //
  // This function previously scanned the ENTIRE OCR text for an approved
  // alias and, on a hit, returned the canonical "Ipe Novel" - synthesizing a
  // recipient identity from text that may have been a note, a memo, the
  // SENDER field, or an unrelated footer. verifyRecipient then matched that
  // synthesized value exactly and marked the recipient verified, so a
  // transfer to someone else could satisfy a financial gate and auto-approve.
  //
  // A shop name is only recipient evidence when it came from a recipient
  // field. Raw-text mentions are surfaced separately by
  // detectRecipientRawTextMention() for display, and carry no authority.
  return undefined;
}

/**
 * DIAGNOSTIC ONLY - never financial evidence.
 *
 * True when an approved shop alias appears anywhere in the OCR text without
 * being bound to a recipient field. Useful to an admin ("the shop is
 * mentioned, but not as the recipient"), and deliberately incapable of
 * setting recipientVerified or making a slip auto-approvable.
 */
export function detectRecipientRawTextMention(text: string): boolean {
  const haystack = (text ?? "").normalize("NFKC").toLowerCase();
  return MERCHANT_CONFIG.shopNameAliases.some((alias) =>
    haystack.includes(alias.normalize("NFKC").toLowerCase())
  );
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

  // LABEL-BOUND ONLY. This used to end with an unanchored whole-text
  // fallback (`/([A-Z]{2}\d{12})/`, later bounded to `/(?<![A-Z0-9])([A-Z]{2}\d{12})(?![A-Z0-9])/`
  // to stop it matching a substring out of a longer garbage token). Bounding
  // fixed WHICH substring gets read, but not WHERE it may come from: an
  // exact, correctly-formatted merchant code is STRONG recipient evidence
  // (sufficient for auto-approval), so a value merely appearing somewhere in
  // the OCR text - a memo, a sender field, unrelated footer text - must not
  // be accepted as proof the money reached this merchant. Removed
  // entirely (empirically verified against every real KBank/SCB/Krungthai
  // fixture in this repo with zero regressions): a merchant code is only
  // ever read from an explicit field/label.
  const patterns = [
    /รหัสร้านค้า\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /merchant\s*id\s*[:：]\s*([A-Z0-9]+)/i,
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

  // Support KTB split transaction code pattern:
  // รหัสธุรกรรม
  // KPS004KB00000228
  // 3068
  // → KPS004KB000002283068
  const ktbSplitPattern = /รหัสธุรกรรม[\s\n]+([A-Z0-9]+)[\s\n]+([0-9]+)/i;
  const ktbMatch = text.match(ktbSplitPattern);
  if (ktbMatch?.[1] && ktbMatch?.[2]) {
    const combined = ktbMatch[1] + ktbMatch[2];
    if (combined.length >= 10) return combined;
  }

  // LABEL-BOUND ONLY - see extractMerchantCode's identical reasoning above.
  // The removed unlabeled fallback (`/([A-Z]{3}\d{3}[A-Z]{2}\d{12})/`) is a
  // very specific 20-character shape, but specificity of FORMAT is not the
  // same as trustworthiness of ORIGIN: nothing stopped that exact string
  // from being read out of a memo or unrelated text rather than the
  // transaction-code field. Empirically verified against every real
  // KBank/SCB/Krungthai fixture in this repo with zero regressions.
  const patterns = [
    /รหัสธุรกรรม\s*[:：]\s*([A-Z0-9]+)/i,
    /transaction\s*code\s*[:：]\s*([A-Z0-9]+)/i,
    /ref\s*code\s*[:：]\s*([A-Z0-9]+)/i,
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

  // LABEL-BOUND ONLY. This used to end with `/([0-9]{12,15})/` - ANY
  // 12-15 digit run anywhere in the OCR text, unlabeled. Because an exact
  // Biller ID match is STRONG recipient evidence (sufficient for
  // auto-approval on its own), evidence ORIGIN matters as much as evidence
  // VALUE: a transfer to a DIFFERENT recipient could auto-approve merely
  // because our biller ID digits happened to appear in a memo, a sender
  // field, or unrelated footer text - the same class of bug already fixed
  // for the shop-name alias (whole-text synthesis) and the merchant code
  // (now also label-bound, above). `บิลเลอร์ ID` (Thai "บิลเลอร์" + Latin
  // "ID") is a real SCB label variant neither of the two patterns below
  // recognized on its own - added rather than left to fall through to the
  // removed unlabeled scan, which is what silently covered it before.
  const patterns = [
    /รหัสบิลเลอร์\s*[:：]\s*([0-9]+)/i,
    /บิลเลอร์\s*id\s*[:：]\s*([0-9]+)/i,
    /biller\s*id\s*[:：]\s*([0-9]+)/i,
    /biller_id\s*[:：]\s*([0-9]+)/i,
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
  // Or: 25 พ.ค. 2569 - 00:26 (Thai date - hyphen - time)
  // Extract from raw text before JSON parsing
  {
    const monthNames = Object.keys(THAI_MONTHS).join("|");
    
    // Pattern: "25 พ.ค. 2569 - 00:26" or "25 พ.ค. 2569 – 00:26" or "25 พ.ค. 2569 เวลา 00:26"
    {
      const re = new RegExp(`(\\d{1,2})\\s+(${monthNames})\\s+(\\d{2,4})\\s+[\\-–]?\\s*(?:เวลา)?\\s*(\\d{1,2}):(\\d{2})(?::(\\d{2}))?`, "i");
      const m = text.match(re);
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
    
    // Fallback: Match Thai date pattern: "23 พ.ค. 2569" or "23 พ.ค. 69"
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
  // `undefined` here means the model never stated a confidence at all. That
  // is preserved (never coerced to a number) so verifySlipData can raise
  // UNKNOWN_CONFIDENCE instead of auto-approving on an invented value.
  const statedConfidence = parseOcrConfidence(ocrText);

  // Markdown emphasis/bullets/headings are stripped BEFORE field parsing.
  // A real SCB slip renders its amount as "**จำนวนเงิน**\n100.00", which the
  // label patterns could not match across the trailing `**` - producing a
  // false MISSING_AMOUNT on a slip whose text was read perfectly. Only
  // formatting markers are removed; digits, separators and reference tokens
  // are untouched (see normalizeOcrTextForParsing).
  const text = normalizeOcrTextForParsing(normalizeThaiNumerals(ocrText));

  const amount = extractAmount(flattened, text);
  const transactionDateResult = extractTransactionDate(flattened, text);
  const { date: transactionDate, dateTime: transactionDateTime } = transactionDateResult || {};
  const reference = extractReference(flattened, text);
  const referenceRaw = extractReferenceRaw(flattened, text);
  const shopName = extractShopName(flattened, text);
  const maskedAccount = extractMaskedAccount(flattened, text);
  const merchantCode = extractMerchantCode(flattened, text);
  const merchantTransactionCode = extractMerchantTransactionCode(flattened, text);
  const receiverAccountOrId = extractBillerId(flattened, text);
  // Presentation only. Deliberately NOT fed into shopName/receiverName, which
  // are the fields verifyRecipient treats as authority.
  const recipientRawTextMention = detectRecipientRawTextMention(text);
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

  // A confidence is "known" only if the caller supplied a real vision score
  // or the model actually stated one. When neither exists the score below is
  // still computed (so the structured signal is visible to an admin), but
  // `confidenceKnown: false` travels with it and blocks auto-approval.
  const effectiveVisionConfidence =
    typeof visionConfidence === "number" ? visionConfidence : statedConfidence;
  const confidenceKnown = typeof effectiveVisionConfidence === "number";

  const normalizedVisionConfidence = Math.max(
    0,
    Math.min(100, effectiveVisionConfidence ?? 0)
  );

  const finalConfidence = Math.round(
    normalizedVisionConfidence * 0.4 + structuredConfidence * 0.6
  );

  return {
    recipientRawTextMention,
    amount,
    transactionDate,
    transactionDateTime,
    reference,
    referenceRaw,
    referenceNormalized: normalizeSlipReference(referenceRaw),
    referenceHash: hashSlipReference(referenceRaw),
    semanticFingerprint: buildSemanticFingerprint({
      detectedBank,
      maskedAccount,
      amount,
      transactionDate,
    }),
    detectedBank,
    detectedBankName,
    receiverAccountOrId,
    shopName,
    maskedAccount,
    merchantCode,
    merchantTransactionCode,
    confidence: finalConfidence,
    confidenceKnown,
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
    const amountStr = extracted.amount !== undefined ? formatMoney(extracted.amount, "amount") : "";
    fingerprintData = [
      extracted.reference,
      amountStr,
      extracted.transactionDate
        ? extracted.transactionDate.toISOString().split("T")[0]
        : "",
    ].join("|");
  } else if (extracted.detectedBank && extracted.maskedAccount) {
    // Fallback: bank + account + amount + date
    const amountStr = extracted.amount !== undefined ? formatMoney(extracted.amount, "amount") : "";
    fingerprintData = [
      extracted.detectedBank,
      extracted.maskedAccount,
      amountStr,
      extracted.transactionDate
        ? extracted.transactionDate.toISOString().split("T")[0]
        : "",
    ].join("|");
  } else {
    // Tertiary: shop + amount + date
    const amountStr = extracted.amount !== undefined ? formatMoney(extracted.amount, "amount") : "";
    fingerprintData = [
      extracted.shopName ?? "",
      amountStr,
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
    confidenceKnown: extracted.confidenceKnown !== false,
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

  // Normalize orderTotal once at the start
  // CRITICAL NOTE (Wallet Top-ups): context.orderTotal is ALWAYS requestedAmount, never creditedAmount.
  // For wallet topups: requestedAmount = actual money paid by user, creditedAmount = amount + bonus (system reward)
  // Example: 250 baht top-up → orderTotal=250, bonus=10, credited=260
  // OCR must match against 250 (actual payment), not 260 (which user never paid)
  let normalizedOrderTotal: number;
  try {
    const orderTotalStr = formatMoney(context.orderTotal, "orderTotal");
    normalizedOrderTotal = Number(orderTotalStr);
  } catch (e) {
    // If normalization fails, send to manual review
    result.reviewReason = "INVALID_PAYMENT_AMOUNT";
    breakdown.failureReason = `Failed to normalize order total: ${String(context.orderTotal)}`;
    return result;
  }

  // ===== CRITICAL CHECKS (HARD FAIL → pending_review) ======================

  if (!extracted.amount) {
    result.reviewReason = "MISSING_AMOUNT";
    breakdown.failureReason = "No amount detected in slip";
    return result;
  }

  // Amount verification: OCR-extracted amount must match orderTotal (requested payment amount)
  // For order payments: orderTotal = order.totalAmount
  // For wallet topups: orderTotal = requestedAmount (not creditedAmount which includes bonus)
  if (Math.abs(extracted.amount - normalizedOrderTotal) > 0.01) {
    result.reviewReason = "AMOUNT_MISMATCH";
    breakdown.failureReason = `Amount mismatch: slip=${extracted.amount}, expected=${normalizedOrderTotal}`;
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
  const timeDiffMinutes = timeDiffMs / 60000;

  // The allowance now comes from the SHARED rule in shared/slipFreshness.ts,
  // which the admin panel imports too. Previously this date-only floor lived
  // only here, so the panel judged a date-only slip against the configured
  // window and displayed FAIL for slips the server had accepted.
  const effectiveWindowMinutes = effectiveFreshnessWindowMinutes(
    maxTimeWindowMinutes,
    Boolean(extracted.transactionDateTime)
  );
  breakdown.effectiveWindowMinutes = effectiveWindowMinutes;

  if (!isWithinFreshnessWindow(timeDiffMinutes, effectiveWindowMinutes)) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    breakdown.failureReason = `Transaction outside time window: ${Math.round(timeDiffMinutes)} min (allowed: ${effectiveWindowMinutes} min)`;
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
    breakdown.duplicateEvidenceStrength = "strong";
    breakdown.failureReason = "Reference already used in another payment";
    return result;
  }

  // WEAK evidence only.
  //
  // This fingerprint's fallback branch hashes bank|account|amount|date, so a
  // customer legitimately transferring 100 THB twice from one account on one
  // day collides with themselves. It is therefore recorded as a RISK SIGNAL
  // that routes to human review - never reported as a confirmed duplicate,
  // and never used to block financial value on its own. Strong proof comes
  // only from referenceHash / fileHash / qrPayloadHash via the claim
  // registry (see slipClaimService).
  if (existingFingerprints.has(fingerprint)) {
    result.reviewReason = "WEAK_DUPLICATE_RISK";
    breakdown.duplicateFingerprint = true;
    breakdown.duplicateEvidenceStrength = "weak";
    breakdown.failureReason =
      "Possible duplicate only - same bank, account, amount and date as an earlier " +
      "submission. NOT proof of a duplicate transaction; needs human review.";
    return result;
  }

  // ===== RECIPIENT GATE =====================================================

  // Proves the money actually reached IpeNovel before any auto-approval.
  // Previously nothing on the server checked this: a slip could match on
  // amount, date and reference while having been paid to someone else
  // entirely, and only the admin panel described the recipient - too late
  // to stop auto-approval.
  const recipient = verifyRecipient(extracted);
  breakdown.recipientVerified = recipient.recipientVerified;
  breakdown.recipientEvidenceType = recipient.recipientEvidenceType;
  breakdown.recipientEvidenceStrength = recipient.recipientEvidenceStrength;

  if (!recipient.recipientVerified) {
    result.reviewReason = "RECIPIENT_NOT_VERIFIED";
    breakdown.failureReason =
      "Could not confirm from the slip that this payment was made to IpeNovel " +
      "(no matching merchant code, biller ID, or approved shop/receiver name).";
    return result;
  }

  // ===== CONFIDENCE AND STRUCTURED DATA GATE ================================

  // Unknown != low. A slip whose confidence was never reported has no
  // evidence of quality at all, so it can never satisfy the threshold - and
  // must not be silently treated as 0% "low" either, because the two need
  // different admin explanations.
  if (extracted.confidenceKnown === false) {
    result.reviewReason = "UNKNOWN_CONFIDENCE";
    breakdown.failureReason =
      "OCR confidence was not reported by the provider - cannot auto-approve without it";
    return result;
  }

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

/**
 * HTTP statuses treated as transient for a generic OpenAI-compatible
 * provider - rate limiting and server-side/gateway failures that a bare
 * retry can plausibly recover from. Never includes 4xx statuses that mean
 * "this request is wrong" (400/401/403/404/etc.) - retrying those would
 * just repeat the same failure.
 */
const RETRYABLE_GENERIC_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/** 3 total attempts = the original call + up to 2 retries. */
const MAX_LLM_ATTEMPTS = 3;

/** Backoff before retry #1 and retry #2, respectively (ms). */
const RETRY_BACKOFF_MS = [500, 1000];

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type InvokeLLMFn = (params: InvokeParams) => Promise<InvokeResult>;
export type SleepFn = (ms: number) => Promise<void>;

export interface ParseSlipImageDeps {
  invokeLLMFn?: InvokeLLMFn;
  sleepFn?: SleepFn;
}

/**
 * OCR-specific bounded retry around a single invokeLLM() call - invokeLLM()
 * itself stays a single provider invocation with no retry semantics of its
 * own, so this policy never silently changes behavior for any other caller.
 * Only retries a transient HTTP failure (429/500/502/504/503) from the
 * GENERIC provider mode - legacy_forge failures, non-transient 4xx (400/
 * 401/403/404/...), malformed-configuration errors, and any non-
 * LLMInvokeError (e.g. a network/parse error) all propagate on the first
 * attempt, exactly like before this change.
 */
async function invokeLLMWithOcrRetry(
  params: InvokeParams,
  invokeLLMFn: InvokeLLMFn,
  sleepFn: SleepFn,
  /** Mutated so the caller learns how many provider calls actually happened. */
  attemptCounter?: { count: number }
): Promise<InvokeResult> {
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      if (attemptCounter) attemptCounter.count = attempt;
      return await invokeLLMFn(params);
    } catch (error) {
      const isRetryableTransientFailure =
        error instanceof LLMInvokeError &&
        error.runtimeMode === "generic" &&
        RETRYABLE_GENERIC_HTTP_STATUSES.has(error.httpStatus);

      if (!isRetryableTransientFailure || attempt >= MAX_LLM_ATTEMPTS) {
        throw error;
      }

      // Safe metadata only - never the endpoint URL, API key, upstream
      // response body, or any OCR/image content.
      console.warn(
        `[OCR] transient generic LLM failure; retrying status=${error.httpStatus} attempt=${attempt}/${MAX_LLM_ATTEMPTS}`
      );
      await sleepFn(RETRY_BACKOFF_MS[attempt - 1]);
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error("[OCR] invokeLLMWithOcrRetry exhausted without a result");
}

export async function parseSlipImage(
  imageUrl: string,
  deps: ParseSlipImageDeps = {}
): Promise<ParseSlipImageResult> {
  const invokeLLMFn = deps.invokeLLMFn ?? invokeLLM;
  const sleepFn = deps.sleepFn ?? defaultSleep;
  // Tracks how many provider invocations actually occurred so a
  // 503-after-3-retries can be told apart from a single blip. Without this
  // the caller could only ever report "one unspecified attempt".
  const attemptCounter = { count: 0 };
  try {
    const response = await invokeLLMWithOcrRetry({
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
    }, invokeLLMFn, sleepFn, attemptCounter);

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string") {
      return {
        text: "",
        ocrConfidence: 0,
        warnings: ["Failed to extract text from image"],
      };
    }

    // Extract OCR confidence. `undefined` means the model never stated one.
    //
    // This previously substituted a hard-coded 85 whenever parsing failed,
    // which manufactured a passing score out of nothing: an unreadable slip
    // could clear the >=85 auto-approval gate purely because the provider
    // omitted a confidence line. Unknown now stays unknown and travels as
    // confidenceKnown:false, which verifySlipData turns into
    // UNKNOWN_CONFIDENCE -> manual review.
    const statedConfidence = parseOcrConfidence(content);
    const confidenceKnown = statedConfidence !== undefined;
    const ocrConfidence = statedConfidence ?? 0;

    const warnings: string[] = [];
    if (!confidenceKnown) {
      warnings.push("OCR confidence not reported by provider - manual review required");
    } else if (ocrConfidence < 70) {
      warnings.push("Low OCR confidence - manual review recommended");
    }
    if (content.length < 50) {
      warnings.push("Very short OCR output - may indicate poor image quality");
    }

    return {
      text: content,
      ocrConfidence,
      confidenceKnown,
      warnings,
    };
  } catch (error) {
    // Sanitized provider metadata is preserved instead of being flattened to
    // a bare `technicalError: true`. Previously an LLMInvokeError's HTTP
    // status, runtime mode and retry count were all discarded here, so every
    // failure - a 503 after three retries, a 401 misconfiguration, a rate
    // limit - was reported and recorded identically as one unspecified
    // error, and an admin could not tell a provider outage from a bad slip.
    //
    // describeProviderFailure returns only a fixed code, an HTTP status, a
    // runtime mode and an attempt count. It never carries the endpoint, the
    // API key, an Authorization header, the upstream body, a signed URL, or
    // base64 image data - see its own tests.
    const diagnostic = describeProviderFailure(error, Math.max(1, attemptCounter.count));

    // Logged with the safe code only, never the raw error object (whose
    // message may embed a URL or credential).
    console.error(
      `[OCR] slip parse failed: ${diagnostic.code} status=${diagnostic.providerHttpStatus ?? "n/a"} attempts=${diagnostic.providerAttemptCount}`
    );

    return {
      text: "",
      ocrConfidence: 0,
      confidenceKnown: false,
      warnings: ["Error parsing image - check URL and image format"],
      technicalError: true, // Flag OCR/LLM technical failure
      technicalErrorCode: diagnostic.code,
      providerDiagnostic: diagnostic,
    };
  }
}
