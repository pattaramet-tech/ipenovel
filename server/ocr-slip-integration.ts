import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  processSlipVerification as verifySlipOCR,
  ExtractedSlipData,
  OrderPaymentContext,
  VerificationResult,
  parseSlipImage,
} from "./ocr-slip-verification";

/**
 * Process OCR slip verification and auto-approval for a payment
 * This is called when a slip is uploaded for a payment
 */
export async function processSlipVerification(
  paymentId: number,
  slipImageUrl: string
): Promise<{
  isAutoApproved: boolean;
  reviewReason?: string;
  extractedData?: ExtractedSlipData;
  linkedOrderId?: number;
  linkedPaymentId?: number;
  fingerprint?: string;
}> {
  // Get the payment and order details
  const db = await getDb();
  if (!db) {
    return {
      isAutoApproved: false,
      reviewReason: "DATABASE_CONNECTION_FAILED",
    };
  }

  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .then(rows => rows[0]);

  if (!payment) {
    return {
      isAutoApproved: false,
      reviewReason: "PAYMENT_NOT_FOUND",
    };
  }

  const order = await db
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .then(rows => rows[0]);

  if (!order) {
    return {
      isAutoApproved: false,
      reviewReason: "ORDER_NOT_FOUND",
    };
  }

  // Check if payment is already processed
  if (payment.status === "approved" || payment.status === "rejected") {
    return {
      isAutoApproved: false,
      reviewReason: "PAYMENT_ALREADY_PROCESSED",
    };
  }

  // Get all existing references to check for duplicates
  const existingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "approved"));

  const existingReferences = new Set<string>();
  for (const p of existingPayments) {
    if (p.extractedData) {
      try {
        const data = JSON.parse(p.extractedData);
        if (data.reference) {
          existingReferences.add(data.reference);
        }
      } catch {
        // Skip invalid JSON
      }
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

  // Process slip verification (parse image, extract data, verify)
  const verificationResult = await verifySlipOCR(
    slipImageUrl,
    context,
    existingReferences
  );

  return {
    isAutoApproved: verificationResult.isAutoApproved,
    reviewReason: verificationResult.reviewReason,
    extractedData: verificationResult.extractedData,
    linkedOrderId: verificationResult.linkedOrderId,
    linkedPaymentId: verificationResult.linkedPaymentId,
    fingerprint: verificationResult.fingerprint,
  };
}
