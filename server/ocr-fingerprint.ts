/**
 * OCR Fingerprint Module
 * 
 * Provides fraud-resistant duplicate detection using SHA256 fingerprints
 * Prevents replay attacks and duplicate slip submissions
 */

import crypto from "crypto";

/**
 * Fingerprint configuration
 */
export interface FingerprintConfig {
  algorithm: "sha256" | "sha512";
  includeTimestamp: boolean;
  timestampPrecision: "day" | "hour" | "minute"; // How precise the timestamp should be
}

/**
 * Default fingerprint config
 */
const DEFAULT_CONFIG: FingerprintConfig = {
  algorithm: "sha256",
  includeTimestamp: true,
  timestampPrecision: "day",
};

/**
 * Extract date only (YYYY-MM-DD) from ISO string
 * Used for fingerprinting to prevent datetime noise
 */
function extractDateOnly(isoDatetime: string): string {
  try {
    const date = new Date(isoDatetime);
    return date.toISOString().split("T")[0];
  } catch (e) {
    return "";
  }
}

/**
 * Generate fingerprint from normalized slip data
 * 
 * Fingerprint = hash(amount | date_only | normalized_reference | merchantCode | bank)
 * 
 * Uses date-only (not time) to prevent OCR datetime noise from breaking duplicate detection
 * This ensures:
 * - Same slip submitted twice = same fingerprint (detects duplicates)
 * - Different slips = different fingerprints
 * - OCR datetime noise doesn't break detection
 */
export function generateFingerprint(
  amount: number,
  datetime: string, // ISO format
  reference: string,
  merchantCode: string | null,
  bank: string = "UNKNOWN",
  config: Partial<FingerprintConfig> = {}
): string {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Build fingerprint data using date-only (not time)
  const parts: string[] = [
    amount.toFixed(2), // Ensure 2 decimal places
    extractDateOnly(datetime), // Date only, no time
    reference.toUpperCase().trim(),
  ];

  // Include merchant code if available (helps distinguish between different merchants)
  if (merchantCode) {
    parts.push(merchantCode.toUpperCase().trim());
  }

  // Include bank for better discrimination
  parts.push(bank.toUpperCase());

  const fingerprintData = parts.join("|");

  // Generate hash
  const hash = crypto.createHash(finalConfig.algorithm);
  hash.update(fingerprintData);
  return hash.digest("hex");
}



/**
 * Normalize datetime for fingerprinting
 * 
 * Precision levels:
 * - day: YYYY-MM-DD (ignores time, allows multiple payments same day)
 * - hour: YYYY-MM-DD HH (allows multiple payments same hour)
 * - minute: YYYY-MM-DD HH:MM (allows multiple payments same minute)
 */
function normalizeDateTime(
  isoDatetime: string,
  precision: "day" | "hour" | "minute"
): string {
  try {
    const date = new Date(isoDatetime);

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");

    if (precision === "day") {
      return `${year}-${month}-${day}`;
    }

    const hour = String(date.getUTCHours()).padStart(2, "0");

    if (precision === "hour") {
      return `${year}-${month}-${day} ${hour}`;
    }

    const minute = String(date.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  } catch (e) {
    // Fallback: return original if parsing fails
    return isoDatetime;
  }
}

/**
 * Check if fingerprint already exists in database
 * This is a helper interface - actual DB lookup happens in integration layer
 */
export interface FingerprintStore {
  exists(fingerprint: string): Promise<boolean>;
  add(fingerprint: string, metadata: FingerprintMetadata): Promise<void>;
}

/**
 * Metadata stored with fingerprint
 */
export interface FingerprintMetadata {
  paymentId: number;
  orderId: number;
  amount: number;
  reference: string;
  timestamp: Date;
}

/**
 * Validate fingerprint against store
 * Returns: { isDuplicate, existingPaymentId }
 */
export async function validateFingerprint(
  fingerprint: string,
  store: FingerprintStore
): Promise<{ isDuplicate: boolean; existingPaymentId?: number }> {
  const exists = await store.exists(fingerprint);

  if (exists) {
    return { isDuplicate: true };
  }

  return { isDuplicate: false };
}

/**
 * Generate and validate fingerprint in one call
 */
export async function generateAndValidate(
  amount: number,
  datetime: string,
  reference: string,
  merchantCode: string | null,
  store: FingerprintStore,
  bank?: string,
  config?: Partial<FingerprintConfig>
): Promise<{
  fingerprint: string;
  isDuplicate: boolean;
  existingPaymentId?: number;
}> {
  const fingerprint = generateFingerprint(amount, datetime, reference, merchantCode, bank || "UNKNOWN", config);
  const validation = await validateFingerprint(fingerprint, store);

  return {
    fingerprint,
    isDuplicate: validation.isDuplicate,
    existingPaymentId: validation.existingPaymentId,
  };
}

/**
 * Batch generate fingerprints (for testing/analysis)
 */
export function batchGenerateFingerprints(
  slips: Array<{
    amount: number;
    datetime: string;
    reference: string;
    merchantCode: string | null;
    bank?: string;
  }>,
  config?: Partial<FingerprintConfig>
): string[] {
  return slips.map((slip) =>
    generateFingerprint(slip.amount, slip.datetime, slip.reference, slip.merchantCode, slip.bank || "UNKNOWN", config)
  );
}

/**
 * Compare two fingerprints
 */
export function compareFingerprints(fp1: string, fp2: string): boolean {
  return fp1.toLowerCase() === fp2.toLowerCase();
}

/**
 * Extract components from fingerprint (for debugging)
 * Note: This is for testing only - fingerprints are one-way hashes
 */
export function debugFingerprintComponents(
  amount: number,
  datetime: string,
  reference: string,
  merchantCode: string | null,
  precision: "day" | "hour" | "minute" = "day"
): {
  amount: string;
  datetime: string;
  reference: string;
  merchantCode: string;
  combined: string;
} {
  return {
    amount: amount.toString(),
    datetime: normalizeDateTime(datetime, precision),
    reference: reference.toUpperCase().trim(),
    merchantCode: merchantCode ? merchantCode.toUpperCase().trim() : "NULL",
    combined: [
      amount.toString(),
      normalizeDateTime(datetime, precision),
      reference.toUpperCase().trim(),
      merchantCode ? merchantCode.toUpperCase().trim() : "",
    ]
      .join("|")
      .replace(/\|+$/, ""), // Remove trailing pipes
  };
}
