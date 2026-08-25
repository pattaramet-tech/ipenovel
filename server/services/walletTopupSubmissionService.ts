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
import { sendOCRReviewNotification } from "./discordNotificationService";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { describeProviderFailure, type ProviderDiagnostic } from "./ocrDiagnosticsService";
import { recordOcrAttempt } from "./ocrAttemptService";

/** The shape of `recordWalletAttempt`, threaded into the guarded-write
 *  handlers so they can record the TERMINAL outcome themselves, only once
 *  they know whether their write actually landed. */
type WalletAttemptRecorder = (
  result: "auto_approved" | "needs_review" | "technical_failure" | "config_blocked",
  reviewReason: string | null,
  category: string | null,
  confidence: number | null
) => Promise<void>;

export interface WalletTopupSubmissionResult {
  topupId: number;
  /**
   * `rejected` is reachable ONLY by reporting a state an admin already set -
   * this service never rejects anything.
   */
  status: "pending_review" | "approved" | "rejected" | "cancelled";
  ocrDecision: "approved" | "needs_review" | "rejected";
  reviewReason?: string;
  /** TECHNICAL | DATA | CONFIG | STATE. */
  reviewCategory?: string;
  ocrConfidence?: number;
  finalConfidence?: number;
  duplicateStatus?: any;
  userMessage: string;
  creditedAmount?: string;
  /**
   * True when an admin finalized this top-up while OCR was still running.
   * The persisted state is authoritative and NOTHING was written.
   */
  supersededByFinalization?: boolean;
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

  // Captured once, up front. Every downstream write this run makes - the
  // auto-approval claim/credit, and every non-auto-approve pending_review
  // write - requires the top-up to still carry THIS exact slip. A customer
  // replacing the slip mid-run does not change status (a replacement
  // re-opens status to "pending"), so a status-only guard would let this
  // run's result land on a slip it never actually processed (IPE-001,
  // wallet parity with the order-side slip-version binding).
  const expectedSlipVersion = {
    slipImageUrl: topup.slipImageUrl as string | null,
    slipSubmittedAt: topup.slipSubmittedAt as Date | null,
  };

  const ocrConfig = await getEffectiveOCRConfig();
  const requestedAmountNum = parseFloat(requestedAmount);

  // Declared here (not inside the try) so the attempt recorder below can see
  // them on every exit path, including the technical-failure ones.
  const walletOcrStartedAt = new Date();
  let walletProviderDiagnostic: ProviderDiagnostic | undefined;

  // ── EXACT-FILE IDENTIFIER ─────────────────────────────────────────────
  // Computed BEFORE the OCR-enabled check, not inside the try block. When
  // OCR is disabled the function returns early, and computing the hash after
  // that point left every such top-up with NO strong identifier - which
  // manual approval now refuses, making them permanently unapprovable.
  //
  // Needs no provider: it hashes the bytes already stored in the private
  // bucket. Never client-supplied.
  const walletSlipFileHash = await computeSlipFileHash(slipImageUrl);

  /** Minimal extraction carrying just the server-derived file identifier. */
  const fileHashOnlyExtraction = walletSlipFileHash
    ? ({ fileHash: walletSlipFileHash } as any)
    : undefined;

  /**
   * Appends this run to the persistent attempt history. Best-effort:
   * recordOcrAttempt swallows its own errors, so diagnostics can never break
   * wallet crediting. Records automatic runs that previously left no trace at
   * all, so history reflects the real sequence rather than starting at the
   * first admin recheck.
   *
   * CALLED ONLY AFTER a guarded write's outcome is known (or after a run that
   * performs no persistence at all, like OCR-disabled/shadow-mode config
   * blocks). handlePendingReview/handleDuplicate/handleOCRError take the
   * INTENDED (result, reason, category, confidence) and record it themselves
   * once `applied` is known - the intended DATA/CONFIG/TECHNICAL result if
   * the write landed, or exactly one STATE result if a slip
   * replacement/finalization refused it. Recording before that point (the
   * previous shape) could commit a stale DATA/CONFIG/TECHNICAL row for a
   * slip version this run no longer owns.
   */
  const recordWalletAttempt = async (
    result: "auto_approved" | "needs_review" | "technical_failure" | "config_blocked",
    reviewReason: string | null,
    category: string | null,
    confidence: number | null
  ) => {
    await recordOcrAttempt({
      subjectType: "wallet_topup",
      subjectId: topupId,
      trigger: "automatic",
      initiatedByUserId: null,
      startedAt: walletOcrStartedAt,
      stage: walletProviderDiagnostic
        ? walletProviderDiagnostic.code === "OCR_IMAGE_PREPARATION_FAILED"
          ? "image_preparation"
          : "provider_call"
        : "completed",
      result,
      reviewCategory: category,
      reviewReason,
      confidence,
      providerMode: walletProviderDiagnostic?.providerMode ?? null,
      providerHttpStatus: walletProviderDiagnostic?.providerHttpStatus ?? null,
      providerAttemptCount: walletProviderDiagnostic?.providerAttemptCount ?? 1,
      verificationSnapshot: JSON.stringify({
        fileHashAvailable: Boolean(walletSlipFileHash),
      }),
    });
  };

  // OCR disabled: short-circuit BEFORE preparing the image or calling any
  // provider - matches slipSubmissionService.ts's existing high-level
  // behavior (checks ocrEnabled before entering the OCR processing block).
  // Deliberately checked before the try block below: prepareSlipImageForOcr()
  // and parseSlipImage()/invokeLLM() must never run when OCR is disabled,
  // not even for a moment before eventually discovering OCR_DISABLED.
  // Shadow mode is NOT handled here - it intentionally still runs OCR for
  // observation while preventing auto-approval (see the shadow-mode check
  // further down, unchanged).
  if (!ocrConfig.enabled) {
    return await handlePendingReview(
      topupId,
      userId,
      "OCR_DISABLED",
      "ส่งสลิปแล้ว รอแอดมินตรวจสอบ",
      // Persist the server-derived file identifier even though OCR never ran.
      fileHashOnlyExtraction,
      undefined,
      undefined,
      undefined,
      topup,
      expectedSlipVersion,
      recordWalletAttempt,
      "config_blocked",
      "CONFIG",
      null
    );
  }

  try {
    // CRITICAL: OCR verification must compare OCR-extracted amount against requestedAmount (actual money paid),
    // NOT creditedAmount. The bonus is a system reward, not part of the payment.
    // Example: 250 baht top-up → requestedAmount=250, bonusAmount=10, creditedAmount=260
    // OCR slip shows 250 (what user paid) → amountMatched should be TRUE
    // If OCR reads 260, that's a mismatch because user never paid 260.

    // Step 1: Prepare the image input immediately before every OCR call
    // (never reused/cached across retries). server/services/
    // ocrImageInputService.ts resolves a FRESH signed URL and, in
    // legacy_forge mode, hands it straight through unchanged (a legacy
    // absolute URL also passes through unchanged) - exactly the prior
    // behavior. In generic mode, a private r2p: reference is instead
    // fetched server-side and converted to a base64 data URL (a generic
    // OpenAI-compatible provider rejects a private signed HTTPS URL
    // directly - proven on staging), while a legacy absolute URL is never
    // server-fetched.
    const ocrImageUrl = await prepareSlipImageForOcr(slipImageUrl);

    if (!ocrImageUrl) {
      // Image preparation failed - never call parseSlipImage()/invokeLLM()
      // with an empty/absent image: some generic-compatible providers
      // accept or ignore an empty image part and can still return
      // plausible-looking text, which would then be verified and could
      // satisfy auto-approval/crediting despite the submitted slip never
      // actually being processed. This fixed, sanitized message (never a
      // signed URL/key/credential) is caught by the outer catch block
      // below like any other OCR technical error, routing to manual
      // review instead of crashing the submission.
      throw new Error("OCR_IMAGE_PREPARATION_FAILED");
    }

    const parseResult = await parseSlipImage(ocrImageUrl);

    // Handle OCR technical error. The sanitized provider diagnostic is
    // preserved instead of being flattened to OCR_PROCESSING_ERROR, so an
    // admin can distinguish a provider outage from a bad slip.
    if (parseResult.technicalError) {
      walletProviderDiagnostic = parseResult.providerDiagnostic;
      return await handleOCRError(
        topupId,
        userId,
        parseResult.technicalErrorCode ?? "OCR_PROCESSING_ERROR",
        "ส่งสลิปแล้ว แต่ระบบ OCR ขัดข้อง แอดมินจะตรวจสอบให้",
        topup,
        // Persist the server-derived identifier: OCR failed, but the stored
        // bytes are still uniquely identifying, and without this the top-up
        // would be unapprovable.
        fileHashOnlyExtraction,
        expectedSlipVersion,
        recordWalletAttempt
      );
    }

    // Handle shadow mode
    if (ocrConfig.shadowModeEnabled) {
      return await handlePendingReview(
        topupId,
        userId,
        "SHADOW_MODE",
        "ส่งสลิปแล้ว รอแอดมินตรวจสอบ",
        fileHashOnlyExtraction,
        undefined,
        undefined,
        undefined,
        topup,
        expectedSlipVersion,
        recordWalletAttempt,
        "needs_review",
        "CONFIG",
        null
      );
    }

    // Step 2: Extract slip data
    // `undefined`, NOT the numeric 0 placeholder, when the provider never
    // reported a confidence - otherwise extractSlipData reads 0 as a real
    // "0%" reading and UNKNOWN_CONFIDENCE collapses into LOW_CONFIDENCE.
    // See the identical fix in ocr-slip-integration-staging.ts.
    const rawExtracted = extractSlipData(
      parseResult.text,
      parseResult.confidenceKnown === false ? undefined : parseResult.ocrConfidence
    );
    // Attach the server-computed exact-file identifier so it reaches strong
    // identifier derivation and the claim registry.
    const extractedData = walletSlipFileHash
      ? { ...rawExtracted, fileHash: walletSlipFileHash }
      : rawExtracted;

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
        "พบความเสี่ยงสลิปซ้ำ รอแอดมินตรวจสอบ",
        parseResult,
        topup,
        expectedSlipVersion,
        recordWalletAttempt,
        "WEAK_DUPLICATE_RISK",
        "DATA",
        null
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
        verificationResult,
        parseResult,
        topup,
        expectedSlipVersion,
        recordWalletAttempt,
        "needs_review",
        "DATA",
        null
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
        verificationResult,
        parseResult,
        topup,
        expectedSlipVersion,
        recordWalletAttempt,
        "needs_review",
        "DATA",
        null
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
        verificationResult,
        parseResult,
        topup,
        expectedSlipVersion,
        recordWalletAttempt,
        "needs_review",
        "DATA",
        null
      );
    }

    // Step 8: Auto-approve if all checks pass
    if (ocrConfig.autoApproveEnabled && verificationResult.status === "approved") {
      // HISTORY IS WRITTEN ONLY AFTER THE MONEY COMMITS.
      //
      // Recording `auto_approved` before autoApproveWalletTopup ran meant a
      // claim conflict or a failed approval transaction left history
      // asserting an approval that never happened, while the top-up sat in
      // pending_review. The row is now written only once the atomic claim and
      // the wallet credit have both committed.
      try {
        const approved = await autoApproveWalletTopup(
          topupId,
          userId,
          requestedAmountNum,
          extractedData,
          fingerprint,
          verificationResult,
          parseResult,
          expectedSlipVersion
        );
        await recordWalletAttempt("auto_approved", null, null, finalConfidence);
        return approved;
      } catch (approvalError: any) {
        // A claim conflict is a DATA outcome, not a provider failure - OCR
        // worked perfectly; the slip was simply already used. Classifying it
        // as TECHNICAL/OCR_PROCESSING_ERROR would tell an admin the wrong
        // story and invite a pointless recheck.
        const claimCode =
          approvalError instanceof db.WalletSlipClaimError ? approvalError.code : undefined;

        // A LOST STATE RACE IS NOT A REVIEW OUTCOME. Checked BEFORE the
        // generic claim handling below, which routes everything to
        // handlePendingReview.
        //
        // Two distinct causes share this shape: an admin approved or
        // rejected this top-up while OCR was running (TOPUP_STATE_RACE), or
        // the customer replaced the slip while THIS run's OCR was still in
        // flight (TOPUP_SLIP_VERSION_CHANGED - the row is still reviewable,
        // but the identifiers this run computed belong to a slip that is no
        // longer current). Either way the claim already rolled back with the
        // transaction, so there is nothing to record and nothing to undo -
        // and writing pending_review here would reopen a finalized record or
        // stomp a newer slip's evidence. The persisted state is
        // authoritative: report it and write NOTHING.
        if (claimCode === "TOPUP_STATE_RACE" || claimCode === "TOPUP_SLIP_VERSION_CHANGED") {
          await recordWalletAttempt(
            // The attempt-history enum has no state-race member and adding
            // one needs a migration; the reason/category pair below is what
            // identifies this outcome, and it is neither a provider failure
            // nor a duplicate.
            "needs_review",
            claimCode === "TOPUP_SLIP_VERSION_CHANGED"
              ? "TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT"
              : "TOPUP_SUPERSEDED_BY_FINALIZATION",
            "STATE",
            finalConfidence
          );
          return await buildSupersededResult(topupId, expectedSlipVersion);
        }

        if (claimCode) {
          const duplicateReason =
            claimCode === "NO_STRONG_IDENTIFIER" ? "NO_STRONG_IDENTIFIER" : claimCode;
          return await handlePendingReview(
            topupId,
            userId,
            duplicateReason,
            "ส่งสลิปแล้ว พบความเสี่ยงสลิปซ้ำ รอแอดมินตรวจสอบ",
            extractedData,
            fingerprint,
            verificationResult,
            parseResult,
            topup,
            expectedSlipVersion,
            recordWalletAttempt,
            "needs_review",
            "DATA",
            finalConfidence
          );
        }

        // Anything else is a genuine failure - rethrow so the outer catch
        // classifies it. No auto_approved row was written.
        throw approvalError;
      }
    }

    // Step 9: Not auto-approved.
    //
    // AUTO_APPROVE_DISABLED is only truthful when verification actually
    // PASSED and operator config withheld approval. Previously every
    // unhandled verifier failure - RECIPIENT_NOT_VERIFIED,
    // TRANSACTION_OUTSIDE_TIME_WINDOW, MISSING_TRANSACTION_DATE, ... - landed
    // here and was recorded as a configuration decision, concealing the real
    // data problem from the admin.
    const verificationPassed = verificationResult.status === "approved";
    const step9Reason = verificationPassed
      ? "AUTO_APPROVE_DISABLED"
      : (verificationResult.reviewReason ?? "MANUAL_REVIEW_REQUIRED");
    const step9Category = verificationPassed ? "CONFIG" : "DATA";

    return await handlePendingReview(
      topupId,
      userId,
      step9Reason,
      "ส่งสลิปแล้ว รอแอดมินตรวจสอบ",
      extractedData,
      fingerprint,
      verificationResult,
      parseResult,
      topup,
      expectedSlipVersion,
      recordWalletAttempt,
      "needs_review",
      step9Category,
      finalConfidence
    );
  } catch (error: any) {
    // Sanitized classification only - the thrown error's own message may
    // embed an endpoint or credential and is never propagated.
    walletProviderDiagnostic = describeProviderFailure(error);
    console.error(
      `[Wallet OCR] technical failure for topup ${topupId}: ${walletProviderDiagnostic.code} status=${walletProviderDiagnostic.providerHttpStatus ?? "n/a"} attempts=${walletProviderDiagnostic.providerAttemptCount}`
    );
    return await handleOCRError(
      topupId,
      userId,
      walletProviderDiagnostic.code,
      "ส่งสลิปแล้ว แต่ระบบ OCR ขัดข้อง แอดมินจะตรวจสอบให้",
      topup,
      fileHashOnlyExtraction,
      expectedSlipVersion,
      recordWalletAttempt
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
  parseResult?: any,
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null }
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
  const updatedTopup = await db.approveWalletTopupWithOCR(
    topupId,
    {
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
    },
    undefined,
    expectedSlipVersion
  );

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
 * Reports the CURRENT persisted state of a top-up without mutating anything.
 *
 * Two distinct causes reach here: an admin finalized the record while OCR
 * was still running, or the customer replaced the slip this run started
 * against (the top-up is still reviewable - a replacement re-opens status to
 * "pending" - but the identifiers this run computed belong to a slip that is
 * no longer current). Passing `expectedSlipVersion` lets this distinguish
 * them by comparing the reloaded row's slip identity against it, mirroring
 * ocrRecheckService.ts's buildSupersededResult. The database is the single
 * authority here either way: this function never approves, rejects,
 * reopens, claims or credits.
 */
async function buildSupersededResult(
  topupId: number,
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null },
  /**
   * When supplied, records exactly ONE STATE attempt for this run - the
   * terminal outcome now that the guarded write's refusal is known. Omitted
   * by the one call site that already recorded this same STATE outcome
   * itself (the auto-approval claim race, which learns the refusal directly
   * from the rolled-back transaction rather than from a guarded write here).
   */
  recordAttempt?: WalletAttemptRecorder,
  attemptConfidence: number | null = null
): Promise<WalletTopupSubmissionResult> {
  const current = await db.getWalletTopupById(topupId);
  const status = (current?.status as WalletTopupSubmissionResult["status"]) ?? "pending_review";
  const isFinalized = status === "approved" || status === "rejected" || status === "cancelled";

  const slipReplaced =
    !isFinalized &&
    expectedSlipVersion !== undefined &&
    current != null &&
    !(
      (current.slipImageUrl as string | null) === expectedSlipVersion.slipImageUrl &&
      ((current.slipSubmittedAt as Date | null)?.getTime() ?? null) ===
        (expectedSlipVersion.slipSubmittedAt?.getTime() ?? null)
    );

  const reviewReason = slipReplaced
    ? "TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT"
    : "TOPUP_SUPERSEDED_BY_FINALIZATION";

  // Exactly ONE terminal attempt for this run: the STATE outcome that
  // actually landed, never the DATA/CONFIG/TECHNICAL result the caller had
  // intended before discovering its write was refused.
  if (recordAttempt) {
    await recordAttempt("needs_review", reviewReason, "STATE", attemptConfidence);
  }

  return {
    topupId,
    status,
    ocrDecision: "needs_review",
    reviewReason,
    reviewCategory: "STATE",
    supersededByFinalization: !slipReplaced,
    userMessage: slipReplaced
      ? "สลิปนี้ถูกแทนที่ด้วยการอัปโหลดใหม่ก่อนที่ระบบจะประมวลผลเสร็จ"
      : status === "approved"
        ? "รายการนี้ได้รับการอนุมัติโดยแอดมินแล้ว"
        : status === "rejected"
          ? "รายการนี้ถูกปฏิเสธโดยแอดมินแล้ว"
          : "สถานะรายการถูกอัปเดตโดยแอดมินแล้ว",
    creditedAmount: undefined,
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
  parseResult?: any,
  topup?: any, // Topup object for Discord notification
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null },
  /**
   * The attempt history recorder and the OUTCOME this call intended, passed
   * through rather than recorded by the caller before this write runs. Only
   * once `applied` is known below do we know whether to record this intended
   * result or the STATE outcome a refused write actually produced - see the
   * module-level doc on recordWalletAttempt.
   */
  recordAttempt?: WalletAttemptRecorder,
  intendedResult: "needs_review" | "config_blocked" = "needs_review",
  intendedCategory: string | null = "DATA",
  intendedConfidence: number | null = null
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

  const { applied, topup: updatedTopup } = await db.applyWalletTopupOcrUpdate(
    topupId,
    updateData,
    expectedSlipVersion
  );

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  // The write was refused - either an admin had already finalized this
  // top-up, or the customer replaced its slip while this run was in flight.
  // Report the authoritative state instead of claiming a review that did not
  // happen - and do not notify, since nothing needs reviewing. Recording
  // happens INSIDE buildSupersededResult, now that the refusal is known:
  // never the intended DATA/CONFIG result above, which never actually landed.
  if (!applied) {
    return await buildSupersededResult(
      topupId,
      expectedSlipVersion,
      recordAttempt,
      intendedConfidence
    );
  }

  // The write landed for the exact slip version this run processed - safe to
  // record the intended outcome now.
  if (recordAttempt) {
    await recordAttempt(intendedResult, reviewReason, intendedCategory, intendedConfidence);
  }

  // Send Discord notification for OCR review (non-blocking)
  if (topup) {
    // Fire and forget - Discord notification should not block the flow
    sendOCRReviewNotification({
      type: "wallet_topup",
      id: topupId,
      userId,
      expectedAmount: parseFloat(topup.requestedAmount),
      ocrAmount: extractedData?.amount,
      bonusAmount: topup.bonusAmount,
      creditedAmount: topup.creditedAmount,
      reviewReason,
      ocrDecision: "needs_review",
      finalConfidence: updateData.finalConfidence,
      duplicateStatus: updateData.duplicateStatus ? JSON.parse(updateData.duplicateStatus) : undefined,
    }).catch((err) => {
      // Already logged in service, just silently ignore
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
  parseResult?: any,
  topup?: any, // Topup object for Discord notification
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null },
  recordAttempt?: WalletAttemptRecorder,
  intendedReason: string = "WEAK_DUPLICATE_RISK",
  intendedCategory: string | null = "DATA",
  intendedConfidence: number | null = null
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

  const { applied, topup: updatedTopup } = await db.applyWalletTopupOcrUpdate(
    topupId,
    updateData,
    expectedSlipVersion
  );

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  // Refused: the top-up was finalized by an admin first, or its slip was
  // replaced while this run was in flight. A duplicate finding must not
  // reopen a decided record or stomp a newer slip's evidence. Recording
  // happens INSIDE buildSupersededResult - never the intended
  // WEAK_DUPLICATE_RISK result above, which never actually landed.
  if (!applied) {
    return await buildSupersededResult(
      topupId,
      expectedSlipVersion,
      recordAttempt,
      intendedConfidence
    );
  }

  // The write landed for the exact slip version this run processed - safe to
  // record the intended outcome now.
  if (recordAttempt) {
    await recordAttempt("needs_review", intendedReason, intendedCategory, intendedConfidence);
  }

  // Send Discord notification for duplicate detection (non-blocking)
  if (topup) {
    // Fire and forget - Discord notification should not block the flow
    sendOCRReviewNotification({
      type: "wallet_topup",
      id: topupId,
      userId,
      expectedAmount: parseFloat(topup.requestedAmount),
      ocrAmount: extractedData?.amount,
      bonusAmount: topup.bonusAmount,
      creditedAmount: topup.creditedAmount,
      reviewReason: verificationResult.reviewReason || "DUPLICATE_UNKNOWN",
      ocrDecision: "needs_review",
      finalConfidence: updateData.finalConfidence,
      duplicateStatus: updateData.duplicateStatus ? JSON.parse(updateData.duplicateStatus) : undefined,
    }).catch((err) => {
      // Already logged in service, just silently ignore
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
  userMessage: string,
  topup?: any, // Topup object for Discord notification
  /**
   * Server-derived identifiers to persist even though OCR produced nothing.
   * Without this the top-up would carry NO strong identifier and manual
   * approval - which now refuses such records - could never clear it.
   */
  extractedData?: ExtractedSlipData,
  expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null },
  recordAttempt?: WalletAttemptRecorder
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

  const { applied, topup: updatedTopup } = await db.applyWalletTopupOcrUpdate(
    topupId,
    updateData,
    expectedSlipVersion
  );

  if (!updatedTopup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to update wallet top-up",
    });
  }

  // Refused: an OCR failure arriving after a human decision must not undo
  // it, and must not overwrite a slip the customer has already replaced.
  // Recording happens INSIDE buildSupersededResult - never a stale TECHNICAL
  // result attributed to a slip this run no longer owns.
  if (!applied) {
    return await buildSupersededResult(topupId, expectedSlipVersion, recordAttempt, null);
  }

  // The write landed for the exact slip version this run processed - safe to
  // record the intended technical-failure outcome now.
  if (recordAttempt) {
    await recordAttempt("technical_failure", reviewReason, "TECHNICAL", null);
  }

  // Send Discord notification for OCR error (non-blocking)
  if (topup) {
    // Fire and forget - Discord notification should not block the flow
    sendOCRReviewNotification({
      type: "wallet_topup",
      id: topupId,
      userId,
      expectedAmount: parseFloat(topup.requestedAmount),
      bonusAmount: topup.bonusAmount,
      creditedAmount: topup.creditedAmount,
      reviewReason,
      ocrDecision: "needs_review",
    }).catch((err) => {
      // Already logged in service, just silently ignore
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
