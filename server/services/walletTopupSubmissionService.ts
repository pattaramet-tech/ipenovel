/**
 * Wallet Top-up OCR Submission Service
 * 
 * Handles OCR verification and auto-approval for wallet top-ups.
 * Reuses hardened OCR parsers from ocr-slip-verification-v2.ts
 * Implements idempotent wallet crediting with transaction locks.
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import {
  parseSlipImage,
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  type ExtractedSlipData,
  type VerificationResult,
} from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { formatMoney } from "../helpers/moneyNormalizer";

export interface WalletTopupSubmissionResult {
  topupId: number;
  status: "pending_review" | "approved";
  ocrDecision: "approved" | "needs_review" | "rejected";
  reviewReason?: string;
  ocrConfidence?: number;
  finalConfidence?: number;
  duplicateStatus?: any;
  userMessage: string;
  creditedAmount?: string;
}

/**
 * Submit wallet top-up slip for OCR verification and auto-approval
 */
export async function submitWalletTopupSlip(
  userId: number,
  topupId: number,
  requestedAmount: string,
  slipImageUrl: string
): Promise<WalletTopupSubmissionResult> {
  // Load the wallet top-up request
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
      message: "You can only submit slip for your own top-up request",
    });
  }

  if (topup.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot submit slip for a ${topup.status} top-up request`,
    });
  }

  const ocrConfig = await getEffectiveOCRConfig();
  const requestedAmountNum = parseFloat(requestedAmount);

  try {
    // Step 1: Parse slip image with OCR
    const parseResult = await parseSlipImage(slipImageUrl);

    // Handle OCR technical error
    if (parseResult.technicalError) {
      return await handleOCRError(
        topupId,
        userId,
        "OCR_PROCESSING_ERROR",
        "ส่งสลิปแล้ว แต่ระบบ OCR ขัดข้อง แอดมินจะตรวจสอบให้"
      );
    }

    // Handle OCR disabled
    if (!ocrConfig.enabled) {
      return await handlePendingReview(
        topupId,
        userId,
        "OCR_DISABLED",
        "ส่งสลิปแล้ว รอแอดมินตรวจสอบ"
      );
    }

    // Handle shadow mode
    if (ocrConfig.shadowModeEnabled) {
      return await handlePendingReview(
        topupId,
        userId,
        "SHADOW_MODE",
        "ส่งสลิปแล้ว รอแอดมินตรวจสอบ"
      );
    }

    // Step 2: Extract slip data
    const extractedData = extractSlipData(parseResult.text, parseResult.ocrConfidence);

    // Step 3: Verify slip data
    const existingRefs = new Set(await getExistingReferencesForWallet(userId));
    const existingFingerprints = new Set(await getExistingFingerprintsForWallet(userId));
    
    const verificationResult = verifySlipData(
      extractedData,
      {
        orderId: topupId,
        paymentId: topupId,
        orderTotal: requestedAmountNum,
        orderCreatedAt: topup.createdAt,
        paymentCreatedAt: topup.createdAt,
        slipSubmittedAt: topup.slipSubmittedAt ?? new Date(),
      },
      existingRefs,
      existingFingerprints,
      ocrConfig.minConfidence,
      ocrConfig.maxTimeWindowMinutes
    );

    // Calculate final confidence
    const finalConfidence = verificationResult.breakdown?.ocrConfidence || 0;

    // Generate fingerprint for duplicate detection
    const fingerprint = generateFingerprint(extractedData);

    // Step 4: Check for duplicates (if reviewReason indicates duplicate)
    if (verificationResult.reviewReason?.includes("DUPLICATE")) {
      return await handleDuplicate(
        topupId,
        userId,
        extractedData,
        fingerprint,
        verificationResult,
        "พบความเสี่ยงสลิปซ้ำ รอแอดมินตรวจสอบ"
      );
    }

    // Step 5: Check confidence level
    if (finalConfidence < ocrConfig.minConfidence) {
      return await handlePendingReview(
        topupId,
        userId,
        "LOW_CONFIDENCE",
        "ส่งสลิปแล้ว ระบบอ่านข้อมูลไม่มั่นใจ รอแอดมินตรวจสอบ",
        extractedData,
        fingerprint,
        verificationResult
      );
    }

    // Step 6: Check amount match
    if (!verificationResult.breakdown?.amountMatched) {
      return await handlePendingReview(
        topupId,
        userId,
        "AMOUNT_MISMATCH",
        "ส่งสลิปแล้ว จำนวนเงินไม่ตรงกัน รอแอดมินตรวจสอบ",
        extractedData,
        fingerprint,
        verificationResult
      );
    }

    // Step 7: Check missing required fields
    if (!verificationResult.breakdown?.referencePresent) {
      return await handlePendingReview(
        topupId,
        userId,
        "MISSING_FIELDS",
        "ส่งสลิปแล้ว ข้อมูลไม่ครบถ้วน รอแอดมินตรวจสอบ",
        extractedData,
        fingerprint,
        verificationResult
      );
    }

    // Step 8: Auto-approve if all checks pass
    if (ocrConfig.autoApproveEnabled && verificationResult.status === "approved") {
      return await autoApproveWalletTopup(
        topupId,
        userId,
        requestedAmountNum,
        extractedData,
        fingerprint,
        verificationResult,
        parseResult
      );
    }

    // Step 9: Default to pending review if auto-approve is disabled
    return await handlePendingReview(
      topupId,
      userId,
      "AUTO_APPROVE_DISABLED",
      "ส่งสลิปแล้ว รอแอดมินตรวจสอบ",
      extractedData,
      fingerprint,
      verificationResult
    );
  } catch (error: any) {
    console.error("Wallet top-up OCR submission error:", error);
    return await handleOCRError(
      topupId,
      userId,
      "OCR_PROCESSING_ERROR",
      "ส่งสลิปแล้ว แต่ระบบ OCR ขัดข้อง แอดมินจะตรวจสอบให้"
    );
  }
}

/**
 * Auto-approve wallet top-up and credit wallet
 */
async function autoApproveWalletTopup(
  topupId: number,
  userId: number,
  amount: number,
  extractedData: ExtractedSlipData,
  fingerprint: string,
  verificationResult: VerificationResult,
  parseResult?: any
): Promise<WalletTopupSubmissionResult> {
  // Fetch topup to get bonus amount
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up not found",
    });
  }

  // Calculate credited amount: requestedAmount + bonus (same as admin approval)
  const bonusAmount = topup.bonusAmount ? parseFloat(String(topup.bonusAmount)) : 0;
  const creditedAmount = amount + bonusAmount;
  const creditedAmountStr = String(creditedAmount);
  
  // Use parseResult fields for confidence (Phase 8: Fix confidence metadata)
  // parseResult contains visionConfidence from image analysis
  // verificationResult.breakdown contains ocrConfidence from text verification
  const ocrConfidenceValue = verificationResult?.breakdown ? Math.round(verificationResult.breakdown.ocrConfidence) : 0;
  const visionConfidenceValue = parseResult ? Math.round(parseResult.visionConfidence || 0) : 0;
  const structuredConfidenceValue = ocrConfidenceValue; // Use OCR confidence for structure
  const finalConfidenceValue = ocrConfidenceValue; // Final is OCR confidence
  
  // Phase 2: Use transactional approveWalletTopupWithOCR for approval + wallet credit in one transaction
  // This ensures atomicity: if approval succeeds, wallet is credited; if either fails, both rollback
  const updatedTopup = await db.approveWalletTopupWithOCR(topupId, {
    status: "approved",
    slipSubmittedAt: new Date(),
    extractedData: JSON.stringify(extractedData),
    ocrConfidence: ocrConfidenceValue,
    visionConfidence: visionConfidenceValue,
    structuredConfidence: structuredConfidenceValue,
    finalConfidence: finalConfidenceValue,
    duplicateStatus: JSON.stringify({
      isDuplicate: false,
      type: null,
      reference: null,
      fingerprint,
    }),
    ocrDecision: "approved",
    approvalSource: "ocr_auto",
    approvedAt: new Date(),
    creditedAmount: creditedAmountStr,
  });

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  return {
    topupId,
    status: "approved",
    ocrDecision: "approved",
    ocrConfidence: ocrConfidenceValue,
    finalConfidence: finalConfidenceValue,
    userMessage: "เติมเงินสำเร็จ ระบบอนุมัติอัตโนมัติแล้ว",
    creditedAmount: creditedAmountStr,
  };
}

/**
 * Handle pending review with OCR data
 */
async function handlePendingReview(
  topupId: number,
  userId: number,
  reviewReason: string,
  userMessage: string,
  extractedData?: ExtractedSlipData,
  fingerprint?: string,
  verificationResult?: VerificationResult,
  parseResult?: any
): Promise<WalletTopupSubmissionResult> {
  const updateData: any = {
    status: "pending_review",
    slipSubmittedAt: new Date(),
    ocrDecision: "needs_review",
    reviewReason,
    approvalSource: "manual",
  };

  if (extractedData) {
    updateData.extractedData = JSON.stringify(extractedData);
  }

  if (verificationResult?.breakdown) {
    updateData.ocrConfidence = Math.round(verificationResult.breakdown.ocrConfidence);
    updateData.visionConfidence = parseResult ? Math.round(parseResult.visionConfidence || 0) : undefined;
    updateData.structuredConfidence = Math.round(verificationResult.breakdown.ocrConfidence);
    updateData.finalConfidence = Math.round(verificationResult.breakdown.ocrConfidence);
  }

  if (fingerprint) {
    updateData.duplicateStatus = JSON.stringify({
      isDuplicate: verificationResult?.reviewReason?.includes("DUPLICATE") || false,
      type: verificationResult?.reviewReason?.replace("DUPLICATE_", "") || null,
      reference: extractedData?.reference || null,
      fingerprint,
    });
  }

  const updatedTopup = await db.updateWalletTopupWithOCRApproval(topupId, updateData);

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  return {
    topupId,
    status: "pending_review",
    ocrDecision: "needs_review",
    reviewReason,
    ocrConfidence: verificationResult?.breakdown ? Math.round(verificationResult.breakdown.ocrConfidence) : undefined,
    finalConfidence: verificationResult?.breakdown ? Math.round(verificationResult.breakdown.ocrConfidence) : undefined,
    userMessage,
    creditedAmount: undefined,
  };
}

/**
 * Handle duplicate detection
 */
async function handleDuplicate(
  topupId: number,
  userId: number,
  extractedData: ExtractedSlipData,
  fingerprint: string,
  verificationResult: VerificationResult,
  userMessage: string,
  parseResult?: any
): Promise<WalletTopupSubmissionResult> {
  const duplicateType = verificationResult.reviewReason?.replace("DUPLICATE_", "") || "UNKNOWN";
  const updateData = {
    status: "pending_review",
    slipSubmittedAt: new Date(),
    extractedData: JSON.stringify(extractedData),
    ocrConfidence: verificationResult?.breakdown?.ocrConfidence ? Math.round(verificationResult.breakdown.ocrConfidence) : undefined,
    visionConfidence: parseResult ? Math.round(parseResult.visionConfidence || 0) : undefined,
    structuredConfidence: verificationResult?.breakdown?.ocrConfidence ? Math.round(verificationResult.breakdown.ocrConfidence) : undefined,
    finalConfidence: verificationResult?.breakdown?.ocrConfidence ? Math.round(verificationResult.breakdown.ocrConfidence) : undefined,
    duplicateStatus: JSON.stringify({
      isDuplicate: true,
      type: duplicateType,
      reference: extractedData.reference,
      fingerprint,
    }),
    ocrDecision: "needs_review",
    reviewReason: verificationResult.reviewReason || "DUPLICATE_UNKNOWN",
    approvalSource: "manual",
  };

  const updatedTopup = await db.updateWalletTopupWithOCRApproval(topupId, updateData);

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  return {
    topupId,
    status: "pending_review",
    ocrDecision: "needs_review",
    reviewReason: verificationResult.reviewReason || "DUPLICATE_UNKNOWN",
    duplicateStatus: {
      isDuplicate: true,
      type: duplicateType,
      reference: extractedData.reference,
    },
    userMessage,
    creditedAmount: undefined,
  };
}

/**
 * Handle OCR technical error
 */
async function handleOCRError(
  topupId: number,
  userId: number,
  reviewReason: string,
  userMessage: string
): Promise<WalletTopupSubmissionResult> {
  const updateData = {
    status: "pending_review",
    slipSubmittedAt: new Date(),
    ocrDecision: "needs_review",
    reviewReason,
    approvalSource: "manual",
  };

  const updatedTopup = await db.updateWalletTopupWithOCRApproval(topupId, updateData);

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  return {
    topupId,
    status: "pending_review",
    ocrDecision: "needs_review",
    reviewReason,
    userMessage,
  };
}

/**
 * Credit wallet idempotently - never double-credit
 */
async function creditWalletIdempotent(userId: number, topupId: number, amount: string): Promise<void> {
  // Check if wallet transaction already exists for this topup
  const existingTransaction = await db.getWalletTransactionByReference(
    userId,
    "wallet_topup",
    topupId.toString()
  );

  if (existingTransaction) {
    // Already credited, return idempotently
    return;
  }

  // Credit wallet in transaction
  await db.creditWalletBalance(userId, amount, "wallet_topup", parseInt(topupId.toString()));
}

/**
 * Get existing references for wallet (for duplicate detection)
 */
async function getExistingReferencesForWallet(userId: number): Promise<string[]> {
  const references: string[] = [];

  // Get references from wallet topups (all users for global detection)
  const topups = await db.getWalletTopupsByUserId(userId);
  for (const topup of topups) {
    if (topup && topup.extractedData) {
      try {
        const data = JSON.parse(topup.extractedData);
        if (data.reference) {
          references.push(data.reference);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Get references from order payments (all users for global detection)
  try {
    const payments = await db.getPendingPayments(1000, 0);
    for (const payment of payments) {
      if (payment && payment.extractedData) {
        try {
          const data = JSON.parse(payment.extractedData);
          if (data.reference) {
            references.push(data.reference);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  } catch (e) {
    // If getPaymentsWithSlips fails, continue with wallet-only detection
    console.warn("Failed to fetch order payments for duplicate detection", e);
  }

  return references;
}

/**
 * Get existing fingerprints for wallet (for duplicate detection)
 */
async function getExistingFingerprintsForWallet(userId: number): Promise<string[]> {
  const fingerprints: string[] = [];

  // Get fingerprints from wallet topups (all users for global detection)
  const topups = await db.getWalletTopupsByUserId(userId);
  for (const topup of topups) {
    if (topup && topup.duplicateStatus) {
      try {
        const data = JSON.parse(topup.duplicateStatus);
        if (data.fingerprint) {
          fingerprints.push(data.fingerprint);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Get fingerprints from order payments (all users for global detection)
  try {
    const payments = await db.getPendingPayments(1000, 0);
    for (const payment of payments) {
      if (payment && payment.duplicateStatus) {
        try {
          const data = JSON.parse(payment.duplicateStatus);
          if (data.fingerprint) {
            fingerprints.push(data.fingerprint);
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  } catch (e) {
    // If getPendingPayments fails, continue with wallet-only detection
    console.warn("Failed to fetch order payments for duplicate detection", e);
  }

  return fingerprints;
}
