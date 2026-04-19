/**
 * Bank-Specific OCR Extraction Module
 * 
 * Provides bank-aware parsing logic for Thai banks:
 * - KBank (Kasikorn)
 * - SCB (Siam Commercial Bank)
 * - Bangkok Bank
 * - Krungsri (Bank of Ayudhya)
 * - PromptPay
 */

export interface BankSpecificExtraction {
  bank: string;
  merchantCode: string | null;
  reference: string | null;
  confidence: number; // 0-100
}

/**
 * KBank (Kasikorn) specific extraction
 * 
 * Patterns:
 * - Merchant Code: KBXXXXXXXXX (11 digits starting with KB)
 * - Reference: often starts with K, numeric
 */
export function extractKBank(ocrText: string): BankSpecificExtraction {
  const result: BankSpecificExtraction = {
    bank: "KBANK",
    merchantCode: null,
    reference: null,
    confidence: 0,
  };

  // Extract merchant code: KB followed by 9+ digits
  const merchantMatch = ocrText.match(/\bKB\d{9,}\b/);
  if (merchantMatch) {
    result.merchantCode = merchantMatch[0];
    result.confidence += 30;
  }

  // Extract reference: K followed by digits, or standalone numeric reference
  const refMatch = ocrText.match(/\bK\d{10,}\b/) || ocrText.match(/\b\d{10,}\b/);
  if (refMatch) {
    result.reference = refMatch[0];
    result.confidence += 20;
  }

  return result;
}

/**
 * SCB (Siam Commercial Bank) specific extraction
 * 
 * Patterns:
 * - Reference: numeric (≥10 digits)
 * - Merchant: 15-digit number
 */
export function extractSCB(ocrText: string): BankSpecificExtraction {
  const result: BankSpecificExtraction = {
    bank: "SCB",
    merchantCode: null,
    reference: null,
    confidence: 0,
  };

  // Extract merchant: 15-digit number
  const merchantMatch = ocrText.match(/\b\d{15}\b/);
  if (merchantMatch) {
    result.merchantCode = merchantMatch[0];
    result.confidence += 30;
  }

  // Extract reference: 10+ digit number
  const refMatch = ocrText.match(/\b\d{10,}\b/);
  if (refMatch) {
    result.reference = refMatch[0];
    result.confidence += 20;
  }

  return result;
}

/**
 * Bangkok Bank specific extraction
 * 
 * Patterns:
 * - No reliable merchant code
 * - Use reference as primary identifier
 * - Reference: 12+ alphanumeric characters
 */
export function extractBangkokBank(ocrText: string): BankSpecificExtraction {
  const result: BankSpecificExtraction = {
    bank: "BANGKOK_BANK",
    merchantCode: null,
    reference: null,
    confidence: 0,
  };

  // Extract reference: 12+ alphanumeric characters
  const refMatch = ocrText.match(/\b[A-Z0-9]{12,}\b/i);
  if (refMatch) {
    result.reference = refMatch[0];
    result.confidence += 25;
  }

  return result;
}

/**
 * Krungsri (Bank of Ayudhya) specific extraction
 * 
 * Patterns:
 * - Merchant: ≥10 digits
 * - Reference: numeric
 */
export function extractKrungsri(ocrText: string): BankSpecificExtraction {
  const result: BankSpecificExtraction = {
    bank: "KRUNGSRI",
    merchantCode: null,
    reference: null,
    confidence: 0,
  };

  // Extract merchant: 8+ digit number
  const merchantMatch = ocrText.match(/\b\d{8,}\b/);
  if (merchantMatch) {
    result.merchantCode = merchantMatch[0];
    result.confidence += 30;
  }

  // Extract reference: 10+ digit number
  const refMatch = ocrText.match(/\b\d{10,}\b/);
  if (refMatch) {
    result.reference = refMatch[0];
    result.confidence += 20;
  }

  return result;
}

/**
 * PromptPay specific extraction (CRITICAL)
 * 
 * Patterns:
 * - MerchantCode = phone OR citizen ID
 * - Phone: 0XXXXXXXXX (10 digits starting with 0)
 * - National ID: XXXXXXXXXXX (13 digits)
 * - Reference: 10+ digits
 */
export function extractPromptPay(ocrText: string): BankSpecificExtraction {
  const result: BankSpecificExtraction = {
    bank: "PROMPTPAY",
    merchantCode: null,
    reference: null,
    confidence: 0,
  };

  // Extract merchant: phone (0XXXXXXXXX) or national ID (13 digits)
  const phoneMatch = ocrText.match(/\b0\d{9}\b/);
  if (phoneMatch) {
    result.merchantCode = phoneMatch[0];
    result.confidence += 30;
  } else {
    const idMatch = ocrText.match(/\b\d{13}\b/);
    if (idMatch) {
      result.merchantCode = idMatch[0];
      result.confidence += 30;
    }
  }

  // Extract reference: 10+ digit number
  const refMatch = ocrText.match(/\b\d{10,}\b/);
  if (refMatch) {
    result.reference = refMatch[0];
    result.confidence += 20;
  }

  return result;
}

/**
 * Dispatch to bank-specific extractor
 */
export function extractBankSpecific(
  ocrText: string,
  detectedBank: string
): BankSpecificExtraction {
  switch (detectedBank) {
    case "KBANK":
      return extractKBank(ocrText);
    case "SCB":
      return extractSCB(ocrText);
    case "BANGKOK_BANK":
      return extractBangkokBank(ocrText);
    case "KRUNGSRI":
      return extractKrungsri(ocrText);
    case "PROMPTPAY":
      return extractPromptPay(ocrText);
    default:
      // Unknown bank: return empty result
      return {
        bank: detectedBank,
        merchantCode: null,
        reference: null,
        confidence: 0,
      };
  }
}

/**
 * Merge universal and bank-specific extraction results
 */
export function mergeBankSpecificData(
  universal: { merchantCode: string | null; reference: string | null },
  bankSpecific: BankSpecificExtraction
): {
  merchantCode: string | null;
  reference: string | null;
  bankConfidence: number;
} {
  return {
    // Prefer bank-specific extraction if available, fallback to universal
    merchantCode: bankSpecific.merchantCode || universal.merchantCode,
    reference: bankSpecific.reference || universal.reference,
    bankConfidence: bankSpecific.confidence,
  };
}
