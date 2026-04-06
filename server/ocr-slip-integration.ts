import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  ExtractedSlipData,
  OrderPaymentContext,
  VerificationResult,
} from "./ocr-slip-verification";

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

  // Get all existing references to check for duplicates
  const existingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "approved"));

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
  for (const data of extractedDataArray) {
    if (data.reference) {
      existingReferences.add(data.reference);
    }
  }

  // Create order/payment context for verification
  const context: OrderPaymentContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal: parseFloat(order.totalAmount.toString()),
    orderCreatedAt: order.createdAt,
    paymentCreatedAt: payment.createdAt,
  };

  // Verify the slip data against the order/payment
  const verificationResult = verifySlipData(
    extractedData,
    context,
    existingReferences
  );

  // Generate fingerprint for duplicate detection
  const fingerprint = generateFingerprint(extractedData);

  // Determine if we should auto-approve
  const shouldAutoApprove =
    verificationResult.isAutoApproved &&
    (extractedData.confidence ?? 0) >= 85;

  // Update payment with verification results
  await db
    .update(payments)
    .set({
      extractedData: JSON.stringify(extractedData),
      reviewReason: verificationResult.reviewReason,
      fingerprint,
      linkedOrderId: verificationResult.linkedOrderId,
      linkedPaymentId: verificationResult.linkedPaymentId,
      status: shouldAutoApprove ? "approved" : "pending_review",
      autoApprovedAt: shouldAutoApprove ? new Date() : null,
      reviewedAt: shouldAutoApprove ? new Date() : null,
      reviewedByUserId: shouldAutoApprove ? 0 : null, // 0 indicates auto-approval
      updatedAt: new Date(),
    })
    .where(eq(payments.id, paymentId));

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
    LOW_CONFIDENCE: "OCR confidence too low for auto-approval",
    TRANSACTION_OUTSIDE_TIME_WINDOW:
      "Transaction date outside acceptable time window",
    PAYMENT_NOT_FOUND: "Payment record not found",
    ORDER_NOT_FOUND: "Order record not found",
    PAYMENT_ALREADY_PROCESSED: "Payment already approved or rejected",
  };

  return descriptions[reason || ""] || "Unknown reason";
}
