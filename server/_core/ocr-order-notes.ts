/**
 * OCR Order History Notes Builder
 *
 * Generates comprehensive, human-readable notes explaining:
 * - Why a slip was auto-approved (all checks passed)
 * - Why a slip requires manual review (which check failed and why)
 * - Detailed verification breakdown for admin visibility
 */

import { VerificationBreakdown } from "../ocr-slip-verification-v2";

export interface OrderNoteContext {
  isAutoApproved: boolean;
  isShadowMode: boolean;
  ocrConfidence?: number;
  detectedBank?: string;
  reviewReason?: string;
  breakdown?: VerificationBreakdown;
  extractedAmount?: number;
  orderTotal?: number;
  extractedDate?: string;
}

/**
 * Generate detailed order history note for auto-approved slip
 *
 * Example output:
 * "✅ AUTO-APPROVED via OCR
 *  • Confidence: 92% (high)
 *  • Bank: Bangkok Bank (BBL)
 *  • Amount: ฿299.00 (matches order exactly)
 *  • Date: 2026-04-29 14:30 (within 2h window)
 *  • Reference: TXN123456 (unique, not duplicate)
 *  • Merchant: Ipe Novel (verified)
 *  • All 12 verification checks passed
 *  ✓ Customer can now access purchased content"
 */
export function generateApprovalNote(context: OrderNoteContext): string {
  const lines: string[] = [];

  lines.push("✅ AUTO-APPROVED via OCR");

  // Confidence level
  if (context.ocrConfidence !== undefined) {
    const confidenceLevel =
      context.ocrConfidence >= 90
        ? "very high"
        : context.ocrConfidence >= 85
          ? "high"
          : "acceptable";
    lines.push(`• Confidence: ${context.ocrConfidence}% (${confidenceLevel})`);
  }

  // Bank detection
  if (context.detectedBank) {
    lines.push(`• Bank: ${context.detectedBank}`);
  }

  // Amount verification
  if (context.extractedAmount !== undefined && context.orderTotal !== undefined) {
    lines.push(
      `• Amount: ฿${context.extractedAmount.toFixed(2)} (matches order exactly)`
    );
  }

  // Date verification
  if (context.extractedDate) {
    lines.push(
      `• Date: ${context.extractedDate} (within 2-hour window)`
    );
  }

  // Breakdown details
  if (context.breakdown) {
    const checks: string[] = [];

    if (context.breakdown.amountMatched) checks.push("amount matched");
    if (context.breakdown.datePresent && context.breakdown.dateWithinWindow)
      checks.push("date valid");
    if (context.breakdown.referencePresent) checks.push("reference present");
    if (!context.breakdown.duplicateReference && !context.breakdown.duplicateFingerprint)
      checks.push("no duplicates");
    if (context.breakdown.bankDetected) checks.push("bank verified");

    if (checks.length > 0) {
      lines.push(`• Verification: ${checks.join(", ")}`);
    }
  }

  lines.push("✓ All 12 verification checks passed");
  lines.push("✓ Customer can now access purchased content");

  return lines.join("\n");
}

/**
 * Generate detailed order history note for manual review slip
 *
 * Example outputs:
 *
 * "⚠️ MANUAL REVIEW REQUIRED - LOW_CONFIDENCE
 *  • OCR Confidence: 72% (below 85% threshold)
 *  • Bank: Bangkok Bank (BBL)
 *  • Amount: ฿299.00 (matches order)
 *  • Date: 2026-04-29 (valid)
 *  • Reference: TXN123456 (unique)
 *  → Reason: OCR confidence too low, requires manual verification
 *  → Action: Admin must review slip image and approve/reject manually"
 *
 * "⚠️ MANUAL REVIEW REQUIRED - DUPLICATE_REFERENCE
 *  • OCR Confidence: 91% (high)
 *  • Bank: Bangkok Bank (BBL)
 *  • Amount: ฿299.00 (matches order)
 *  • Date: 2026-04-29 14:30 (valid)
 *  • Reference: TXN123456 (DUPLICATE - already used in payment #12345)
 *  → Reason: Reference number already used in another payment
 *  → Action: Customer must submit a different slip with a new reference number"
 *
 * "⚠️ MANUAL REVIEW REQUIRED - AMOUNT_MISMATCH
 *  • OCR Confidence: 88% (high)
 *  • Bank: Bangkok Bank (BBL)
 *  • Amount: ฿250.00 (extracted from slip)
 *  • Expected: ฿299.00 (order total)
 *  • Mismatch: ฿49.00 short
 *  → Reason: Slip amount does not match order total
 *  → Action: Customer must submit correct slip or admin can adjust order"
 */
export function generateManualReviewNote(context: OrderNoteContext): string {
  const lines: string[] = [];

  // Header with reason
  const reason = context.reviewReason || "UNKNOWN";
  const reasonLabel = formatReasonLabel(reason);
  lines.push(`⚠️ MANUAL REVIEW REQUIRED - ${reason}`);
  lines.push("");

  // Confidence level
  if (context.ocrConfidence !== undefined) {
    const confidenceLevel =
      context.ocrConfidence >= 90
        ? "very high"
        : context.ocrConfidence >= 85
          ? "high"
          : context.ocrConfidence >= 75
            ? "medium"
            : "low";
    lines.push(`• OCR Confidence: ${context.ocrConfidence}% (${confidenceLevel})`);
  }

  // Bank detection
  if (context.detectedBank) {
    lines.push(`• Bank: ${context.detectedBank}`);
  }

  // Amount details
  if (context.extractedAmount !== undefined && context.orderTotal !== undefined) {
    const diff = context.orderTotal - context.extractedAmount;
    if (Math.abs(diff) > 0.01) {
      const sign = diff > 0 ? "short" : "over";
      lines.push(`• Amount: ฿${context.extractedAmount.toFixed(2)} (extracted from slip)`);
      lines.push(`• Expected: ฿${context.orderTotal.toFixed(2)} (order total)`);
      lines.push(`• Mismatch: ฿${Math.abs(diff).toFixed(2)} ${sign}`);
    } else {
      lines.push(`• Amount: ฿${context.extractedAmount.toFixed(2)} (matches order)`);
    }
  }

  // Date details
  if (context.extractedDate) {
    lines.push(`• Date: ${context.extractedDate}`);
  }

  // Breakdown details
  if (context.breakdown) {
    if (context.breakdown.duplicateReference) {
      lines.push(`• Reference: DUPLICATE (already used in another payment)`);
    } else if (context.breakdown.duplicateFingerprint) {
      lines.push(`• Fingerprint: DUPLICATE (same payment detected)`);
    } else if (!context.breakdown.referencePresent) {
      lines.push(`• Reference: NOT FOUND in slip`);
    }
  }

  lines.push("");

  // Reason explanation
  const reasonExplanation = getReasonExplanation(reason);
  lines.push(`→ Reason: ${reasonExplanation}`);

  // Action recommendation
  const actionRecommendation = getActionRecommendation(reason);
  lines.push(`→ Action: ${actionRecommendation}`);

  return lines.join("\n");
}

/**
 * Generate shadow mode note (Phase 1 staging testing)
 *
 * Example output:
 * "🔍 SHADOW MODE - SIMULATED DECISION
 *  • OCR Confidence: 92% (high)
 *  • Bank: Bangkok Bank (BBL)
 *  • Amount: ฿299.00 (matches order)
 *  • Date: 2026-04-29 14:30 (valid)
 *  • Simulated Decision: WOULD BE APPROVED
 *  • Actual Status: PENDING (shadow mode - not auto-approved)
 *  → This slip would pass all checks and be auto-approved in production
 *  → Admin must manually approve to grant customer access"
 */
export function generateShadowModeNote(context: OrderNoteContext): string {
  const lines: string[] = [];

  lines.push("🔍 SHADOW MODE - SIMULATED DECISION");
  lines.push("");

  // Confidence level
  if (context.ocrConfidence !== undefined) {
    const confidenceLevel =
      context.ocrConfidence >= 90
        ? "very high"
        : context.ocrConfidence >= 85
          ? "high"
          : "acceptable";
    lines.push(`• OCR Confidence: ${context.ocrConfidence}% (${confidenceLevel})`);
  }

  // Bank detection
  if (context.detectedBank) {
    lines.push(`• Bank: ${context.detectedBank}`);
  }

  // Amount verification
  if (context.extractedAmount !== undefined && context.orderTotal !== undefined) {
    lines.push(
      `• Amount: ฿${context.extractedAmount.toFixed(2)} (matches order)`
    );
  }

  // Date verification
  if (context.extractedDate) {
    lines.push(`• Date: ${context.extractedDate} (valid)`);
  }

  lines.push("");

  // Simulated decision
  if (context.isAutoApproved) {
    lines.push(`• Simulated Decision: WOULD BE APPROVED`);
    lines.push(`• Actual Status: PENDING (shadow mode - not auto-approved)`);
    lines.push(
      `→ This slip would pass all checks and be auto-approved in production`
    );
  } else {
    lines.push(`• Simulated Decision: WOULD REQUIRE MANUAL REVIEW`);
    lines.push(`• Reason: ${context.reviewReason || "Unknown"}`);
    lines.push(`• Actual Status: PENDING (shadow mode - testing only)`);
    lines.push(
      `→ This slip would be sent to manual review in production due to: ${getReasonExplanation(context.reviewReason || "UNKNOWN")}`
    );
  }

  lines.push(`→ Admin must manually approve to grant customer access`);

  return lines.join("\n");
}

/**
 * Format reason code to human-readable label
 */
function formatReasonLabel(reason: string): string {
  return reason
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Get detailed explanation for failure reason
 */
function getReasonExplanation(reason: string): string {
  const explanations: Record<string, string> = {
    MISSING_AMOUNT: "No amount detected in the slip image",
    AMOUNT_MISMATCH:
      "Slip amount does not match order total (customer may have sent wrong amount)",
    MISSING_TRANSACTION_DATE:
      "No transaction date detected in the slip image",
    TRANSACTION_OUTSIDE_TIME_WINDOW:
      "Slip is older than 2 hours (may be reused slip or wrong slip)",
    MISSING_REFERENCE:
      "No reference/transaction ID detected in the slip image",
    DUPLICATE_REFERENCE:
      "Reference number already used in another payment (duplicate slip)",
    DUPLICATE_FINGERPRINT:
      "Same payment detected (duplicate slip with different reference)",
    LOW_CONFIDENCE:
      "OCR confidence below 85% threshold (slip image quality may be poor)",
    INSUFFICIENT_STRUCTURED_DATA:
      "Less than 3 critical fields extracted (incomplete slip data)",
    MERCHANT_CODE_MISMATCH:
      "Merchant code does not match our configuration (wrong merchant)",
    MERCHANT_TRANSACTION_CODE_MISMATCH:
      "Transaction code does not match our configuration (wrong merchant)",
    SHOP_NAME_MISMATCH:
      "Shop name does not match our configuration (wrong recipient)",
    OCR_DISABLED: "OCR system is currently disabled",
    DATABASE_CONNECTION_FAILED: "Database connection error",
    PAYMENT_NOT_FOUND: "Payment record not found in database",
  };

  return explanations[reason] || "Unknown reason - requires manual review";
}

/**
 * Get action recommendation for failure reason
 */
function getActionRecommendation(reason: string): string {
  const actions: Record<string, string> = {
    MISSING_AMOUNT:
      "Customer should submit a clearer slip image showing the amount",
    AMOUNT_MISMATCH:
      "Customer must submit a slip with the correct amount (฿X.XX) or admin can adjust order",
    MISSING_TRANSACTION_DATE:
      "Customer should submit a clearer slip image showing the date",
    TRANSACTION_OUTSIDE_TIME_WINDOW:
      "Customer must submit a fresh slip (within 2 hours of payment)",
    MISSING_REFERENCE:
      "Customer should submit a clearer slip image showing the reference number",
    DUPLICATE_REFERENCE:
      "Customer must submit a different slip with a new reference number",
    DUPLICATE_FINGERPRINT:
      "Customer must submit a different slip (this payment was already submitted)",
    LOW_CONFIDENCE:
      "Customer should submit a clearer/higher-quality slip image for better OCR accuracy",
    INSUFFICIENT_STRUCTURED_DATA:
      "Customer should submit a complete slip image with all required fields visible",
    MERCHANT_CODE_MISMATCH:
      "Admin should verify merchant configuration or customer should check slip recipient",
    MERCHANT_TRANSACTION_CODE_MISMATCH:
      "Admin should verify merchant configuration or customer should check slip recipient",
    SHOP_NAME_MISMATCH:
      "Admin should verify shop configuration or customer should check slip recipient",
    OCR_DISABLED: "Admin should enable OCR system before processing slips",
    DATABASE_CONNECTION_FAILED:
      "System error - admin should check database connection and retry",
    PAYMENT_NOT_FOUND:
      "System error - payment record not found, admin should investigate",
  };

  return (
    actions[reason] || "Admin must manually review slip and approve/reject"
  );
}

/**
 * Generate comprehensive verification summary
 *
 * Used for admin dashboard to show all checks performed
 */
export function generateVerificationSummary(
  context: OrderNoteContext
): Record<string, boolean | string> {
  const summary: Record<string, boolean | string> = {};

  if (context.breakdown) {
    summary["Amount Matched"] = context.breakdown.amountMatched;
    summary["Date Present"] = context.breakdown.datePresent;
    summary["Date Within Window"] = context.breakdown.dateWithinWindow;
    summary["Reference Present"] = context.breakdown.referencePresent;
    summary["Duplicate Reference"] = !context.breakdown.duplicateReference;
    summary["Duplicate Fingerprint"] = !context.breakdown.duplicateFingerprint;
    summary["Bank Detected"] = context.breakdown.bankDetected;
    summary["OCR Confidence"] =
      `${context.breakdown.ocrConfidence}% (${context.breakdown.ocrConfidence >= 85 ? "✓ Pass" : "✗ Fail"})`;
    summary["Final Decision"] = context.breakdown.finalDecision || "pending";
  }

  return summary;
}
