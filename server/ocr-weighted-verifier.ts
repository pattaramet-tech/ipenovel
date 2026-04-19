/**
 * Weighted Verification Engine for OCR Slip Auto-Approval
 * 
 * Uses weighted signals to make auto-approval decisions:
 * - Amount match (critical)
 * - Receiver/merchant match (critical)
 * - Account or masked account match (high)
 * - Transaction time within window (high)
 * - Duplicate-free fingerprint (critical)
 * - OCR confidence (medium)
 * 
 * Conservative anti-fraud policy: manual review is acceptable, false approval is not
 */

import { StructuredOCRData } from "./ocr-structured-extractor";
import crypto from "crypto";

export interface VerificationSignal {
  name: string;
  weight: number; // 0-1
  score: number; // 0-1
  reason?: string;
}

export interface WeightedVerificationResult {
  isAutoApproved: boolean;
  overallScore: number; // 0-1
  signals: VerificationSignal[];
  reviewReason?: string;
  fingerprint: string;
  riskLevel: "low" | "medium" | "high";
}

export interface VerificationContext {
  orderId: number;
  paymentId: number;
  orderTotal: number;
  orderCreatedAt: Date;
  paymentCreatedAt: Date;
  slipSubmittedAt?: Date;
  merchantName: string; // Expected merchant/shop name
  merchantCode?: string; // Optional merchant code to verify
  receiverAccountMasked?: string; // Optional account to verify
}

/**
 * Generate fingerprint from normalized OCR data
 * Uses date-only to prevent datetime noise
 */
export function generateFingerprint(
  amount: number | null,
  datetime: Date | null,
  referenceId: string | null,
  transactionId: string | null,
  merchantCode?: string | null
): string {
  const components = [
    amount?.toFixed(2) || "",
    datetime ? datetime.toISOString().split("T")[0] : "", // Date only
    referenceId || "",
    transactionId || "",
    merchantCode || "",
  ];

  const fingerprintData = components.join("|");
  return crypto.createHash("sha256").update(fingerprintData).digest("hex");
}

/**
 * Check if amount matches order total
 */
function verifyAmount(
  extracted: StructuredOCRData,
  context: VerificationContext
): VerificationSignal {
  const signal: VerificationSignal = {
    name: "AMOUNT_MATCH",
    weight: 0.25, // Critical
    score: 0,
  };

  if (!extracted.amount) {
    signal.reason = "No amount extracted from slip";
    return signal;
  }

  // Allow 0.01 tolerance for rounding
  if (Math.abs(extracted.amount - context.orderTotal) < 0.01) {
    signal.score = 1;
    signal.reason = `Amount matches: ${extracted.amount} = ${context.orderTotal}`;
  } else {
    signal.score = 0;
    signal.reason = `Amount mismatch: extracted ${extracted.amount}, expected ${context.orderTotal}`;
  }

  return signal;
}

/**
 * Check if receiver/merchant name matches
 */
function verifyReceiverName(
  extracted: StructuredOCRData,
  context: VerificationContext
): VerificationSignal {
  const signal: VerificationSignal = {
    name: "RECEIVER_MATCH",
    weight: 0.25, // Critical
    score: 0,
  };

  if (!extracted.receiverName) {
    signal.reason = "No receiver name extracted";
    return signal;
  }

  const normalizedExtracted = extracted.receiverName.toLowerCase().trim();
  const normalizedExpected = context.merchantName.toLowerCase().trim();

  // Exact match
  if (normalizedExtracted === normalizedExpected) {
    signal.score = 1;
    signal.reason = `Receiver name matches exactly: ${extracted.receiverName}`;
    return signal;
  }

  // Fuzzy match: check if key words overlap
  const extractedWords = normalizedExtracted.split(/\s+/);
  const expectedWords = normalizedExpected.split(/\s+/);
  const matches = extractedWords.filter((word) =>
    expectedWords.some((exp) => exp.includes(word) || word.includes(exp))
  );

  if (matches.length > 0 && matches.length >= Math.min(extractedWords.length, expectedWords.length) * 0.7) {
    signal.score = 0.8; // Partial match
    signal.reason = `Receiver name partially matches: ${extracted.receiverName}`;
  } else {
    signal.score = 0;
    signal.reason = `Receiver name mismatch: extracted "${extracted.receiverName}", expected "${context.merchantName}"`;
  }

  return signal;
}

/**
 * Check if account or masked account matches
 */
function verifyAccount(
  extracted: StructuredOCRData,
  context: VerificationContext
): VerificationSignal {
  const signal: VerificationSignal = {
    name: "ACCOUNT_MATCH",
    weight: 0.15, // High
    score: 0,
  };

  if (!context.receiverAccountMasked) {
    signal.reason = "No account verification configured";
    return signal;
  }

  if (!extracted.receiverAccountMasked) {
    signal.reason = "No receiver account extracted from slip";
    return signal;
  }

  // Extract last 4 digits from both
  const extractedLast4 = extracted.receiverAccountMasked.replace(/\D/g, "").slice(-4);
  const expectedLast4 = context.receiverAccountMasked.replace(/\D/g, "").slice(-4);

  if (extractedLast4 === expectedLast4 && extractedLast4.length === 4) {
    signal.score = 1;
    signal.reason = `Account last 4 digits match: ${extractedLast4}`;
  } else {
    signal.score = 0;
    signal.reason = `Account mismatch: extracted "${extracted.receiverAccountMasked}", expected "${context.receiverAccountMasked}"`;
  }

  return signal;
}

/**
 * Check if transaction is within acceptable time window
 */
function verifyTransactionTime(
  extracted: StructuredOCRData,
  context: VerificationContext
): VerificationSignal {
  const signal: VerificationSignal = {
    name: "TIME_WINDOW",
    weight: 0.15, // High
    score: 0,
  };

  if (!extracted.transactionDateTime) {
    signal.reason = "No transaction date extracted";
    return signal;
  }

  // Use slipSubmittedAt if available, otherwise paymentCreatedAt
  const referenceTime = context.slipSubmittedAt || context.paymentCreatedAt;
  const transactionTime = extracted.transactionDateTime.getTime();
  const timeDiffMs = referenceTime.getTime() - transactionTime;

  // Allow transaction up to 30 days before slip submission
  // Allow up to 5 minutes after (clock skew)
  const maxAgeMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const minAgeMs = -5 * 60 * 1000; // 5 minutes

  if (timeDiffMs >= minAgeMs && timeDiffMs <= maxAgeMs) {
    signal.score = 1;
    signal.reason = `Transaction within time window: ${Math.round(timeDiffMs / 1000 / 60)} minutes before slip submission`;
  } else if (timeDiffMs > maxAgeMs) {
    signal.score = 0;
    signal.reason = `Transaction too old: ${Math.round(timeDiffMs / 1000 / 60 / 60 / 24)} days before slip submission`;
  } else {
    signal.score = 0;
    signal.reason = `Transaction in future: ${Math.round(Math.abs(timeDiffMs) / 1000 / 60)} minutes after slip submission`;
  }

  return signal;
}

/**
 * Check OCR confidence level
 */
function verifyOCRConfidence(extracted: StructuredOCRData): VerificationSignal {
  const signal: VerificationSignal = {
    name: "OCR_CONFIDENCE",
    weight: 0.1, // Medium
    score: 0,
  };

  const confidence = extracted.overallConfidence || 0;

  if (confidence >= 85) {
    signal.score = 1;
    signal.reason = `High OCR confidence: ${confidence}%`;
  } else if (confidence >= 70) {
    signal.score = 0.7;
    signal.reason = `Medium OCR confidence: ${confidence}%`;
  } else if (confidence >= 50) {
    signal.score = 0.4;
    signal.reason = `Low OCR confidence: ${confidence}%`;
  } else {
    signal.score = 0;
    signal.reason = `Very low OCR confidence: ${confidence}%`;
  }

  return signal;
}

/**
 * Check for duplicate slip (fingerprint-based)
 */
function verifyNoDuplicate(
  extracted: StructuredOCRData,
  existingFingerprints: Set<string>
): VerificationSignal {
  const signal: VerificationSignal = {
    name: "NO_DUPLICATE",
    weight: 0.1, // Medium
    score: 0,
  };

  const fingerprint = generateFingerprint(
    extracted.amount,
    extracted.transactionDateTime,
    extracted.referenceId,
    extracted.transactionId
  );

  if (existingFingerprints.has(fingerprint)) {
    signal.score = 0;
    signal.reason = `Duplicate slip detected (fingerprint match)`;
  } else {
    signal.score = 1;
    signal.reason = `No duplicate detected`;
  }

  return signal;
}

/**
 * Perform weighted verification
 */
export function verifyWithWeights(
  extracted: StructuredOCRData,
  context: VerificationContext,
  existingFingerprints: Set<string> = new Set()
): WeightedVerificationResult {
  const signals: VerificationSignal[] = [];

  // Collect all signals
  signals.push(verifyAmount(extracted, context));
  signals.push(verifyReceiverName(extracted, context));
  signals.push(verifyAccount(extracted, context));
  signals.push(verifyTransactionTime(extracted, context));
  signals.push(verifyOCRConfidence(extracted));
  signals.push(verifyNoDuplicate(extracted, existingFingerprints));

  // Calculate weighted score
  let totalWeight = 0;
  let weightedScore = 0;

  for (const signal of signals) {
    totalWeight += signal.weight;
    weightedScore += signal.score * signal.weight;
  }

  const overallScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // Determine auto-approval: all critical signals (weight >= 0.25) must pass
  const criticalSignals = signals.filter((s) => s.weight >= 0.25);
  const allCriticalPass = criticalSignals.every((s) => s.score >= 0.9);

  // Determine risk level
  let riskLevel: "low" | "medium" | "high" = "low";
  if (overallScore < 0.5) {
    riskLevel = "high";
  } else if (overallScore < 0.75) {
    riskLevel = "medium";
  }

  // Find first failed critical signal for review reason
  let reviewReason: string | undefined;
  if (!allCriticalPass) {
    const failedSignal = criticalSignals.find((s) => s.score < 0.9);
    if (failedSignal) {
      reviewReason = failedSignal.name;
    }
  }

  const fingerprint = generateFingerprint(
    extracted.amount,
    extracted.transactionDateTime,
    extracted.referenceId,
    extracted.transactionId
  );

  return {
    isAutoApproved: allCriticalPass && overallScore >= 0.75,
    overallScore,
    signals,
    reviewReason,
    fingerprint,
    riskLevel,
  };
}
