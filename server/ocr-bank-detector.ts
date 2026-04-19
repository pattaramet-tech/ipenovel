/**
 * OCR Bank Detector
 * 
 * Detects bank type from OCR text using:
 * - Keyword matching
 * - Pattern matching
 * - Confidence scoring
 */

export type BankType = "KBANK" | "SCB" | "BBL" | "KRUNGSRI" | "PROMPTPAY" | "UNKNOWN";

export interface BankDetectionResult {
  bank: BankType;
  confidence: number; // 0-1
  keywords: string[];
  patterns: string[];
}

/**
 * Detect bank from OCR text
 */
export function detectBank(text: string): BankDetectionResult {
  if (!text || typeof text !== "string") {
    return { bank: "UNKNOWN", confidence: 0, keywords: [], patterns: [] };
  }

  const upperText = text.toUpperCase();

  // Check each bank
  const results = [
    detectKBank(upperText),
    detectSCB(upperText),
    detectBBL(upperText),
    detectKrungsri(upperText),
    detectPromptPay(upperText),
  ];

  // Return highest confidence result
  const best = results.reduce((prev, curr) => (curr.confidence > prev.confidence ? curr : prev));

  return best;
}

/**
 * Detect KBank
 */
function detectKBank(text: string): BankDetectionResult {
  const keywords = ["KBANK", "KRUNG THAI", "กรุงไทย", "ธนาคารกรุงไทย"];
  const patterns = [/KB\d{9}/, /KBANK/];

  const foundKeywords = keywords.filter((k) => text.includes(k));
  const foundPatterns = patterns.filter((p) => p.test(text));

  const confidence = Math.min(1, (foundKeywords.length * 0.4 + foundPatterns.length * 0.6) / 1);

  return {
    bank: confidence > 0.3 ? "KBANK" : "UNKNOWN",
    confidence,
    keywords: foundKeywords,
    patterns: foundPatterns.map((p) => p.source),
  };
}

/**
 * Detect SCB (Siam Commercial Bank)
 */
function detectSCB(text: string): BankDetectionResult {
  const keywords = ["SCB", "SIAM COMMERCIAL", "ธนาคารไทยพาณิชย์", "ไทยพาณิชย์"];
  const patterns = [/\d{15}/, /SCB/];

  const foundKeywords = keywords.filter((k) => text.includes(k));
  const foundPatterns = patterns.filter((p) => p.test(text));

  const confidence = Math.min(1, (foundKeywords.length * 0.5 + foundPatterns.length * 0.5) / 1);

  return {
    bank: confidence > 0.3 ? "SCB" : "UNKNOWN",
    confidence,
    keywords: foundKeywords,
    patterns: foundPatterns.map((p) => p.source),
  };
}

/**
 * Detect Bangkok Bank (BBL)
 */
function detectBBL(text: string): BankDetectionResult {
  const keywords = ["BANGKOK BANK", "BBL", "ธนาคารกรุงเทพ", "กรุงเทพ"];
  const patterns = [/BANGKOK BANK/, /BBL/];

  const foundKeywords = keywords.filter((k) => text.includes(k));
  const foundPatterns = patterns.filter((p) => p.test(text));

  const confidence = Math.min(1, (foundKeywords.length * 0.4 + foundPatterns.length * 0.6) / 1);

  return {
    bank: confidence > 0.3 ? "BBL" : "UNKNOWN",
    confidence,
    keywords: foundKeywords,
    patterns: foundPatterns.map((p) => p.source),
  };
}

/**
 * Detect Krungsri
 */
function detectKrungsri(text: string): BankDetectionResult {
  const keywords = ["KRUNGSRI", "กรุงศรี", "ธนาคารกรุงศรี"];
  const patterns = [/KRUNGSRI/, /กรุงศรี/];

  const foundKeywords = keywords.filter((k) => text.includes(k));
  const foundPatterns = patterns.filter((p) => p.test(text));

  const confidence = Math.min(1, (foundKeywords.length * 0.5 + foundPatterns.length * 0.5) / 1);

  return {
    bank: confidence > 0.3 ? "KRUNGSRI" : "UNKNOWN",
    confidence,
    keywords: foundKeywords,
    patterns: foundPatterns.map((p) => p.source),
  };
}

/**
 * Detect PromptPay
 */
function detectPromptPay(text: string): BankDetectionResult {
  const keywords = ["PROMPTPAY", "PROMPT PAY", "พร้อมเพย์"];
  const patterns = [/PROMPTPAY/, /PROMPT\s*PAY/, /พร้อมเพย์/];

  const foundKeywords = keywords.filter((k) => text.includes(k));
  const foundPatterns = patterns.filter((p) => p.test(text));

  const confidence = Math.min(1, (foundKeywords.length * 0.5 + foundPatterns.length * 0.5) / 1);

  return {
    bank: confidence > 0.3 ? "PROMPTPAY" : "UNKNOWN",
    confidence,
    keywords: foundKeywords,
    patterns: foundPatterns.map((p) => p.source),
  };
}

/**
 * Get bank display name
 */
export function getBankDisplayName(bank: BankType): string {
  const names: { [key in BankType]: string } = {
    KBANK: "Krung Thai Bank",
    SCB: "Siam Commercial Bank",
    BBL: "Bangkok Bank",
    KRUNGSRI: "Krungsri",
    PROMPTPAY: "PromptPay",
    UNKNOWN: "Unknown Bank",
  };

  return names[bank];
}

/**
 * Debug helper - show detection steps
 */
export function debugBankDetection(text: string): {
  input: string;
  result: BankDetectionResult;
  allResults: BankDetectionResult[];
} {
  const results = [
    detectKBank(text.toUpperCase()),
    detectSCB(text.toUpperCase()),
    detectBBL(text.toUpperCase()),
    detectKrungsri(text.toUpperCase()),
    detectPromptPay(text.toUpperCase()),
  ];

  const result = detectBank(text);

  return {
    input: text,
    result,
    allResults: results,
  };
}
