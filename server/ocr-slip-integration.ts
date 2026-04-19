/**
 * OCR Slip Integration Layer
 * 
 * Wires new structured extractor and weighted verifier into the slip upload flow.
 * Handles:
 * - Image/PDF extraction via LLM
 * - Structured data normalization
 * - Weighted verification with critical signals
 * - Duplicate detection via fingerprints
 * - Persistence of OCR artifacts
 * - Conservative anti-fraud policy
 */

import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { extractFromSlipImage, StructuredOCRData } from "./ocr-structured-extractor";
import { verifyWithWeights, generateFingerprint, VerificationContext } from "./ocr-weighted-verifier";

export interface SlipVerificationResult {
  isAutoApproved: boolean;
  overallScore: number;
  reviewReason?: string;
  extractedData: StructuredOCRData | null;
  fingerprint: string;
  linkedOrderId: number;
  linkedPaymentId: number;
  riskLevel: "low" | "medium" | "high";
  verificationBreakdown?: any; // Signal scores for admin display
}

/**
 * Process OCR slip verification and auto-approval for a payment
 * 
 * Flow:
 * 1. Extract raw text from image/PDF via LLM
 * 2. Parse structured data (bank, amount, receiver, etc.)
 * 3. Verify against order/payment context with weighted signals
 * 4. Check for duplicates via fingerprint
 * 5. Return auto-approval decision
 */
export async function processSlipVerification(
  paymentId: number,
  slipImageUrl: string
): Promise<SlipVerificationResult> {
  const db = await getDb();
  if (!db) {
    return {
      isAutoApproved: false,
      overallScore: 0,
      reviewReason: "DATABASE_CONNECTION_FAILED",
      extractedData: null,
      fingerprint: "",
      linkedOrderId: 0,
      linkedPaymentId: paymentId,
      riskLevel: "high",
    };
  }

  // Get payment and order
  const payment = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .then((rows) => rows[0]);

  if (!payment) {
    return {
      isAutoApproved: false,
      overallScore: 0,
      reviewReason: "PAYMENT_NOT_FOUND",
      extractedData: null,
      fingerprint: "",
      linkedOrderId: 0,
      linkedPaymentId: paymentId,
      riskLevel: "high",
    };
  }

  const order = await db
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .then((rows) => rows[0]);

  if (!order) {
    return {
      isAutoApproved: false,
      overallScore: 0,
      reviewReason: "ORDER_NOT_FOUND",
      extractedData: null,
      fingerprint: "",
      linkedOrderId: payment.orderId,
      linkedPaymentId: paymentId,
      riskLevel: "high",
    };
  }

  // Check if payment is already processed
  if (payment.status === "approved" || payment.status === "rejected") {
    return {
      isAutoApproved: false,
      overallScore: 0,
      reviewReason: "PAYMENT_ALREADY_PROCESSED",
      extractedData: null,
      fingerprint: "",
      linkedOrderId: order.id,
      linkedPaymentId: paymentId,
      riskLevel: "high",
    };
  }

  // Extract structured data from slip image
  const extractedData = await extractFromSlipImage(slipImageUrl);
  if (!extractedData) {
    return {
      isAutoApproved: false,
      overallScore: 0,
      reviewReason: "OCR_EXTRACTION_FAILED",
      extractedData: null,
      fingerprint: "",
      linkedOrderId: order.id,
      linkedPaymentId: paymentId,
      riskLevel: "high",
    };
  }

  // Get existing fingerprints to check for duplicates
  const existingPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "approved"));

  const existingFingerprints = new Set<string>();
  for (const p of existingPayments) {
    if (p.fingerprint) {
      existingFingerprints.add(p.fingerprint);
    }
  }

  // Create verification context
  const verificationContext: VerificationContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal: parseFloat(order.totalAmount.toString()),
    orderCreatedAt: order.createdAt,
    paymentCreatedAt: payment.createdAt,
    slipSubmittedAt: payment.slipSubmittedAt || new Date(),
    merchantName: "Ipe Novel Shop", // Configured merchant name
    merchantCode: "KB000002283068", // Optional: configured merchant code
    receiverAccountMasked: "XXXX-XXXX-5678", // Optional: expected account
  };

  // Perform weighted verification
  const verificationResult = verifyWithWeights(extractedData, verificationContext, existingFingerprints);

  // Generate fingerprint for duplicate detection
  const fingerprint = generateFingerprint(
    extractedData.amount,
    extractedData.transactionDateTime,
    extractedData.referenceId,
    extractedData.transactionId,
    extractedData.bankName || undefined
  );

  return {
    isAutoApproved: verificationResult.isAutoApproved,
    overallScore: verificationResult.overallScore,
    reviewReason: verificationResult.reviewReason,
    extractedData,
    fingerprint,
    linkedOrderId: order.id,
    linkedPaymentId: paymentId,
    riskLevel: verificationResult.riskLevel,
    verificationBreakdown: verificationResult.signals, // For admin display
  };
}

/**
 * Get all approved payment fingerprints for duplicate detection
 */
export async function getApprovedFingerprints(): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();

  const approvedPayments = await db
    .select()
    .from(payments)
    .where(eq(payments.status, "approved"));

  const fingerprints = new Set<string>();
  for (const p of approvedPayments) {
    if (p.fingerprint) {
      fingerprints.add(p.fingerprint);
    }
  }

  return fingerprints;
}

/**
 * Check if a fingerprint already exists in approved payments
 */
export async function isDuplicateFingerprint(fingerprint: string): Promise<boolean> {
  const fingerprints = await getApprovedFingerprints();
  return fingerprints.has(fingerprint);
}
