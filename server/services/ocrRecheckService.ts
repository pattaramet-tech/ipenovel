/**
 * Admin "Recheck OCR" for an order payment.
 *
 * PURPOSE: re-run OCR + verification against the slip already on file and
 * report what happened. Nothing else.
 *
 * HARD GUARANTEES (enforced by tests in ocrPaymentPolicy.test.ts and
 * ocrRecheckService.test.ts):
 *   - NEVER approves. Not even when every check passes.
 *   - NEVER rejects. Rejection is an admin action, and this is not one.
 *   - NEVER mutates payment.status or the order's status.
 *   - NEVER touches slipSubmittedAt. That timestamp is evidence of when the
 *     customer actually submitted, and the freshness window is measured from
 *     it - rewriting it would silently make a stale slip look fresh, which
 *     is why the user submission flow is not reused here.
 *
 * When verification passes, the result reports readyForAdminApproval so the
 * UI can say "Ready for Admin Approval" and the admin can then press Approve,
 * which runs its own independent server-side anti-replay claim.
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { extractSlipData, parseSlipImage, verifySlipData } from "../ocr-slip-verification-v2";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import {
  describeProviderFailure,
  summarizeRootCause,
  type OcrDiagnosticCategory,
  type ProviderDiagnostic,
} from "./ocrDiagnosticsService";
import {
  deriveStrongIdentifiersFromExtractedData,
  hasStrongIdentifier,
} from "./slipIdentifierService";
import { recordOcrAttempt } from "./ocrAttemptService";

export interface RecheckOcrInput {
  paymentId: number;
  adminUserId: number;
}

export interface RecheckOcrResult {
  paymentId: number;
  orderId: number;
  /** Always unchanged by this operation. Echoed so the UI can prove it. */
  paymentStatus: string;
  attemptNo: number;
  verificationPassed: boolean;
  /** True only when verification passed AND a strong identifier exists. */
  readyForAdminApproval: boolean;
  reviewReason?: string;
  category: OcrDiagnosticCategory;
  rootCauseSummary: string;
  providerDiagnostic?: ProviderDiagnostic;
  ocrConfidence?: number;
  confidenceKnown: boolean;
  hasStrongIdentifier: boolean;
}

export async function recheckOrderPaymentOcr(
  input: RecheckOcrInput
): Promise<RecheckOcrResult> {
  const startedAt = new Date();

  const payment = await db.getPaymentById(input.paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
  }

  const order = await db.getOrderById(payment.orderId);
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Order not found for this payment" });
  }

  if (!payment.slipImageUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This payment has no slip image to recheck",
    });
  }

  // A finalized payment is not rechecked. Re-running OCR against an approved
  // or rejected payment could only mislead - the money decision is already
  // made and this endpoint is explicitly unable to change it.
  if (payment.status === "approved" || payment.status === "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot recheck a ${payment.status} payment. The payment is already finalized.`,
    });
  }

  const config = await getEffectiveOCRConfig();
  if (!config.enabled) {
    const summary = summarizeRootCause({ reviewReason: "OCR_DISABLED" });
    const attemptNo = await recordOcrAttempt({
      subjectType: "order_payment",
      subjectId: payment.id,
      trigger: "admin_recheck",
      initiatedByUserId: input.adminUserId,
      startedAt,
      stage: "image_preparation",
      result: "config_blocked",
      reviewCategory: "CONFIG",
      reviewReason: "OCR_DISABLED",
      providerAttemptCount: 0,
    });

    return {
      paymentId: payment.id,
      orderId: order.id,
      paymentStatus: payment.status,
      attemptNo,
      verificationPassed: false,
      readyForAdminApproval: false,
      reviewReason: "OCR_DISABLED",
      category: "CONFIG",
      rootCauseSummary: summary.summary,
      confidenceKnown: false,
      hasStrongIdentifier: false,
    };
  }

  // ── Run OCR against the EXISTING slip ─────────────────────────────────
  let ocrText = "";
  let providerConfidence: number | undefined;
  let confidenceKnown = false;
  let providerDiagnostic: ProviderDiagnostic | undefined;

  try {
    // Uses the slip already on file. slipSubmittedAt is never rewritten.
    const ocrImageUrl = await prepareSlipImageForOcr(payment.slipImageUrl);
    if (!ocrImageUrl) {
      throw new Error("OCR_IMAGE_PREPARATION_FAILED");
    }

    const parsed = await parseSlipImage(ocrImageUrl);
    if (parsed.technicalError) {
      throw new Error(parsed.technicalErrorCode ?? "OCR_PROCESSING_ERROR");
    }

    ocrText = parsed.text;
    confidenceKnown = parsed.confidenceKnown === true;
    providerConfidence = confidenceKnown ? parsed.ocrConfidence : undefined;
  } catch (error) {
    providerDiagnostic = describeProviderFailure(error);
    const summary = summarizeRootCause({
      reviewReason: providerDiagnostic.code,
      providerDiagnostic,
    });

    const attemptNo = await recordOcrAttempt({
      subjectType: "order_payment",
      subjectId: payment.id,
      trigger: "admin_recheck",
      initiatedByUserId: input.adminUserId,
      startedAt,
      stage:
        providerDiagnostic.code === "OCR_IMAGE_PREPARATION_FAILED"
          ? "image_preparation"
          : "provider_call",
      result: "technical_failure",
      reviewCategory: "TECHNICAL",
      reviewReason: providerDiagnostic.code,
      providerMode: providerDiagnostic.providerMode,
      providerHttpStatus: providerDiagnostic.providerHttpStatus,
      providerAttemptCount: providerDiagnostic.providerAttemptCount,
    });

    // Payment status is deliberately untouched: a provider outage must not
    // change the customer's standing in any direction.
    return {
      paymentId: payment.id,
      orderId: order.id,
      paymentStatus: payment.status,
      attemptNo,
      verificationPassed: false,
      readyForAdminApproval: false,
      reviewReason: providerDiagnostic.code,
      category: "TECHNICAL",
      rootCauseSummary: summary.summary,
      providerDiagnostic,
      confidenceKnown: false,
      hasStrongIdentifier: false,
    };
  }

  // ── Re-extract and re-verify ──────────────────────────────────────────
  const extracted = extractSlipData(ocrText, providerConfidence);

  const orderTotal = Number(order.totalAmount);
  const verification = verifySlipData(
    extracted,
    {
      orderId: order.id,
      paymentId: payment.id,
      orderTotal,
      orderCreatedAt: order.createdAt,
      paymentCreatedAt: payment.createdAt,
      // The ORIGINAL submission time - never "now". Freshness must still be
      // judged against when the customer actually submitted the slip.
      slipSubmittedAt: payment.slipSubmittedAt ?? payment.createdAt,
    },
    new Set(),
    new Set(),
    config.minConfidence,
    config.maxTimeWindowMinutes
  );

  const { identifiers } = deriveStrongIdentifiersFromExtractedData(JSON.stringify(extracted));
  const strongIdentifierPresent = hasStrongIdentifier(identifiers);

  // Passing verification is NOT approval. It only means an admin may now
  // approve with confidence; the Approve action re-runs its own anti-replay
  // claim independently of anything decided here.
  const verificationPassed = verification.isAutoApproved;
  const readyForAdminApproval = verificationPassed && strongIdentifierPresent;

  const reviewReason = verificationPassed
    ? strongIdentifierPresent
      ? undefined
      : "NO_STRONG_IDENTIFIER"
    : verification.reviewReason;

  const summary = summarizeRootCause({
    reviewReason,
    readyForAdminApproval,
  });

  // Refresh the DISPLAY metadata only. status/slipSubmittedAt are excluded
  // by construction - this update names every column it writes.
  await db.updatePayment(payment.id, {
    extractedData: JSON.stringify(extracted),
    ocrConfidence: extracted.confidence ?? 0,
    reviewReason: reviewReason ?? null,
    ocrDecision: "needs_review",
  });

  const attemptNo = await recordOcrAttempt({
    subjectType: "order_payment",
    subjectId: payment.id,
    trigger: "admin_recheck",
    initiatedByUserId: input.adminUserId,
    startedAt,
    stage: "completed",
    result: "needs_review",
    reviewCategory: summary.category,
    reviewReason: reviewReason ?? null,
    confidence: extracted.confidenceKnown === false ? null : (extracted.confidence ?? null),
    providerAttemptCount: 1,
    verificationSnapshot: JSON.stringify({
      amountMatched: verification.breakdown?.amountMatched,
      datePresent: verification.breakdown?.datePresent,
      dateWithinWindow: verification.breakdown?.dateWithinWindow,
      referencePresent: verification.breakdown?.referencePresent,
      duplicateEvidenceStrength: verification.breakdown?.duplicateEvidenceStrength,
      confidenceKnown: verification.breakdown?.confidenceKnown,
      bankDetected: verification.breakdown?.bankDetected,
      strongIdentifierPresent,
    }),
  });

  return {
    paymentId: payment.id,
    orderId: order.id,
    // Reloaded value would be identical; echoing the original proves the
    // recheck did not move it.
    paymentStatus: payment.status,
    attemptNo,
    verificationPassed,
    readyForAdminApproval,
    reviewReason,
    category: summary.category,
    rootCauseSummary: summary.summary,
    ocrConfidence: extracted.confidence,
    confidenceKnown: extracted.confidenceKnown !== false,
    hasStrongIdentifier: strongIdentifierPresent,
  };
}
