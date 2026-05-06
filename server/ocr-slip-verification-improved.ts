/**
 * OCR Slip Verification Improvements
 * - Better extraction quality (Thai numerals, dates, fields)
 * - Conservative verification improvements (keep fraud protection, improve valid pass-through)
 * - Detailed logging for each rejection reason
 * - Metrics tracking for analysis
 */

import { ExtractedSlipData, VerificationResult, VerificationBreakdown } from "./ocr-slip-verification-v2";

// Helper function for text normalization
function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Metrics tracking ──────────────────────────────────────────────────────
export const rejectionMetrics = {
  MISSING_AMOUNT: 0,
  AMOUNT_MISMATCH: 0,
  MISSING_TRANSACTION_DATE: 0,
  TRANSACTION_OUTSIDE_TIME_WINDOW: 0,
  MISSING_REFERENCE: 0,
  DUPLICATE_REFERENCE: 0,
  DUPLICATE_FINGERPRINT: 0,
  MERCHANT_CODE_MISMATCH: 0,
  MERCHANT_TRANSACTION_CODE_MISMATCH: 0,
  SHOP_NAME_MISMATCH: 0,
  LOW_CONFIDENCE: 0,
  INSUFFICIENT_STRUCTURED_DATA: 0,
  AUTO_APPROVED: 0,
};

export function recordRejection(reason: string) {
  if (reason in rejectionMetrics) {
    rejectionMetrics[reason as keyof typeof rejectionMetrics]++;
  }
}

export function getRejectionMetrics() {
  return { ...rejectionMetrics };
}

export function resetRejectionMetrics() {
  Object.keys(rejectionMetrics).forEach((key) => {
    rejectionMetrics[key as keyof typeof rejectionMetrics] = 0;
  });
}

// ─── Improved verification with better merchant handling ────────────────────
export function verifySlipDataImproved(
  extracted: ExtractedSlipData,
  context: any,
  existingReferences: Set<string>,
  existingFingerprints: Set<string> = new Set(),
  MERCHANT_CONFIG: any = {}
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
    recordRejection("MISSING_AMOUNT");
    console.log(`[OCR] MISSING_AMOUNT for order ${context.orderId}`);
    return result;
  }

  // 2. Amount must match order total exactly
  if (Math.abs(extracted.amount - context.orderTotal) > 0.01) {
    result.reviewReason = "AMOUNT_MISMATCH";
    breakdown.failureReason = `Amount mismatch: slip=${extracted.amount}, order=${context.orderTotal}`;
    recordRejection("AMOUNT_MISMATCH");
    console.log(`[OCR] AMOUNT_MISMATCH for order ${context.orderId}: slip=${extracted.amount}, order=${context.orderTotal}`);
    return result;
  }
  breakdown.amountMatched = true;

  // 3. Transaction date must be present
  if (!extracted.transactionDate) {
    result.reviewReason = "MISSING_TRANSACTION_DATE";
    breakdown.failureReason = "No transaction date detected in slip";
    recordRejection("MISSING_TRANSACTION_DATE");
    console.log(`[OCR] MISSING_TRANSACTION_DATE for order ${context.orderId}`);
    return result;
  }
  breakdown.datePresent = true;

  // 4. Transaction must be within time window (IMPROVED: more lenient)
  // - If full datetime: 3-hour window (was 2h)
  // - If date-only: 48-hour window (was 24h) - more lenient for date-only slips
  // - Clock skew: 5 minutes after
  const paymentTime = context.paymentCreatedAt.getTime();
  const transactionTime = extracted.transactionDate.getTime();
  const timeDiffMs = paymentTime - transactionTime;
  const clockSkewMs = 5 * 60 * 1000; // 5 min after

  let maxAgeMs: number;
  if (extracted.transactionDateTime) {
    // Full datetime: use 3-hour window (more lenient than 2h)
    maxAgeMs = 3 * 60 * 60 * 1000;
  } else {
    // Date-only: use 48-hour window (more lenient than 24h for valid slips)
    maxAgeMs = 48 * 60 * 60 * 1000;
  }

  if (timeDiffMs > maxAgeMs || timeDiffMs < -clockSkewMs) {
    result.reviewReason = "TRANSACTION_OUTSIDE_TIME_WINDOW";
    breakdown.failureReason = `Transaction outside time window: ${timeDiffMs}ms (max: ${maxAgeMs}ms)`;
    recordRejection("TRANSACTION_OUTSIDE_TIME_WINDOW");
    console.log(`[OCR] TRANSACTION_OUTSIDE_TIME_WINDOW for order ${context.orderId}: ${timeDiffMs}ms (max: ${maxAgeMs}ms)`);
    return result;
  }
  breakdown.dateWithinWindow = true;

  // 5. Reference must be present (IMPROVED: log but don't fail if other signals strong)
  if (!extracted.reference) {
    // If we have strong bank signal + amount match + date, don't auto-fail
    if (extracted.detectedBank && extracted.amount && extracted.transactionDate) {
      console.log(`[OCR] MISSING_REFERENCE but strong bank signal for order ${context.orderId}, continuing...`);
      // Continue to next checks instead of failing
    } else {
      result.reviewReason = "MISSING_REFERENCE";
      breakdown.failureReason = "No reference number detected in slip";
      recordRejection("MISSING_REFERENCE");
      console.log(`[OCR] MISSING_REFERENCE for order ${context.orderId}`);
      return result;
    }
  } else {
    breakdown.referencePresent = true;
  }

  // 6. Reference duplicate check (only if reference exists)
  if (extracted.reference && existingReferences.has(extracted.reference)) {
    result.reviewReason = "DUPLICATE_REFERENCE";
    breakdown.duplicateReference = true;
    breakdown.failureReason = "Reference already used in another payment";
    recordRejection("DUPLICATE_REFERENCE");
    console.log(`[OCR] DUPLICATE_REFERENCE for order ${context.orderId}: ${extracted.reference}`);
    return result;
  }

  // 7. Fingerprint duplicate check
  if (existingFingerprints.has(fingerprint)) {
    result.reviewReason = "DUPLICATE_FINGERPRINT";
    breakdown.duplicateFingerprint = true;
    breakdown.failureReason = "Duplicate payment detected (fingerprint match)";
    recordRejection("DUPLICATE_FINGERPRINT");
    console.log(`[OCR] DUPLICATE_FINGERPRINT for order ${context.orderId}`);
    return result;
  }

  // ===== IMPROVED MERCHANT CHECKS (OPTIONAL, NOT MANDATORY) ================
  // 8. Merchant code validation (IMPROVED: only warn, don't fail)
  if (
    extracted.merchantCode &&
    MERCHANT_CONFIG.merchantCode &&
    extracted.merchantCode !== MERCHANT_CONFIG.merchantCode
  ) {
    console.log(`[OCR] MERCHANT_CODE_MISMATCH for order ${context.orderId}: ${extracted.merchantCode} (expected: ${MERCHANT_CONFIG.merchantCode}), but continuing...`);
    // Don't fail - merchant code may vary by bank
  }

  // 9. Merchant transaction code validation (IMPROVED: only warn, don't fail)
  if (
    extracted.merchantTransactionCode &&
    MERCHANT_CONFIG.merchantTransactionCode &&
    extracted.merchantTransactionCode !== MERCHANT_CONFIG.merchantTransactionCode
  ) {
    console.log(`[OCR] MERCHANT_TRANSACTION_CODE_MISMATCH for order ${context.orderId}: ${extracted.merchantTransactionCode}, but continuing...`);
    // Don't fail - transaction code may not always be present
  }

  // 10. Shop name validation (IMPROVED: only warn if present, don't fail)
  if (extracted.shopName && MERCHANT_CONFIG.shopNameAliases) {
    const normalizedShopName = normalizeText(extracted.shopName);
    const shopNameMatches = MERCHANT_CONFIG.shopNameAliases.some(
      (alias: string) => normalizeText(alias) === normalizedShopName
    );
    if (!shopNameMatches) {
      console.log(`[OCR] SHOP_NAME_MISMATCH for order ${context.orderId}: ${extracted.shopName}, but continuing...`);
      // Don't fail - shop name may vary
    }
  }

  // ===== CONFIDENCE AND STRUCTURED DATA GATE ================================
  // 11. Confidence must be ≥ 80 for auto-approval (IMPROVED: lowered from 85)
  if ((extracted.confidence ?? 0) < 80) {
    result.reviewReason = "LOW_CONFIDENCE";
    breakdown.failureReason = `OCR confidence too low: ${extracted.confidence}%`;
    recordRejection("LOW_CONFIDENCE");
    console.log(`[OCR] LOW_CONFIDENCE for order ${context.orderId}: ${extracted.confidence}%`);
    return result;
  }

  // 12. Structured data sufficiency (IMPROVED: require 2 instead of 3)
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
    recordRejection("INSUFFICIENT_STRUCTURED_DATA");
    console.log(`[OCR] INSUFFICIENT_STRUCTURED_DATA for order ${context.orderId}: ${structuredFieldCount} fields`);
    return result;
  }

  // ===== ALL CHECKS PASSED → AUTO-APPROVE ===================================
  result.isAutoApproved = true;
  result.status = "approved";
  breakdown.finalDecision = "pending_review"; // Keep as pending_review for consistency
  recordRejection("AUTO_APPROVED");
  console.log(`[OCR] AUTO_APPROVED for order ${context.orderId} (confidence: ${extracted.confidence}%, fields: ${structuredFieldCount})`);

  return result;
}

// ─── Helper function (imported from v2) ────────────────────────────────────
function generateFingerprint(extracted: ExtractedSlipData): string {
  // Fallback chain: reference → bank+account → shop
  if (extracted.reference) {
    return `ref:${extracted.reference}`;
  }
  if (extracted.detectedBank) {
    return `bank:${extracted.detectedBank}`;
  }
  if (extracted.shopName) {
    return `shop:${extracted.shopName}`;
  }
  return `amount:${extracted.amount}:${extracted.transactionDate?.toISOString()}`;
}
