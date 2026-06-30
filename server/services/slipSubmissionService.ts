/**
 * Shared slip submission service for both orders.uploadPaymentSlip and checkout.create
 * Handles slip validation, OCR processing, auto-approval, and pending review logic
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { ApprovalService } from "./approvalService";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { processSlipVerificationStaging } from "../ocr-slip-integration-staging";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { generateApprovalNote, generateShadowModeNote, generateManualReviewNote } from "../_core/ocr-order-notes";
import * as orderService from "./orderService";
import { sendOCRReviewNotification } from "./discordNotificationService";

export interface SlipSubmissionInput {
  orderId: number;
  slipImageUrl: string;
  userId: number; // For ownership validation
}

export interface SlipSubmissionResult {
  success: boolean;
  message?: string;
  orderId: number;
  paymentId: number;
  status: string;
  slipImageUrl: string;
  isAutoApproved: boolean;
  isShadowMode: boolean;
  reviewReason?: string;
  ocrConfidence?: number;
  detectedBank?: string | null;
  duplicateStatus?: {
    isDuplicateReference: boolean;
    isDuplicateFingerprint: boolean;
  };
  ocrDecision?: string;
}

/**
 * Shared slip submission logic used by both:
 * 1. orders.uploadPaymentSlip (user re-uploading slip for pending payment)
 * 2. checkout.create (user uploading slip during checkout)
 */
export async function submitPaymentSlip(input: SlipSubmissionInput): Promise<SlipSubmissionResult> {
  // Validate slip URL is not empty
  if (!input.slipImageUrl || input.slipImageUrl.trim().length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Payment slip is required" });
  }

  // Get order and validate ownership
  const order = await db.getOrderById(input.orderId);
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  }

  if (order.userId !== input.userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Order does not belong to user" });
  }

  // Get payment for this order
  const payment = await db.getPaymentByOrderId(order.id);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found for order" });
  }

  // P0-1 FIX: Prevent re-uploading on finalized payments
  // Do not allow resetting approved or rejected payments back to pending
  if (payment.status === "approved" || payment.status === "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for ${payment.status} payment. Payment is finalized.`,
    });
  }

  // Update payment with slip URL and submission time
  await db.updatePayment(payment.id, {
    slipImageUrl: input.slipImageUrl,
    slipSubmittedAt: new Date(),
    status: "pending",
  });

  // Check if OCR is enabled using effective config (Phase 4)
  const effectiveConfig = await getEffectiveOCRConfig();
  const ocrEnabled = effectiveConfig.enabled;

  let verificationResult: any;
  let shouldApprove = false;

  if (ocrEnabled) {
    // OCR is enabled: run OCR processing with error handling
    console.log(`[OCR] Processing slip for order ${order.id} (OCR enabled)`);
    try {
      // Extract OCR text from slip image (returns structured result with confidence)
      const slipOcrResult = await parseSlipImage(input.slipImageUrl);
      
      // Check if OCR/LLM technical error occurred
      if (slipOcrResult.technicalError) {
        console.error(`[OCR] Technical error detected for order ${order.id}`);
        verificationResult = {
          isAutoApproved: false,
          isShadowMode: false,
          reviewReason: "OCR_PROCESSING_ERROR",
          ocrConfidence: 0,
          detectedBank: null,
          extractedData: null,
          breakdown: { reason: "OCR processing failed. Slip sent to manual review." },
          duplicateStatus: {
            isDuplicateReference: false,
            isDuplicateFingerprint: false,
          },
          ocrDecision: "needs_review",
          fingerprint: null,
        };
        shouldApprove = false;
      } else {
        // Process slip verification with staging enhancements (shadow mode, metrics)
        verificationResult = await processSlipVerificationStaging(payment.id, slipOcrResult);
        // Determine if we should actually approve or just simulate
        shouldApprove = verificationResult.isAutoApproved && !verificationResult.isShadowMode;
      }
    } catch (ocrError) {
      // OCR technical error: send to manual review instead of crashing
      console.error(`[OCR] Technical error processing slip for order ${order.id}:`, ocrError);
      verificationResult = {
        isAutoApproved: false,
        isShadowMode: false,
        reviewReason: "OCR_PROCESSING_ERROR",
        ocrConfidence: 0,
        detectedBank: null,
        extractedData: null,
        breakdown: { reason: "OCR processing failed. Slip sent to manual review." },
        duplicateStatus: {
          isDuplicateReference: false,
        },
      };
      shouldApprove = false;
    }
  } else {
    // OCR is disabled: skip OCR and send to manual review
    console.log(`[OCR] Skipping OCR for order ${order.id} (OCR disabled) - sending to manual review`);
    verificationResult = {
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: "OCR_DISABLED",
      ocrConfidence: 0,
      detectedBank: null,
      extractedData: null,
      breakdown: { reason: "OCR processing is disabled by effective config" },
      duplicateStatus: {
        isDuplicateReference: false,
        isDuplicateFingerprint: false,
      },
      ocrDecision: "ocr_disabled",
      fingerprint: null,
    };
    shouldApprove = false;
  }

  // Use effective config for all OCR decisions (already fetched above)
  const config = effectiveConfig;

  // Sync order status based on verification result
  if (shouldApprove) {
    // ── GUARD: Check if payment is already approved or rejected ──────────────────────
    const currentPayment = await db.getPaymentById(payment.id);
    if (currentPayment?.status === "approved" || currentPayment?.status === "rejected") {
      console.log(`[OCR] Payment ${payment.id} is already ${currentPayment.status}, skipping re-approval`);
      // Return safe no-op result
      return {
        success: true,
        message: `Payment already ${currentPayment.status}`,
        orderId: order.id,
        paymentId: payment.id,
        status: currentPayment.status,
        slipImageUrl: payment.slipImageUrl,
        isAutoApproved: false,
        isShadowMode: false,
      };
    }

    // Auto-approved: update payment record with OCR metadata
    await ApprovalService.approvePaymentWithSource(
      payment.id,
      "auto",
      { autoApprovedAt: new Date() }
    );
    
    // Also save OCR metadata to payment record
    await db.updatePayment(payment.id, {
      extractedData: verificationResult.extractedData ? JSON.stringify(verificationResult.extractedData) : null,
      reviewReason: null,
      fingerprint: verificationResult.fingerprint || null,
      linkedOrderId: order.id,
      linkedPaymentId: payment.id,
      ocrConfidence: verificationResult.ocrConfidence,
      ocrDecision: verificationResult.ocrDecision || "auto_approved",
    });
    
    // Auto-approved: mark order as approved (valid enum value)
    await db.updateOrder(order.id, {
      paymentStatus: "approved",
      status: "approved",
    });
    // Record order history for auto-approval with detailed breakdown
    const approvalNote = generateApprovalNote({
      isAutoApproved: true,
      isShadowMode: false,
      ocrConfidence: verificationResult.ocrConfidence,
      detectedBank: verificationResult.detectedBank,
      extractedAmount: verificationResult.extractedData?.amount,
      orderTotal: order.totalAmount as number,
      extractedDate: verificationResult.extractedData?.transactionDate
        ? verificationResult.extractedData.transactionDate.toLocaleString("en-TH", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : undefined,
      breakdown: verificationResult.breakdown,
    });

    await db.recordOrderHistory({
      orderId: order.id,
      action: "payment_auto_approved",
      fromStatus: order.status,
      toStatus: "approved",
      actorUserId: 0, // 0 indicates system auto-approval
      note: approvalNote,
    });
    // Finalize order: create purchase records, award loyalty points, record coupon usage
    await orderService.finalizeOrderCompletion(order.id, input.userId);
  } else {
    // Pending review: update payment record with OCR metadata
    await ApprovalService.sendToReview(
      payment.id,
      verificationResult.reviewReason || "MANUAL_REVIEW_REQUIRED",
      verificationResult.extractedData,
      verificationResult.fingerprint || null
    );
    
    const ocrDecision = verificationResult.ocrDecision
      || (verificationResult.reviewReason === "OCR_DISABLED"
        ? "ocr_disabled"
        : "needs_review");

    // Also save additional OCR metadata
    await db.updatePayment(payment.id, {
      linkedOrderId: order.id,
      linkedPaymentId: payment.id,
      ocrConfidence: verificationResult.ocrConfidence ?? 0,
      ocrDecision,
    });
    
    // Pending review: keep order pending
    await db.updateOrder(order.id, {
      paymentStatus: "submitted",
      status: "pending",
    });

    // Record order history for pending review with detailed breakdown
    let reviewNote: string;

    if (verificationResult.isShadowMode) {
      reviewNote = generateShadowModeNote({
        isAutoApproved: verificationResult.isAutoApproved,
        isShadowMode: true,
        ocrConfidence: verificationResult.ocrConfidence,
        detectedBank: verificationResult.detectedBank,
        reviewReason: verificationResult.reviewReason,
        extractedAmount: verificationResult.extractedData?.amount,
        orderTotal: order.totalAmount as number,
        extractedDate: verificationResult.extractedData?.transactionDate
          ? verificationResult.extractedData.transactionDate.toLocaleString("en-TH", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : undefined,
        breakdown: verificationResult.breakdown,
      });
    } else {
      reviewNote = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: verificationResult.ocrConfidence,
        detectedBank: verificationResult.detectedBank,
        reviewReason: verificationResult.reviewReason,
        extractedAmount: verificationResult.extractedData?.amount,
        orderTotal: order.totalAmount as number,
        extractedDate: verificationResult.extractedData?.transactionDate
          ? verificationResult.extractedData.transactionDate.toLocaleString("en-TH", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : undefined,
        breakdown: verificationResult.breakdown,
      });
    }

    await db.recordOrderHistory({
      orderId: order.id,
      action: "payment_slip_submitted",
      fromStatus: order.status,
      toStatus: "pending",
      actorUserId: Number(input.userId),
      note: reviewNote,
    });

    // Send Discord notification for payment OCR review (fire-and-forget, no error thrown)
    const user = await db.getUserById(order.userId);
    sendOCRReviewNotification({
      type: "payment",
      id: payment.id,
      userId: order.userId,
      userName: user?.name || "Unknown",
      userEmail: user?.email || "unknown@example.com",
      expectedAmount: parseFloat(order.totalAmount.toString()),
      ocrAmount: verificationResult.extractedData?.amount
        ? parseFloat(verificationResult.extractedData.amount.toString())
        : undefined,
      reviewReason: verificationResult.reviewReason,
      ocrDecision: "needs_review",
      finalConfidence: verificationResult.ocrConfidence,
      duplicateStatus: verificationResult.duplicateStatus,
      slipImageUrl: input.slipImageUrl,
    }).catch((error) => {
      // Silently log Discord errors - payment flow must not fail
      console.warn("[Discord OCR] Failed to send payment notification", {
        paymentId: payment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    success: true,
    orderId: order.id,
    paymentId: payment.id,
    status: shouldApprove ? "approved" : "pending_review",
    slipImageUrl: input.slipImageUrl,
    isAutoApproved: verificationResult.isAutoApproved,
    isShadowMode: verificationResult.isShadowMode,
    reviewReason: verificationResult.reviewReason,
    ocrConfidence: verificationResult.ocrConfidence,
    detectedBank: verificationResult.detectedBank,
    duplicateStatus: verificationResult.duplicateStatus,
    ocrDecision: verificationResult.ocrDecision,
  };
}
