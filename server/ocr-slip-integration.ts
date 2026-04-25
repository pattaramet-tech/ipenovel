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
 * Process OCR slip verification and auto-approval for a payment
 * This is called when a slip is uploaded for a payment
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
  // Get the payment and order details
  const db = await getDb();
  if (!db) {
    return {
      isAutoApproved: false,
      reviewReason: "DATABASE_CONNECTION_FAILED",
    };
  }

  const paymentResult = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!paymentResult.length) {
    return {
      isAutoApproved: false,
      reviewReason: "PAYMENT_NOT_FOUND",
    };
  }

  const payment = paymentResult[0];

  // Get the order details
  const orderResult = await db
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1);

  if (!orderResult.length) {
    return {
      isAutoApproved: false,
      reviewReason: "ORDER_NOT_FOUND",
    };
  }

  const order = orderResult[0];

  if (!order) {
    return {
      isAutoApproved: false,
      reviewReason: "ORDER_NOT_FOUND",
    };
  }

  // Check if payment is still pending
  if (payment.status !== "pending") {
    return {
      isAutoApproved: false,
      reviewReason: "PAYMENT_ALREADY_PROCESSED",
    };
  }

  // Extract slip data using OCR
  const extractedData = extractSlipData(slipOcrText);

  // Get all existing references and fingerprints for duplicate detection
  // Include both approved AND pending_review to prevent race-condition duplicates
  const existingPayments = await db
    .select()
    .from(payments)
    .where(or(
      eq(payments.status, "approved"),
      eq(payments.status, "pending_review")
    ));

  const extractedDataArray = existingPayments
    .map(p => {
      try {
        return p.extractedData ? JSON.parse(p.extractedData) : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const existingReferences = new Set<string>();
  const existingFingerprints = new Set<string>();

  for (const data of extractedDataArray) {
    if (data.reference) {
      existingReferences.add(data.reference);
    }
  }

  for (const payment of existingPayments) {
    if (payment.fingerprint) {
      existingFingerprints.add(payment.fingerprint);
    }
  }

  // Log duplicate detection setup
  console.log(`[OCR-DUPLICATE-CHECK] Found ${existingReferences.size} existing references and ${existingFingerprints.size} existing fingerprints`);

  // Create order/payment context for verification
  const context: OrderPaymentContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal: parseFloat(order.totalAmount.toString()),
    orderCreatedAt: order.createdAt,
    paymentCreatedAt: payment.createdAt,
  };

  // Verify the slip data against the order/payment
  // Pass both reference and fingerprint sets for duplicate detection
  const verificationResult = verifySlipData(
    extractedData,
    context,
    existingReferences,
    existingFingerprints
  );

  // Generate fingerprint for duplicate detection
  const fingerprint = generateFingerprint(extractedData);

  // Determine if we should auto-approve
  // Note: verifySlipData already validates confidence >= 85,
  // but we check again here as defense-in-depth for auto-approval safety
  const shouldAutoApprove =
    verificationResult.isAutoApproved &&
    (extractedData.confidence ?? 0) >= 85;

  // Log auto-approval decisions for audit trail (safe fields only)
  if (shouldAutoApprove) {
    const maskedRef = extractedData.reference
      ? extractedData.reference.substring(0, 4) + "***" + extractedData.reference.substring(extractedData.reference.length - 2)
      : "N/A";
    console.log(`[OCR-AUTO-APPROVE] Payment ${paymentId}:`, {
      paymentId,
      orderId: order.id,
      amount: extractedData.amount,
      reference: maskedRef,
      confidence: extractedData.confidence,
      detectedBank: extractedData.detectedBank,
      timestamp: new Date().toISOString(),
    });
  }

  // Update payment with verification results
  if (shouldAutoApprove) {
    // Use ApprovalService for OCR auto-approval with metadata
    const now = new Date();
    await ApprovalService.approvePaymentWithSource(paymentId, "auto", {
      autoApprovedAt: now,
    });
    
    // Also update OCR-specific fields
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
    // Send to pending review
    await ApprovalService.sendToReview(
      paymentId,
      verificationResult.reviewReason || "MANUAL_REVIEW_REQUIRED",
      extractedData,
      fingerprint
    );
    
    // Update linked order/payment info
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

/**
 * Get all pending_review payments with extracted data for admin review
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
 * Get review reason description for admin display
 */
export function getReviewReasonDescription(reason?: string): string {
  const descriptions: Record<string, string> = {
    MISSING_SHOP_NAME: "Shop name not found in slip",
    MISSING_MERCHANT_CODE: "Merchant code not found in slip",
    MISSING_AMOUNT: "Payment amount not found in slip",
    MISSING_REFERENCE: "Transaction reference not found in slip",
    SHOP_NAME_MISMATCH: "Shop name does not match Ipe Novel",
    MERCHANT_CODE_MISMATCH: "Merchant code does not match KB000002283068",
    MERCHANT_TRANSACTION_CODE_MISMATCH:
      "Merchant transaction code does not match KPS004KB000002283068",
    AMOUNT_MISMATCH: "Slip amount does not match order total",
    DUPLICATE_REFERENCE: "Transaction reference already used",
    DUPLICATE_FINGERPRINT: "Identical slip already submitted",
    LOW_CONFIDENCE: "OCR confidence too low for auto-approval",
    TRANSACTION_OUTSIDE_TIME_WINDOW:
      "Transaction date outside acceptable time window",
    PAYMENT_NOT_FOUND: "Payment record not found",
    ORDER_NOT_FOUND: "Order record not found",
    PAYMENT_ALREADY_PROCESSED: "Payment already approved or rejected",
  };

  return descriptions[reason || ""] || "Unknown reason";
}

/**
 * Get enhanced pending review payments with all fields needed for admin review
 */
export async function getPendingReviewPaymentsForAdmin() {
  const db = await getDb();
  if (!db) return [];

  const pendingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "pending_review"));

  return pendingPayments.map((p: any) => {
    const extracted = p.extractedData ? JSON.parse(p.extractedData) : null;
    
    return {
      id: p.id,
      orderId: p.orderId,
      status: p.status,
      reviewReason: p.reviewReason,
      reviewReasonDescription: getReviewReasonDescription(p.reviewReason),
      
      // Extracted data for admin review
      extractedBank: extracted?.detectedBank,
      extractedAmount: extracted?.amount,
      extractedReference: extracted?.reference,
      extractedDate: extracted?.transactionDate,
      extractedShopName: extracted?.shopName,
      extractedMerchantCode: extracted?.merchantCode,
      extractedConfidence: extracted?.confidence,
      
      // Fingerprint and duplicate status
      fingerprint: p.fingerprint,
      linkedOrderId: p.linkedOrderId,
      linkedPaymentId: p.linkedPaymentId,
      
      // Metadata
      slipImageUrl: p.slipImageUrl,
      slipSubmittedAt: p.slipSubmittedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  });
}
