import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq, or } from "drizzle-orm";
import {
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  ExtractedSlipData,
  OrderPaymentContext,
  VerificationResult,
} from "./ocr-slip-verification";
import { ApprovalService } from "./services/approvalService";

/**
 * Process OCR slip verification and auto-approval for a payment.
 * Called when a slip image has been OCR-parsed and the text is ready.
 */
export async function processSlipVerification(
  paymentId: number,
  slipOcrText: string
): Promise<{
  isAutoApproved: boolean;
  reviewReason?: string;
  extractedData?: ExtractedSlipData;
  linkedOrderId?: number;
  linkedPaymentId?: number;
}> {
  const db = await getDb();
  if (!db) {
    return { isAutoApproved: false, reviewReason: "DATABASE_CONNECTION_FAILED" };
  }

  // ── Load payment ──────────────────────────────────────────────────────────
  const paymentResult = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!paymentResult.length) {
    return { isAutoApproved: false, reviewReason: "PAYMENT_NOT_FOUND" };
  }
  const payment = paymentResult[0];

  // ── Load order ────────────────────────────────────────────────────────────
  const orderResult = await db
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1);

  if (!orderResult.length) {
    return { isAutoApproved: false, reviewReason: "ORDER_NOT_FOUND" };
  }
  const order = orderResult[0];

  // ── Guard: payment must still be pending ──────────────────────────────────
  if (payment.status !== "pending") {
    return { isAutoApproved: false, reviewReason: "PAYMENT_ALREADY_PROCESSED" };
  }

  // ── Extract slip data ─────────────────────────────────────────────────────
  const extractedData = extractSlipData(slipOcrText);

  // ── Build duplicate sets (approved + pending_review) ──────────────────────
  // Include pending_review to block race-condition re-submissions
  const existingPayments = await db
    .select()
    .from(payments)
    .where(or(eq(payments.status, "approved"), eq(payments.status, "pending_review")));

  const existingReferences = new Set<string>();
  const existingFingerprints = new Set<string>();

  for (const p of existingPayments) {
    // Collect references from stored extractedData JSON
    try {
      if (p.extractedData) {
        const d = JSON.parse(p.extractedData);
        if (d?.reference) existingReferences.add(d.reference);
      }
    } catch {
      // ignore malformed JSON
    }
    // Collect fingerprints from dedicated column
    if (p.fingerprint) existingFingerprints.add(p.fingerprint);
  }

  console.log(
    `[OCR-DUPLICATE-CHECK] paymentId=${paymentId} ` +
    `existingRefs=${existingReferences.size} existingFPs=${existingFingerprints.size}`
  );

  // ── Build context ─────────────────────────────────────────────────────────
  const context: OrderPaymentContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal: parseFloat(order.totalAmount.toString()),
    orderCreatedAt: order.createdAt,
    paymentCreatedAt: payment.createdAt,
  };

  // ── Verify ────────────────────────────────────────────────────────────────
  const verificationResult = verifySlipData(
    extractedData,
    context,
    existingReferences,
    existingFingerprints
  );

  // Generate fingerprint (verifySlipData also computes it, but we keep it here
  // as the canonical value written to the DB)
  const fingerprint = generateFingerprint(extractedData);

  // Defense-in-depth: double-check confidence even if verifySlipData passed
  const shouldAutoApprove =
    verificationResult.isAutoApproved &&
    (extractedData.confidence ?? 0) >= 85;

  // ── Audit log ─────────────────────────────────────────────────────────────
  if (shouldAutoApprove) {
    const maskedRef = extractedData.reference
      ? extractedData.reference.substring(0, 4) +
        "***" +
        extractedData.reference.slice(-2)
      : "N/A";
    console.log(`[OCR-AUTO-APPROVE] paymentId=${paymentId}`, {
      orderId: order.id,
      amount: extractedData.amount,
      reference: maskedRef,
      confidence: extractedData.confidence,
      detectedBank: extractedData.detectedBank,
      detectedBankName: extractedData.detectedBankName,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.log(
      `[OCR-MANUAL-REVIEW] paymentId=${paymentId} reason=${verificationResult.reviewReason} ` +
      `confidence=${extractedData.confidence}`
    );
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  if (shouldAutoApprove) {
    await ApprovalService.approvePaymentWithSource(paymentId, "auto", {
      autoApprovedAt: new Date(),
    });
    await db
      .update(payments)
      .set({
        extractedData: JSON.stringify(extractedData),
        reviewReason: verificationResult.reviewReason,
        fingerprint,
        linkedOrderId: verificationResult.linkedOrderId,
        linkedPaymentId: verificationResult.linkedPaymentId,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId));
  } else {
    await ApprovalService.sendToReview(
      paymentId,
      verificationResult.reviewReason || "MANUAL_REVIEW_REQUIRED",
      extractedData,
      fingerprint
    );
    await db
      .update(payments)
      .set({
        linkedOrderId: verificationResult.linkedOrderId,
        linkedPaymentId: verificationResult.linkedPaymentId,
        updatedAt: new Date(),
      })
      .where(eq(payments.id, paymentId));
  }

  return {
    isAutoApproved: shouldAutoApprove,
    reviewReason: verificationResult.reviewReason,
    extractedData,
    linkedOrderId: verificationResult.linkedOrderId,
    linkedPaymentId: verificationResult.linkedPaymentId,
  };
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

/**
 * Get all pending_review payments with parsed extractedData (basic).
 */
export async function getPendingReviewPayments() {
  const db = await getDb();
  if (!db) return [];

  const pendingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "pending_review"));

  return pendingPayments.map((p: any) => ({
    ...p,
    extractedData: p.extractedData ? JSON.parse(p.extractedData) : null,
  }));
}

/**
 * Human-readable descriptions for every review reason code.
 * Used in admin UI and notification messages.
 */
export function getReviewReasonDescription(reason?: string): string {
  const descriptions: Record<string, string> = {
    // Critical extraction failures
    MISSING_AMOUNT: "Payment amount not found in slip",
    MISSING_TRANSACTION_DATE: "Transaction date not found in slip",
    MISSING_REFERENCE: "Transaction reference not found in slip",
    // Mismatch failures
    AMOUNT_MISMATCH: "Slip amount does not match order total",
    TRANSACTION_OUTSIDE_TIME_WINDOW: "Transaction date is outside the acceptable 24-hour window",
    MERCHANT_CODE_MISMATCH: "Merchant code in slip does not match KB000002283068",
    MERCHANT_TRANSACTION_CODE_MISMATCH: "Merchant transaction code does not match KPS004KB000002283068",
    SHOP_NAME_MISMATCH: "Shop name in slip does not match Ipe Novel",
    // Duplicate protection
    DUPLICATE_REFERENCE: "Transaction reference has already been used",
    DUPLICATE_FINGERPRINT: "An identical slip has already been submitted",
    // Quality gates
    LOW_CONFIDENCE: "OCR confidence is too low for automatic approval (< 85)",
    INSUFFICIENT_STRUCTURED_DATA: "Slip does not contain enough structured fields for auto-approval",
    // Legacy / system codes
    MISSING_SHOP_NAME: "Shop name not found in slip (legacy)",
    MISSING_MERCHANT_CODE: "Merchant code not found in slip (legacy)",
    // Infrastructure
    PAYMENT_NOT_FOUND: "Payment record not found",
    ORDER_NOT_FOUND: "Order record not found",
    PAYMENT_ALREADY_PROCESSED: "Payment has already been approved or rejected",
    DATABASE_CONNECTION_FAILED: "Database connection failed during OCR processing",
    MANUAL_REVIEW_REQUIRED: "Sent to manual review",
  };

  return descriptions[reason ?? ""] ?? `Unknown reason: ${reason ?? "none"}`;
}

/**
 * Enhanced admin review payload — includes all OCR fields and human-readable
 * reason descriptions so staff can understand why a slip was flagged.
 */
export async function getPendingReviewPaymentsForAdmin() {
  const db = await getDb();
  if (!db) return [];

  const pendingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "pending_review"));

  return pendingPayments.map((p: any) => {
    let extracted: ExtractedSlipData | null = null;
    try {
      extracted = p.extractedData ? JSON.parse(p.extractedData) : null;
    } catch {
      extracted = null;
    }

    return {
      // Core payment record
      id: p.id,
      orderId: p.orderId,
      status: p.status,
      approvalSource: p.approvalSource,

      // Review reason (code + human description)
      reviewReason: p.reviewReason,
      reviewReasonDescription: getReviewReasonDescription(p.reviewReason),

      // Extracted OCR fields for admin inspection
      extractedBank: extracted?.detectedBank,
      extractedBankName: extracted?.detectedBankName,
      extractedAmount: extracted?.amount,
      extractedReference: extracted?.reference,
      extractedDate: extracted?.transactionDate,
      extractedDateTime: extracted?.transactionDateTime,
      extractedShopName: extracted?.shopName,
      extractedReceiverName: extracted?.receiverName,
      extractedMaskedAccount: extracted?.maskedAccount,
      extractedMerchantCode: extracted?.merchantCode,
      extractedMerchantTransactionCode: extracted?.merchantTransactionCode,
      extractedConfidence: extracted?.confidence,

      // Duplicate detection
      fingerprint: p.fingerprint,
      linkedOrderId: p.linkedOrderId,
      linkedPaymentId: p.linkedPaymentId,

      // Approval metadata
      approvedBy: p.approvedBy,
      approvedAt: p.approvedAt,
      autoApprovedAt: p.autoApprovedAt,
      reviewedAt: p.reviewedAt,

      // Slip image and timestamps
      slipImageUrl: p.slipImageUrl,
      slipSubmittedAt: p.slipSubmittedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}
