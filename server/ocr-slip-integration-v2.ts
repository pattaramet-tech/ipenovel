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
  ParseSlipImageResult,
} from "./ocr-slip-verification-v2";
import { ApprovalService } from "./services/approvalService";

/**
 * Process OCR slip verification and auto-approval for a payment (v2 with improvements).
 * Called when a slip image has been OCR-parsed and the text is ready.
 */
export async function processSlipVerification(
  paymentId: number,
  slipOcrResult: ParseSlipImageResult
): Promise<{
  isAutoApproved: boolean;
  reviewReason?: string;
  extractedData?: ExtractedSlipData;
  linkedOrderId?: number;
  linkedPaymentId?: number;
  breakdown?: any;
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

  // ── Extract slip data ─────────────────────────────────────────────────────
  const extracted = extractSlipData(slipOcrResult.text);

  // ── Build order context ────────────────────────────────────────
  const context: OrderPaymentContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal: typeof order.totalAmount === "string" ? parseFloat(order.totalAmount) : (order.totalAmount as number),
    orderCreatedAt: order.createdAt,
    paymentCreatedAt: payment.createdAt,
  };

  // ── Load existing references and fingerprints for duplicate detection ─────
  const existingPayments = await db
    .select({
      id: payments.id,
      status: payments.status,
      extractedData: payments.extractedData,
      fingerprint: payments.fingerprint,
    })
    .from(payments)
    .where(or(eq(payments.status, "approved"), eq(payments.status, "pending_review")))
    .limit(1000);

  const existingReferences = new Set<string>();
  const existingFingerprints = new Set<string>();

  for (const p of existingPayments) {
    if (p.extractedData) {
      try {
        const prevData = JSON.parse(p.extractedData);
        if (prevData.reference) {
          existingReferences.add(prevData.reference);
        }
      } catch (e) {
        // Skip malformed JSON
      }
    }
    if (p.fingerprint) {
      existingFingerprints.add(p.fingerprint);
    }
  }

  // ── Verify slip data ──────────────────────────────────────────────────────
  const verificationResult = verifySlipData(
    extracted,
    context,
    existingReferences,
    existingFingerprints
  );

  // ── Update payment status based on verification result ────────────────────
  const db2 = await getDb();
  if (db2) {
    if (verificationResult.isAutoApproved) {
      // Auto-approved: update payment status
      await db2
        .update(payments)
        .set({
          status: "approved",
          extractedData: JSON.stringify(extracted),
          fingerprint: verificationResult.fingerprint,
          autoApprovedAt: new Date(),
          approvalSource: "auto",
          approvedByLabel: "OCR Auto-Approval",
          approvedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));
    } else {
      // Pending review: update payment status
      await db2
        .update(payments)
        .set({
          status: "pending_review",
          extractedData: JSON.stringify(extracted),
          fingerprint: verificationResult.fingerprint,
          reviewReason: verificationResult.reviewReason,
          approvalSource: "manual",
        })
        .where(eq(payments.id, payment.id));
    }
  }

  // ── Store verification breakdown for admin visibility ────────────────────
  const breakdownData = verificationResult.breakdown;

  return {
    isAutoApproved: verificationResult.isAutoApproved,
    reviewReason: verificationResult.reviewReason,
    extractedData: verificationResult.extractedData,
    linkedOrderId: verificationResult.linkedOrderId,
    linkedPaymentId: verificationResult.linkedPaymentId,
    breakdown: breakdownData,
  };
}
