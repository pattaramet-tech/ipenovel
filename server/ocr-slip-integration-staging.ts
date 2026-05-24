/**
 * OCR Slip Integration - Staging Enhanced Version
 *
 * Adds shadow mode, metrics tracking, and configurable controls
 * for safe staging rollout while preserving production behavior.
 */

import crypto from "crypto";
import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq, or, and, ne, sql } from "drizzle-orm";
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
import { getEffectiveOCRConfig } from "./_core/ocr-effective-config";
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
  ocrDecision?: "auto_approved" | "needs_review" | "rejected" | "ocr_disabled" | "shadow_auto_approved" | "ocr_processing_error"; // NEW: Add OCR decision state
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
  const config = await getEffectiveOCRConfig();

  // Record metrics
  OCRMetrics.recordSlipProcessed();

  // Check if OCR is enabled
  if (!config.enabled) {
    return {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "OCR_DISABLED",
      ocrConfidence: 0,
      ocrDecision: "ocr_disabled",
      fingerprint: undefined,
      duplicateStatus: {
        isDuplicateReference: false,
        isDuplicateFingerprint: false,
      },
      breakdown: { reason: "OCR processing is disabled by effective config" },
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
  const extracted = extractSlipData(slipOcrResult.text, slipOcrResult.ocrConfidence);

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
    slipSubmittedAt: payment.slipSubmittedAt ?? payment.createdAt,
  };

  // ── Helper: Check duplicate fingerprint directly in database ────────────────
  const checkDuplicateFingerprint = async (fingerprint: string | undefined): Promise<{ isDuplicate: boolean; duplicatePaymentId?: string }> => {
    if (!fingerprint) return { isDuplicate: false };
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          ne(payments.id, paymentId),
          or(eq(payments.status, "approved"), eq(payments.status, "pending_review")),
          eq(payments.fingerprint, fingerprint)
        )
      )
      .limit(1);
    return {
      isDuplicate: existing.length > 0,
      duplicatePaymentId: existing[0]?.id ? String(existing[0].id) : undefined,
    };
  };

  // ── Helper: Check duplicate reference directly in database ──────────────────
  const checkDuplicateReference = async (reference: string | undefined): Promise<{ isDuplicate: boolean; duplicatePaymentId?: string }> => {
    if (!reference) return { isDuplicate: false };
    // For MySQL/TiDB, use JSON_EXTRACT to search within extractedData
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          ne(payments.id, paymentId),
          or(eq(payments.status, "approved"), eq(payments.status, "pending_review")),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${payments.extractedData}, '$.reference')) = ${reference.toUpperCase()}`
        )
      )
      .limit(1);
    return {
      isDuplicate: existing.length > 0,
      duplicatePaymentId: existing[0]?.id ? String(existing[0].id) : undefined,
    };
  };

  // ── Helper: Check legacy fingerprints for backward compatibility ──────────────
  const checkLegacyFingerprints = async (extracted: any): Promise<{ isDuplicate: boolean; duplicatePaymentId?: string }> => {
    if (!extracted.detectedBank || !extracted.maskedAccount || !extracted.amount) {
      return { isDuplicate: false };
    }

    // Legacy fingerprint: bank + maskedAccount + amount + date
    const legacyKey = `${extracted.detectedBank}|${extracted.maskedAccount}|${extracted.amount}|${
      extracted.transactionDate ? extracted.transactionDate.toISOString().split("T")[0] : ""
    }`;
    const legacyFingerprint = crypto
      .createHash("sha256")
      .update(legacyKey)
      .digest("hex");

    // Weak legacy fingerprint: bank + maskedAccount + amount (no date)
    const weakKey = `${extracted.detectedBank}|${extracted.maskedAccount}|${extracted.amount}`;
    const weakFingerprint = crypto
      .createHash("sha256")
      .update(weakKey)
      .digest("hex");

    // Check both legacy fingerprints
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          ne(payments.id, paymentId),
          or(eq(payments.status, "approved"), eq(payments.status, "pending_review")),
          or(
            eq(payments.fingerprint, legacyFingerprint),
            eq(payments.fingerprint, weakFingerprint)
          )
        )
      )
      .limit(1);

    return {
      isDuplicate: existing.length > 0,
      duplicatePaymentId: existing[0]?.id ? String(existing[0].id) : undefined,
    };
  };

  // ── Generate fingerprint for current slip ───────────────────────────────
  const currentFingerprint = generateFingerprint(extracted);

  // ── Check for duplicates using database queries (no limit) ──────────────────
  const duplicateFingerprint = await checkDuplicateFingerprint(currentFingerprint);
  const duplicateReference = await checkDuplicateReference(extracted.reference);
  const legacyDuplicate = await checkLegacyFingerprints(extracted);

  // ── Create Sets for backward compatibility with verifySlipData ───────────────
  const existingReferences = duplicateReference.isDuplicate && extracted.reference ? new Set([extracted.reference]) : new Set<string>();
  const existingFingerprints = new Set<string>();
  if (duplicateFingerprint.isDuplicate && currentFingerprint) existingFingerprints.add(currentFingerprint);
  if (legacyDuplicate.isDuplicate && currentFingerprint) existingFingerprints.add(currentFingerprint); // Prevent auto-approval if legacy duplicate found

   // ── Verify slip data ─────────────────────────────────────────────────────
  const verificationResult = verifySlipData(
    extracted,
    context,
    existingReferences,
    existingFingerprints,
    config.minConfidence,
    config.maxTimeWindowMinutes
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
    config.shadowModeEnabled || !config.autoApproveEnabled;

  if (isShadowMode && verificationResult.isAutoApproved) {
    OCRMetrics.recordShadowApproved();
    if (false) { // detailedLogging not in EffectiveOCRConfig, use getOCRConfig() if needed
      console.log("[OCR Shadow Mode]", {
        paymentId,
        orderId: order.id,
        decision: "approved (simulated)",
        confidence: extracted.confidence,
        bank: extracted.detectedBank,
      });
    }
  }

  // ── Enrich extracted data with duplicate payment IDs ──────────────────────
  const duplicateStatus = {
    isDuplicateReference: duplicateReference.isDuplicate,
    isDuplicateFingerprint: duplicateFingerprint.isDuplicate,
    duplicateReferencePaymentId: duplicateReference.duplicatePaymentId,
    duplicateFingerprintPaymentId: duplicateFingerprint.duplicatePaymentId,
    duplicatePaymentId:
      duplicateReference.duplicatePaymentId ||
      duplicateFingerprint.duplicatePaymentId ||
      undefined,
  };

  const enrichedExtractedData = {
    ...extracted,
    duplicateStatus,
    duplicatePaymentId: duplicateStatus.duplicatePaymentId ? Number(duplicateStatus.duplicatePaymentId) : undefined,
    duplicateReferencePaymentId: duplicateStatus.duplicateReferencePaymentId ? Number(duplicateStatus.duplicateReferencePaymentId) : undefined,
    duplicateFingerprintPaymentId: duplicateStatus.duplicateFingerprintPaymentId ? Number(duplicateStatus.duplicateFingerprintPaymentId) : undefined,
  };

  // ── Build response ────────────────────────────────────────────────────────
  const response: OCRVerificationResultStaging = {
    isAutoApproved: !isShadowMode && verificationResult.isAutoApproved,
    isShadowMode,
    reviewReason: verificationResult.reviewReason,
    extractedData: enrichedExtractedData,
    linkedOrderId: verificationResult.linkedOrderId,
    linkedPaymentId: verificationResult.linkedPaymentId,
    fingerprint: verificationResult.fingerprint, // NEW: Add fingerprint from verification
    breakdown: verificationResult.breakdown,
    ocrConfidence: extracted.confidence,
    ocrDecision: isShadowMode && verificationResult.isAutoApproved
      ? "shadow_auto_approved"
      : verificationResult.isAutoApproved
        ? "auto_approved"
        : "needs_review",
    detectedBank: extracted.detectedBank,
    duplicateStatus,
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
