/**
 * OCR Normalizer Module
 * 
 * Provides universal regex-based extraction rules for Thai bank slips
 * Handles normalization of extracted data to standard format
 * Supports multiple Thai banks and payment methods
 */

/**
 * Standard normalized slip format
 */
export interface NormalizedSlip {
  amount: number;
  datetime: string; // ISO format
  reference: string;
  shopName: string | null;
  merchantCode: string | null;
  bank: string;
}

/**
 * Raw extraction result before normalization
 */
export interface RawExtraction {
  amount: string | null;
  datetime: string | null;
  reference: string | null;
  shopName: string | null;
  merchantCode: string | null;
  bank: string;
}

/**
 * Universal regex patterns per spec
 */
const UNIVERSAL_PATTERNS = {
  // Amount: ฿ or THB or ฿ symbol, with optional commas
  // Matches: 250.00, 1,250.00, ฿250.00, THB 1,250.00
  amount: /(?:฿|THB|\u0e3f)?\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/,

  // Date + Time: DD/MM/YYYY or DD-MM-YY or DD Mon YYYY, followed by HH:MM or HH:MM:SS
  // Matches: 18/04/2569 10:00, 18-04-26 10:00:30, 18 Apr 2026 10:00
  datetime: /(\d{1,2}[\-/ ](?:\d{1,2}|[A-Za-z]{3})[\-/ ](?:\d{2,4}))\s+(\d{1,2}:\d{2}(?::\d{2})?)/,

  // Reference: "Ref", "Reference", "Transaction ID", "Ref No.", "เลขที่อ้างอิง" followed by alphanumeric
  // Matches: Ref: ABC123, Reference No. 123456, เลขที่อ้างอิง: ABC-123
  reference: /(?:Ref(?:erence)?|Transaction ID|Ref No\.?|เลขที่อ้างอิง)[:\s]*([A-Z0-9\-]{6,})/i,

  // Shop Name: "To", "Receiver", "ถึง", "ผู้รับเงิน" followed by text
  // Matches: To: Ipe Novel, ถึง: ไอเป นิยายแปล
  shopName: /(?:To|Receiver|ถึง|ผู้รับเงิน)[:\s]*([^\n]+)/i,

  // Merchant Code: "Merchant Code", "Merchant ID", "Biller ID" followed by alphanumeric
  // Matches: Merchant Code: KB000002283068, Biller ID: 123456789
  merchantCode: /(?:Merchant(?: Code| ID)?|Biller ID)[:\s]*([A-Z0-9]{6,})/i,
};

/**
 * Extract raw data from OCR text using universal patterns
 */
export function extractRawData(ocrText: string): RawExtraction {
  const raw: RawExtraction = {
    amount: null,
    datetime: null,
    reference: null,
    shopName: null,
    merchantCode: null,
    bank: detectBank(ocrText),
  };

  // Extract amount
  const amountMatch = ocrText.match(UNIVERSAL_PATTERNS.amount);
  if (amountMatch) {
    raw.amount = amountMatch[1];
  }

  // Extract datetime
  const datetimeMatch = ocrText.match(UNIVERSAL_PATTERNS.datetime);
  if (datetimeMatch) {
    raw.datetime = `${datetimeMatch[1]} ${datetimeMatch[2]}`;
  }

  // Extract reference
  const refMatch = ocrText.match(UNIVERSAL_PATTERNS.reference);
  if (refMatch) {
    raw.reference = refMatch[1];
  }

  // Extract shop name
  const shopMatch = ocrText.match(UNIVERSAL_PATTERNS.shopName);
  if (shopMatch) {
    raw.shopName = shopMatch[1];
  }

  // Extract merchant code
  const merchantMatch = ocrText.match(UNIVERSAL_PATTERNS.merchantCode);
  if (merchantMatch) {
    raw.merchantCode = merchantMatch[1];
  }

  return raw;
}

/**
 * Detect bank from OCR text
 */
function detectBank(ocrText: string): string {
  const upperText = ocrText.toUpperCase();

  if (upperText.includes("KASIKORN") || upperText.includes("KBANK")) {
    return "KBANK";
  }
  if (upperText.includes("SIAM COMMERCIAL") || upperText.includes("SCB")) {
    return "SCB";
  }
  if (upperText.includes("BANGKOK BANK")) {
    return "BANGKOK_BANK";
  }
  if (upperText.includes("KRUNGSRI") || upperText.includes("AYUDHYA")) {
    return "KRUNGSRI";
  }
  if (upperText.includes("PROMPTPAY")) {
    return "PROMPTPAY";
  }

  // Default to unknown
  return "UNKNOWN";
}

/**
 * Normalize amount: remove commas, convert to float
 */
function normalizeAmount(amountStr: string | null): number | null {
  if (!amountStr) return null;

  try {
    // Remove commas and spaces
    const cleaned = amountStr.replace(/,/g, "").trim();
    const amount = parseFloat(cleaned);

    // Validate: must be positive number
    if (isNaN(amount) || amount <= 0) {
      return null;
    }

    return amount;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize datetime: parse to ISO format
 * Handles Thai Buddhist year (subtract 543 if year > 2500)
 */
function normalizeDatetime(datetimeStr: string | null): string | null {
  if (!datetimeStr) return null;

  try {
    // Split date and time
    const parts = datetimeStr.split(/\s+/);
    if (parts.length < 2) return null;

    const datePart = parts[0];
    const timePart = parts[1];

    // Parse date: support DD/MM/YYYY, DD-MM-YY, DD Mon YYYY
    let day, month, year;

    // Try numeric format first: DD/MM/YYYY or DD-MM-YY
    const numericMatch = datePart.match(/(\d{1,2})[\-/](\d{1,2})[\-/](\d{2,4})/);
    if (numericMatch) {
      day = parseInt(numericMatch[1]);
      month = parseInt(numericMatch[2]);
      year = parseInt(numericMatch[3]);

      // Handle 2-digit year
      if (year < 100) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }
    } else {
      // Try text format: DD Mon YYYY
      const textMatch = datePart.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
      if (!textMatch) return null;

      day = parseInt(textMatch[1]);
      const monthStr = textMatch[2].toLowerCase();
      year = parseInt(textMatch[3]);

      // Map month name to number
      const monthMap: Record<string, number> = {
        jan: 1,
        feb: 2,
        mar: 3,
        apr: 4,
        may: 5,
        jun: 6,
        jul: 7,
        aug: 8,
        sep: 9,
        oct: 10,
        nov: 11,
        dec: 12,
      };

      month = monthMap[monthStr];
      if (!month) return null;
    }

    // Convert Buddhist year to AD (if year > 2500)
    if (year > 2500) {
      year = year - 543;
    }

    // Validate date
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }

    // Parse time: HH:MM or HH:MM:SS
    const timeMatch = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!timeMatch) return null;

    const hour = parseInt(timeMatch[1]);
    const minute = parseInt(timeMatch[2]);
    const second = timeMatch[3] ? parseInt(timeMatch[3]) : 0;

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      return null;
    }

    // Create ISO string
    const date = new Date(year, month - 1, day, hour, minute, second);
    return date.toISOString();
  } catch (e) {
    return null;
  }
}

/**
 * Normalize reference: uppercase, trim, remove spaces if necessary
 */
function normalizeReference(refStr: string | null): string | null {
  if (!refStr) return null;

  try {
    // Uppercase and trim
    let normalized = refStr.toUpperCase().trim();

    // Remove spaces (some references may have spaces)
    normalized = normalized.replace(/\s+/g, "");

    // Validate: must be at least 6 characters
    if (normalized.length < 6) {
      return null;
    }

    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize shop name: trim, normalize spacing
 */
function normalizeShopName(shopStr: string | null): string | null {
  if (!shopStr) return null;

  try {
    // Trim and normalize whitespace
    let normalized = shopStr.trim();
    normalized = normalized.replace(/\s+/g, " ");

    // Validate: must not be empty
    if (normalized.length === 0) {
      return null;
    }

    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize merchant code: trim, strict format validation
 */
function normalizeMerchantCode(codeStr: string | null): string | null {
  if (!codeStr) return null;

  try {
    // Trim
    let normalized = codeStr.toUpperCase().trim();

    // Remove spaces
    normalized = normalized.replace(/\s+/g, "");

    // Validate: must be at least 6 alphanumeric characters
    if (!/^[A-Z0-9]{6,}$/.test(normalized)) {
      return null;
    }

    return normalized;
  } catch (e) {
    return null;
  }
}

/**
 * Normalize raw extraction to standard format
 */
export function normalizeExtraction(raw: RawExtraction): NormalizedSlip | null {
  const amount = normalizeAmount(raw.amount);
  const datetime = normalizeDatetime(raw.datetime);
  const reference = normalizeReference(raw.reference);
  const shopName = normalizeShopName(raw.shopName);
  const merchantCode = normalizeMerchantCode(raw.merchantCode);

  // Validate critical fields
  if (!amount || !datetime || !reference) {
    return null;
  }

  return {
    amount,
    datetime,
    reference,
    shopName,
    merchantCode,
    bank: raw.bank,
  };
}

/**
 * Main entry point: extract and normalize OCR text
 */
export function extractAndNormalize(ocrText: string): NormalizedSlip | null {
  const raw = extractRawData(ocrText);
  return normalizeExtraction(raw);
}
