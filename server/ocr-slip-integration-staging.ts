/**
 * OCR Slip Integration - Staging Enhanced Version
 *
 * Adds shadow mode, metrics tracking, and configurable controls
 * for safe staging rollout while preserving production behavior.
 */

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
import { getOCRConfig } from "./_core/ocr-config";
import * as OCRMetrics from "./_core/ocr-metrics";

/**
 * OCR Verification Result with staging metadata
 */
export interface OCRVerificationResultStaging {
  isAutoApproved: boolean;
  isShadowMode: boolean;
  reviewReason?: string;
  extractedData?: ExtractedSlipData;
  linkedOrderId?: number;
  linkedPaymentId?: number;
  fingerprint?: string; // NEW: Add fingerprint from verification
  breakdown?: any;
  ocrConfidence?: number;
  ocrDecision?: "auto_approved" | "needs_review" | "rejected" | "ocr_disabled" | "shadow_auto_approved"; // NEW: Add OCR decision state
  detectedBank?: string;
  duplicateStatus?: {
    isDuplicateReference: boolean;
    isDuplicateFingerprint: boolean;
  };
  failureReason?: string;
  simulatedDecision?: "approved" | "pending_review";
}

/**
 * Process OCR slip verification with staging enhancements
 *
 * Supports:
 * - Shadow mode: OCR runs fully but doesn't approve (simulated decision only)
 * - Metrics tracking: Records all decisions and failure reasons
 * - Configurable thresholds: Time window, confidence, etc.
 * - Detailed logging: Optional verbose output for debugging
 */
export async function processSlipVerificationStaging(
  paymentId: number,
  slipOcrResult: ParseSlipImageResult
): Promise<OCRVerificationResultStaging> {
  const config = getOCRConfig();

  // Record metrics
  OCRMetrics.recordSlipProcessed();

  // Check if OCR is enabled
  if (!config.ocrEnabled) {
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "OCR_DISABLED",
    };
  }

  const db = await getDb();
  if (!db) {
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "DATABASE_CONNECTION_FAILED",
    };
  }

  // ── Load payment ──────────────────────────────────────────────────────────
  const paymentResult = await db
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!paymentResult.length) {
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "PAYMENT_NOT_FOUND",
    };
  }

  const payment = paymentResult[0];

  // ── Load order ────────────────────────────────────────────────────────────
  const orderResult = await db
    .select()
    .from(orders)
    .where(eq(orders.id, payment.orderId))
    .limit(1);

  if (!orderResult.length) {
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "ORDER_NOT_FOUND",
    };
  }

  const order = orderResult[0];

  // ── Extract slip data ─────────────────────────────────────────────────────
  const extracted = extractSlipData(slipOcrResult.text);

  if (!extracted || Object.keys(extracted).length === 0) {
    OCRMetrics.recordFailedExtraction();
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "EXTRACTION_FAILED",
    };
  }

  OCRMetrics.recordSuccessfulExtraction();
  if (extracted.confidence) {
    OCRMetrics.recordConfidenceLevel(extracted.confidence);
  }
  if (extracted.detectedBank) {
    OCRMetrics.recordBankDetected(extracted.detectedBank);
  }

  // ── Build order context ───────────────────────────────────────────────────
  const context: OrderPaymentContext = {
    orderId: order.id,
    paymentId: payment.id,
    orderTotal:
      typeof order.totalAmount === "string"
        ? parseFloat(order.totalAmount)
        : (order.totalAmount as number),
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
    existingFingerprints,
    config.minConfidence
  );

  // Record metrics based on verification result
  if (verificationResult.isAutoApproved) {
    OCRMetrics.recordAutoApproved();
  } else {
    OCRMetrics.recordManualReview();
    if (verificationResult.reviewReason) {
      OCRMetrics.recordFailureReason(
        verificationResult.reviewReason as any
      );
    }
  }

  // ── Determine if shadow mode or real mode ─────────────────────────────────
  const isShadowMode =
    config.ocrShadowMode || !config.ocrAutoApproveEnabled;

  if (isShadowMode && verificationResult.isAutoApproved) {
    OCRMetrics.recordShadowApproved();
    if (config.detailedLogging) {
      console.log("[OCR Shadow Mode]", {
        paymentId,
        orderId: order.id,
        decision: "approved (simulated)",
        confidence: extracted.confidence,
        bank: extracted.detectedBank,
      });
    }
  }

  // ── Build response ────────────────────────────────────────────────────────
  const response: OCRVerificationResultStaging = {
    isAutoApproved: !isShadowMode && verificationResult.isAutoApproved,
    isShadowMode,
    reviewReason: verificationResult.reviewReason,
    extractedData: extracted,
    linkedOrderId: verificationResult.linkedOrderId,
    linkedPaymentId: verificationResult.linkedPaymentId,
    fingerprint: verificationResult.fingerprint, // NEW: Add fingerprint from verification
    breakdown: verificationResult.breakdown,
    ocrConfidence: extracted.confidence,
    ocrDecision: isShadowMode
      ? "shadow_auto_approved"
      : verificationResult.isAutoApproved
        ? "auto_approved"
        : "needs_review", // NEW: Add OCR decision state
    detectedBank: extracted.detectedBank,
    duplicateStatus: {
      isDuplicateReference: verificationResult.reviewReason === "DUPLICATE_REFERENCE",
      isDuplicateFingerprint: verificationResult.reviewReason === "DUPLICATE_FINGERPRINT",
    },
    failureReason: verificationResult.reviewReason,
    simulatedDecision: verificationResult.isAutoApproved
      ? "approved"
      : "pending_review",
  };

  return response;
}

/**
 * Get OCR metrics for admin dashboard
 */
export function getOCRMetricsForAdmin() {
  return OCRMetrics.getMetricsSummary();
}

/**
 * Get detailed OCR metrics
 */
export function getOCRMetricsDetailed() {
  return OCRMetrics.getMetrics();
}

/**
 * Reset OCR metrics (admin only, for testing)
 */
export function resetOCRMetrics() {
  OCRMetrics.resetMetrics();
}
