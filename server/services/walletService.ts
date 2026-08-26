/**
 * Wallet Service Layer
 * Handles wallet top-up and checkout business logic
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { submitWalletTopupSlip } from "./walletTopupSubmissionService";
import { computeSlipFileHash } from "./slipFileHashService";

export async function createWalletTopupRequest(userId: number, requestedAmount: string, slipImageUrl?: string) {
  // STRICT validation: must be a valid positive number only
  // Reject: "100abc", "NaN", "-100", "0", "", null, undefined, etc.
  const trimmed = String(requestedAmount || "").trim();
  
  // Check if it's a valid number format (digits and optional decimal point)
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Top-up amount must be a valid positive number (e.g., 100 or 100.50)",
    });
  }
  
  const amount = parseFloat(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Top-up amount must be greater than 0",
    });
  }

  // New flow: slip must be uploaded first before creating the request
  if (!slipImageUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Payment slip is required",
    });
  }

  let topup: any;
  try {
    topup = await db.createWalletTopup(userId, requestedAmount, slipImageUrl);
    if (!topup) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create wallet top-up request",
      });
    }
  } catch (createError: any) {
    // createWalletTopup failed - this is a critical error that should be surfaced
    console.error("[Wallet] Create topup failed:", {
      message: createError?.message,
      code: createError?.code,
      userId,
      requestedAmount,
      hasSlipImageUrl: !!slipImageUrl,
      error: createError,
    });
    // Wrap error for user - don't expose SQL details
    if (createError instanceof TRPCError) {
      throw createError;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "บันทึกรายการเติมเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    });
  }

  // Wire OCR into active flow: submit slip for OCR processing
  try {
    const ocrResult = await submitWalletTopupSlip(userId, topup.id, requestedAmount, slipImageUrl);
    return {
      ...topup,
      // Return OCR result to frontend
      ocrStatus: ocrResult.status,
      ocrDecision: ocrResult.ocrDecision,
      ocrConfidence: ocrResult.ocrConfidence,
      finalConfidence: ocrResult.finalConfidence,
      reviewReason: ocrResult.reviewReason,
      duplicateStatus: ocrResult.duplicateStatus,
      userMessage: ocrResult.userMessage,
      creditedAmount: ocrResult.creditedAmount,
    };
  } catch (ocrError) {
    // OCR error should not crash the flow - log and return pending status
    console.error("[Wallet OCR] Submission error:", {
      message: ocrError instanceof Error ? ocrError.message : String(ocrError),
      topupId: topup.id,
      userId,
      error: ocrError,
    });
    // If topup was created but OCR failed, return the topup anyway
    // User will see it as pending_review
    return topup;
  }
}

export async function uploadWalletTopupSlip(topupId: number, userId: number, slipImageUrl: string) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (topup.userId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can only upload slip for your own top-up request",
    });
  }

  // Fast preflight - the atomic publish below is the authoritative check
  // against a concurrent finalization in this same window.
  if (topup.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for a ${topup.status} top-up request`,
    });
  }

  // ── EXACT-FILE IDENTIFIER ────────────────────────────────────────────
  // Computed BEFORE publishing this upload as the top-up's current slip, so
  // the SAME atomic write that makes this slip current also seeds ITS OWN
  // strong identifier - mirrors submitPaymentSlip's order-side replacement
  // publish (IPE-001 P1-B, extended to wallet this round).
  const slipFileHash = await computeSlipFileHash(slipImageUrl);
  const slipSubmittedAt = new Date();

  // ── PUBLISH THE REPLACEMENT SLIP (ATOMIC) ────────────────────────────
  // The same write that makes this slip current invalidates whatever
  // extraction belonged to the slip it replaces and seeds this slip's own
  // fileHash - never leaving `slipImageUrl = new, extractedData = old` as
  // an approvable state, even momentarily. Conditioned on the top-up still
  // being reviewable: if it was finalized between the preflight above and
  // this write, the replacement is refused rather than reopening it.
  const published = await db.publishWalletTopupReplacementIfReviewable(topupId, {
    slipImageUrl,
    slipSubmittedAt,
    extractedData: slipFileHash ? JSON.stringify({ fileHash: slipFileHash }) : null,
  });

  if (!published) {
    const current = await db.getWalletTopupById(topupId);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for a ${current?.status ?? "approved"} top-up request`,
    });
  }

  // Re-run OCR for the newly published slip, exactly like a fresh
  // submission. Previously this deprecated endpoint left the row with a new
  // slipImageUrl and never ran OCR against it again at all, so the old
  // extraction sat there mismatched forever - this closes that in addition
  // to the version-binding race (see submitWalletTopupSlip/
  // approveWalletTopupWithOCR/applyWalletTopupOcrUpdate's expectedSlipVersion).
  try {
    const ocrResult = await submitWalletTopupSlip(userId, topupId, topup.requestedAmount, slipImageUrl);
    const updated = await db.getWalletTopupById(topupId);
    return {
      ...updated,
      ocrStatus: ocrResult.status,
      ocrDecision: ocrResult.ocrDecision,
      ocrConfidence: ocrResult.ocrConfidence,
      finalConfidence: ocrResult.finalConfidence,
      reviewReason: ocrResult.reviewReason,
      duplicateStatus: ocrResult.duplicateStatus,
      userMessage: ocrResult.userMessage,
      creditedAmount: ocrResult.creditedAmount,
    };
  } catch (ocrError) {
    // OCR error should not crash the upload - the slip is already published
    // and safely version-bound; the row surfaces as pending_review to a
    // recheck/admin path, mirroring createWalletTopupRequest's same
    // best-effort handling.
    console.error("[Wallet OCR] Replacement submission error:", {
      message: ocrError instanceof Error ? ocrError.message : String(ocrError),
      topupId,
      userId,
      error: ocrError,
    });
    return await db.getWalletTopupById(topupId);
  }
}

export async function adminApproveWalletTopup(topupId: number, adminUserId: number) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (!topup.slipImageUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot approve top-up without slip image",
    });
  }

  // CRITICAL: Check if topup is already approved/rejected (prevent re-approval)
  // Allow both pending and pending_review statuses for admin approval
  if (topup.status !== "pending" && topup.status !== "pending_review") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot approve a ${topup.status} top-up request`,
    });
  }

  try {
    return await db.approveWalletTopup(topupId, adminUserId);
  } catch (error) {
    // An anti-replay refusal is an expected business state, not a server
    // fault: the slip was claimed by another submission (possibly after this
    // admin loaded the page). Surface it as a CONFLICT with an actionable
    // message rather than a generic 500, so the UI can prompt a refresh and
    // point at the submission that already owns the slip.
    if (error instanceof db.WalletSlipClaimError) {
      // NO_STRONG_IDENTIFIER is a precondition the admin must resolve (recheck
      // or legacy override); SLIP_ALREADY_CLAIMED is a conflict with another
      // submission. Distinct codes so the UI can say the right thing.
      // NO_STRONG_IDENTIFIER and an unresolved legacy case ambiguity are both
      // preconditions the admin must clear; SLIP_ALREADY_CLAIMED and a state
      // race are conflicts with another actor. Distinct codes so the UI can
      // say the right thing rather than showing one generic failure.
      const precondition =
        error.code === "NO_STRONG_IDENTIFIER" ||
        error.code === "LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION" ||
        error.code === "LEGACY_REFERENCE_CASE_AMBIGUITY" ||
        error.code === "SLIP_INTEGRITY_MISMATCH_BLOCKED" ||
        error.code === "SLIP_CURRENT_BYTES_UNAVAILABLE" ||
        error.code === "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL";
      throw new TRPCError({
        code: precondition ? "PRECONDITION_FAILED" : "CONFLICT",
        message: `${error.code}: ${error.message}`,
      });
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to approve wallet top-up",
    });
  }
}

export async function adminRejectWalletTopup(
  topupId: number,
  adminUserId: number,
  reason: string
) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (!reason || reason.trim().length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Rejection reason is required",
    });
  }

  try {
    return await db.rejectWalletTopup(topupId, adminUserId, reason);
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to reject wallet top-up",
    });
  }
}
