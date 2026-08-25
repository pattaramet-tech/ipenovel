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
import { R2PrivateStorageError } from "./r2PrivateStorage";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
} from "./slipIdentifierService";
import { claimSlip, describeClaimFailure } from "./slipClaimService";
import { computeSlipFileHash } from "./slipFileHashService";
import { describeProviderFailure, type ProviderDiagnostic } from "./ocrDiagnosticsService";
import { recordOcrAttempt } from "./ocrAttemptService";

/**
 * Thrown to abort an in-flight auto-approval transaction when the slip's
 * strong identifiers could not be claimed - either because another
 * submission already owns them, or because the slip has no strong identifier
 * at all and replay therefore cannot be prevented.
 *
 * A distinct type so the surrounding catch can tell "anti-replay said no"
 * (a business outcome -> manual review) apart from a genuine infrastructure
 * failure (which must keep propagating).
 */
class SlipClaimRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlipClaimRejected";
  }
}

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

  // P0-1 FIX: Prevent re-uploading on finalized payments (fast preflight -
  // the atomic publish below is the authoritative check against a
  // concurrent finalization in this same window).
  // Do not allow resetting approved or rejected payments back to pending
  if (payment.status === "approved" || payment.status === "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for ${payment.status} payment. Payment is finalized.`,
    });
  }

  // ── EXACT-FILE IDENTIFIER ───────────────────────────────────────────────
  // Computed from the bytes actually stored in the private bucket, BEFORE
  // publishing this upload as the payment's current slip, so the SAME
  // atomic write that makes this slip current also seeds ITS OWN strong
  // identifier - a slip still carries a strong identifier when OCR fails
  // completely (provider outage, rate limit, unreadable image), and the
  // window where slipImageUrl pointed at this slip while extractedData
  // still described whatever it replaced never opens.
  //
  // Never client-supplied: computeSlipFileHash takes only the server-held
  // storage reference, so there is no parameter through which a caller could
  // inject a forged hash.
  const slipFileHash = await computeSlipFileHash(input.slipImageUrl);
  const slipSubmittedAt = new Date();

  // ── PUBLISH THE REPLACEMENT SLIP (ATOMIC) ───────────────────────────────
  // The same write that makes this slip current invalidates whatever
  // extraction belonged to the slip it replaces (or to nothing, on a first
  // upload) and seeds this slip's own fileHash - never leaving
  // `slipImageUrl = new, extractedData = old` as an approvable state, even
  // momentarily. Conditioned on the payment still being reviewable: if it
  // was finalized between the preflight above and this write, the
  // replacement is refused rather than reopening a finalized payment.
  const published = await db.publishReplacementSlipIfReviewable(payment.id, {
    slipImageUrl: input.slipImageUrl,
    slipSubmittedAt,
    extractedData: slipFileHash ? JSON.stringify({ fileHash: slipFileHash }) : null,
  });

  if (!published) {
    const current = await db.getPaymentById(payment.id);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for ${current?.status ?? "approved"} payment. Payment is finalized.`,
    });
  }

  // Re-read the row this call just published so later slip-version
  // comparisons compare against exactly what the database stored (e.g. its
  // own timestamp precision), not the pre-write JS Date.
  const publishedPayment = await db.getPaymentById(payment.id);
  const publishedSlipVersion = {
    slipImageUrl: (publishedPayment?.slipImageUrl as string | null) ?? input.slipImageUrl,
    slipSubmittedAt: (publishedPayment?.slipSubmittedAt as Date | null) ?? slipSubmittedAt,
  };

  // Check if OCR is enabled using effective config (Phase 4)
  const effectiveConfig = await getEffectiveOCRConfig();
  const ocrEnabled = effectiveConfig.enabled;

  let verificationResult: any;
  let shouldApprove = false;
  const ocrStartedAt = new Date();
  let providerDiagnostic: ProviderDiagnostic | undefined;

  if (ocrEnabled) {
    // OCR is enabled: run OCR processing with error handling
    console.log(`[OCR] Processing slip for order ${order.id} (OCR enabled)`);
    try {
      // Prepare the image input immediately before every OCR call (never
      // reused/cached across retries). server/services/ocrImageInputService.ts
      // resolves a FRESH signed URL and, in legacy_forge mode, hands it
      // straight through unchanged (a legacy absolute URL also passes
      // through unchanged) - exactly the prior behavior. In generic mode,
      // a private r2p: reference is instead fetched server-side and
      // converted to a base64 data URL (a generic OpenAI-compatible
      // provider rejects a private signed HTTPS URL directly - proven on
      // staging), while a legacy absolute URL is never server-fetched.
      const ocrImageUrl = await prepareSlipImageForOcr(input.slipImageUrl);

      if (!ocrImageUrl) {
        // Image preparation failed (fetch/timeout/size/MIME/legacy-URL-in-
        // generic-mode/unconfigured-LLM/etc. - see ocrImageInputService.ts).
        // Never call parseSlipImage()/invokeLLM() with an empty/absent
        // image: some generic-compatible providers accept or ignore an
        // empty image part and can still return plausible-looking text,
        // which would then be verified and could satisfy auto-approval
        // despite the submitted slip never actually being processed. This
        // fixed, sanitized message (never a signed URL/key/credential) is
        // caught by the same block below as any other OCR technical
        // error, routing the slip to manual review instead.
        throw new Error("OCR_IMAGE_PREPARATION_FAILED");
      }

      // Extract OCR text from slip image (returns structured result with confidence)
      const slipOcrResult = await parseSlipImage(ocrImageUrl);

      // Check if OCR/LLM technical error occurred
      if (slipOcrResult.technicalError) {
        // The sanitized provider diagnostic (HTTP status, runtime mode,
        // attempt count) is preserved rather than collapsed into a generic
        // OCR_PROCESSING_ERROR, so an admin can tell a 503-after-3-retries
        // from a 401 misconfiguration from a bad slip.
        providerDiagnostic = slipOcrResult.providerDiagnostic;
        const reviewReason = slipOcrResult.technicalErrorCode ?? "OCR_PROCESSING_ERROR";
        console.error(
          `[OCR] technical failure for order ${order.id}: ${reviewReason} status=${providerDiagnostic?.providerHttpStatus ?? "n/a"} attempts=${providerDiagnostic?.providerAttemptCount ?? 1}`
        );
        verificationResult = {
          isAutoApproved: false,
          isShadowMode: false,
          reviewReason,
          ocrConfidence: 0,
          detectedBank: null,
          // Even with no OCR result, the exact-file identifier is retained so
          // this slip is still anti-replay protected through manual review.
          extractedData: slipFileHash ? { fileHash: slipFileHash } : null,
          breakdown: { reason: providerDiagnostic?.message ?? "OCR processing failed. Slip sent to manual review." },
          duplicateStatus: {
            isDuplicateReference: false,
            isDuplicateFingerprint: false,
          },
          ocrDecision: "needs_review",
          fingerprint: null,
          providerDiagnostic,
        };
        shouldApprove = false;
      } else {
        // Process slip verification with staging enhancements (shadow mode, metrics)
        verificationResult = await processSlipVerificationStaging(payment.id, slipOcrResult);
        // Attach the server-computed exact-file identifier so it reaches
        // strong-identifier derivation and the claim registry.
        // Attach the exact-file identifier on EVERY outcome, including shadow
        // mode and any path where staging produced no extraction at all - the
        // identifier comes from storage, not from OCR, so it must survive
        // regardless of what the provider returned.
        if (slipFileHash) {
          verificationResult.extractedData = {
            ...(verificationResult.extractedData ?? {}),
            fileHash: slipFileHash,
          };
        }
        // Determine if we should actually approve or just simulate
        shouldApprove = verificationResult.isAutoApproved && !verificationResult.isShadowMode;
      }
    } catch (ocrError) {
      // OCR technical error: send to manual review instead of crashing.
      // describeProviderFailure keeps only sanitized metadata - it never
      // propagates the thrown error's own message, which may embed an
      // endpoint or credential.
      providerDiagnostic = describeProviderFailure(ocrError);
      console.error(
        `[OCR] technical failure for order ${order.id}: ${providerDiagnostic.code} status=${providerDiagnostic.providerHttpStatus ?? "n/a"} attempts=${providerDiagnostic.providerAttemptCount}`
      );
      verificationResult = {
        isAutoApproved: false,
        isShadowMode: false,
        reviewReason: providerDiagnostic.code,
        ocrConfidence: 0,
        detectedBank: null,
        extractedData: slipFileHash ? { fileHash: slipFileHash } : null,
        breakdown: { reason: providerDiagnostic.message },
        duplicateStatus: {
          isDuplicateReference: false,
        },
        providerDiagnostic,
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
      // The server-derived exact-file identifier is persisted even though OCR
      // never ran. Storing null here would leave every slip submitted while
      // OCR is disabled with NO strong identifier, and manual approval now
      // refuses such records - which would make them permanently unapprovable.
      // Computing this needs no provider: it hashes the stored bytes.
      extractedData: slipFileHash ? { fileHash: slipFileHash } : null,
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

  /**
   * The ONE terminal outcome for "this automatic run's evidence is no
   * longer current by the time it tried to write".
   *
   * Two distinct causes share this shape: an admin finalized the payment
   * while OCR ran (`OCR_SUPERSEDED_BY_FINALIZATION`), or the customer
   * uploaded a replacement slip while OCR for the OLD one was still running
   * (`OCR_SUPERSEDED_BY_SLIP_REPLACEMENT` - the payment is still reviewable,
   * but the identifiers this run computed belong to a slip that is no
   * longer displayed). Both leave the row exactly as the winning action left
   * it: no status change, no claim, no credit, no finalization, no stale
   * extraction written. Every race site - the pre-transaction preflight, the
   * locked check inside the financial transaction, and the guarded
   * send-to-review write - returns through here, so an automatic run still
   * leaves exactly one attempt row and one classification.
   *
   * Classified STATE, not TECHNICAL and not a duplicate: nothing failed and
   * nothing was replayed - something else won the row first. The attempt
   * `result` enum has no state member and adding one would need a migration,
   * so `needs_review` carries it, matching the wallet
   * TOPUP_SUPERSEDED_BY_FINALIZATION trade-off.
   */
  const superseded = async (
    reason: "OCR_SUPERSEDED_BY_FINALIZATION" | "OCR_SUPERSEDED_BY_SLIP_REPLACEMENT"
  ) => {
    const current = await db.getPaymentById(payment.id);
    const currentStatus = current?.status ?? payment.status;

    await recordOcrAttempt({
      subjectType: "order_payment",
      subjectId: payment.id,
      trigger: "automatic",
      initiatedByUserId: null,
      startedAt: ocrStartedAt,
      stage: "completed",
      result: "needs_review",
      reviewCategory: "STATE",
      reviewReason: reason,
      confidence:
        verificationResult?.extractedData?.confidenceKnown === false
          ? null
          : (verificationResult?.ocrConfidence ?? null),
      // Sanitized diagnostics only - mode, status and count. Never a URL, a
      // credential, or a raw provider response.
      providerMode: providerDiagnostic?.providerMode ?? null,
      providerHttpStatus: providerDiagnostic?.providerHttpStatus ?? null,
      providerAttemptCount: providerDiagnostic?.providerAttemptCount ?? (ocrEnabled ? 1 : 0),
      verificationSnapshot: JSON.stringify({
        amountMatched: verificationResult?.breakdown?.amountMatched,
        datePresent: verificationResult?.breakdown?.datePresent,
        dateWithinWindow: verificationResult?.breakdown?.dateWithinWindow,
        referencePresent: verificationResult?.breakdown?.referencePresent,
        recipientVerified: verificationResult?.breakdown?.recipientVerified,
        recipientEvidenceType: verificationResult?.breakdown?.recipientEvidenceType,
        confidenceKnown: verificationResult?.breakdown?.confidenceKnown,
        fileHashAvailable: Boolean(slipFileHash),
        supersededReason: reason,
      }),
    });

    return {
      success: true,
      message:
        reason === "OCR_SUPERSEDED_BY_FINALIZATION"
          ? `Payment already ${currentStatus}`
          : `This slip was replaced by a newer upload before automatic processing finished`,
      orderId: order.id,
      paymentId: payment.id,
      status: currentStatus,
      // The CURRENT slip, re-read above - never the pre-write local
      // `payment`, which may describe a slip this row no longer shows.
      slipImageUrl: current?.slipImageUrl ?? input.slipImageUrl,
      isAutoApproved: false,
      isShadowMode: false,
      reviewReason: reason,
      supersededByFinalization: reason === "OCR_SUPERSEDED_BY_FINALIZATION",
    };
  };

  // Sync order status based on verification result
  if (shouldApprove) {
    // ── GUARD: Check if payment is already approved/rejected, or its slip
    // was replaced by another upload while this OCR run was in flight ──────
    const currentPayment = await db.getPaymentById(payment.id);
    if (currentPayment?.status === "approved" || currentPayment?.status === "rejected") {
      console.log(`[OCR] Payment ${payment.id} is already ${currentPayment.status}, skipping re-approval`);

      // Terminal STATE outcome: records exactly one automatic attempt and
      // mutates nothing. See superseded() above.
      return await superseded("OCR_SUPERSEDED_BY_FINALIZATION");
    }
    if (
      currentPayment &&
      !orderService.sameSlipVersion(publishedSlipVersion, {
        slipImageUrl: currentPayment.slipImageUrl as string | null,
        slipSubmittedAt: currentPayment.slipSubmittedAt as Date | null,
      })
    ) {
      // A later upload already replaced the slip this OCR run processed.
      // The row is still reviewable, so the status guard above would not
      // have caught this - the in-transaction slip-version check below
      // would still refuse the claim, but failing fast here skips a
      // pointless transaction/claim attempt.
      console.log(`[OCR] Payment ${payment.id}'s slip was replaced, skipping approval for the superseded upload`);
      return await superseded("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT");
    }

    // Auto-approve, save metadata, mark the order approved, record history,
    // and finalize (points/purchases/coupon usage) all in ONE transaction -
    // if finalizeOrderCompletion's coupon-usage step loses a concurrency
    // race (see db.recordCouponUsage's row lock + re-check), the whole
    // auto-approval rolls back instead of leaving the payment/order marked
    // "approved" with incomplete finalization. A throw here is already
    // handled by every caller as "processing deferred, order stays
    // pending/submitted for manual review" - never reported as a checkout
    // failure - so this is a safe place for that new failure mode to surface.
    const dbConnection = await db.getDb();
    if (!dbConnection) {
      throw new Error("Database connection failed");
    }
    // ── ANTI-REPLAY GATE (auto-approval) ──────────────────────────────────
    // Claimed inside the SAME transaction that approves and finalizes, so
    // one bank transaction can fund exactly one order. If the claim loses a
    // race - or the slip carries no strong identifier at all, meaning replay
    // could not be prevented - this throws, the transaction rolls back, and
    // the catch below routes the slip to manual review. OCR never rejects.
    let autoApprovalBlockedReason: string | null = null;

    try {
      await dbConnection.transaction(async (tx: any) => {
        // ── THE ORDER APPROVAL INVARIANT ─────────────────────────────────
        // Lock, reload, require reviewable - BEFORE the claim and before any
        // value. The preflight above is UX only: it reads outside this
        // transaction and cannot serialize against an admin acting in the
        // window between that read and this lock. Without this, an admin
        // rejecting mid-OCR was overwritten - the slip got claimed, the
        // payment went from `rejected` back to `approved`, and
        // finalizeOrderCompletion created purchases and points for a payment
        // a human had already refused.
        //
        // Shared with the manual admin approval path rather than
        // reimplemented here; that duplication is exactly how the guard added
        // to one path left this one unprotected.
        //
        // `publishedSlipVersion` is passed because, unlike manual admin
        // approval, `identifiers` below come from `verificationResult` - OCR
        // run against a slip snapshot captured BEFORE this lock - rather
        // than from the row reloaded fresh under it. Without this check, a
        // slip replacement that lands between that snapshot and this lock
        // would pass the reviewability check above (a replacement sets
        // status back to "pending") while still claiming identifiers that
        // belong to the slip it replaced.
        await orderService.lockAndRequireReviewablePayment(payment.id, tx, publishedSlipVersion);

        const extractedJson = verificationResult.extractedData
          ? JSON.stringify(verificationResult.extractedData)
          : null;
        const { identifiers, semanticFingerprint } =
          deriveStrongIdentifiersFromExtractedData(extractedJson);

        const claim = await claimSlip(
          {
            sourceType: "order_payment",
            sourceId: payment.id,
            userId: order.userId,
            identifiers,
            semanticFingerprint,
            // Server-derived raw reference, for the LEGACY LOOKUP ONLY. Lets a
            // mixed-case read match a historical row that kept only the
            // upper-cased reference. The claim itself still uses the
            // case-preserving hash above.
            referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(extractedJson),
          },
          tx
        );

        if (!claim.claimed) {
          const ownedByThisPayment =
            claim.reason === "already_claimed" &&
            claim.existingSourceType === "order_payment" &&
            claim.existingSourceId === payment.id;

          if (!ownedByThisPayment) {
            autoApprovalBlockedReason =
              claim.reason === "no_strong_identifier"
                ? "NO_STRONG_IDENTIFIER"
                : // Advisory, not a duplicate verdict: stops auto-approval and
                  // asks a human to resolve. No claim was inserted.
                  claim.reason === "legacy_case_ambiguity"
                  ? "LEGACY_REFERENCE_CASE_AMBIGUITY"
                  : // An approved historical row could not be verified - not
                    // a proven duplicate, not provably clean. Auto-approval
                    // must not guess either way.
                    claim.reason === "legacy_scan_unresolved"
                    ? "LEGACY_APPROVED_SLIP_UNRESOLVED"
                    : // MORE THAN ONE historical source shares this alias -
                      // never resolvable by the single-member "confirm
                      // distinct" flow.
                      claim.reason === "legacy_alias_group_ambiguity"
                      ? "LEGACY_ALIAS_GROUP_AMBIGUITY"
                      : claim.reason === "already_claimed" && claim.conflictKind === "file"
                        ? "DUPLICATE_FILE"
                        : claim.reason === "already_claimed" && claim.conflictKind === "qr"
                          ? "DUPLICATE_QR"
                          : "DUPLICATE_REFERENCE";
            // Abort the whole auto-approval; nothing financial has committed.
            throw new SlipClaimRejected(describeClaimFailure(claim));
          }
        }

        await ApprovalService.approvePaymentWithSource(
          payment.id,
          "auto",
          { autoApprovedAt: new Date() },
          tx
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
      }, tx);

      // Auto-approved: mark order as approved (valid enum value)
      await db.updateOrder(order.id, {
        paymentStatus: "approved",
        status: "approved",
      }, tx);
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
      }, tx);
      // Finalize order: create purchase records, award loyalty points, record coupon usage
        await orderService.finalizeOrderCompletion(order.id, input.userId, tx);
      });
    } catch (claimError) {
      // LOST THE STATE RACE. The transaction rolled back, so no claim, no
      // approval, no order update, no purchases and no points committed - the
      // "a claim must never commit without the value it protects" invariant
      // holds by rollback. Report the persisted state; mutate nothing.
      if (claimError instanceof orderService.SlipVersionChangedError) {
        console.warn(
          `[OCR] auto-approval lost the state race for payment ${payment.id}: slip was replaced`
        );
        return await superseded("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT");
      }

      if (claimError instanceof orderService.PaymentNotReviewableError) {
        console.warn(
          `[OCR] auto-approval lost the state race for payment ${payment.id}: ` +
            `now ${claimError.currentStatus}`
        );
        return await superseded("OCR_SUPERSEDED_BY_FINALIZATION");
      }

      if (!(claimError instanceof SlipClaimRejected)) {
        // A genuine failure (DB error, finalization race). Preserve the
        // pre-existing contract: callers treat a throw here as "processing
        // deferred, order stays pending for manual review".
        throw claimError;
      }

      // Anti-replay blocked auto-approval. Nothing financial committed. Fall
      // through to the manual-review branch below with a precise reason -
      // never a rejection, which only an admin may issue.
      console.warn(
        `[OCR] auto-approval blocked by anti-replay for payment ${payment.id}: ${autoApprovalBlockedReason}`
      );
      shouldApprove = false;
      verificationResult = {
        ...verificationResult,
        isAutoApproved: false,
        reviewReason: autoApprovalBlockedReason ?? "DUPLICATE_REFERENCE",
        ocrDecision: "needs_review",
      };
    }
  }

  if (!shouldApprove) {
    // Pending review: update payment record with OCR metadata.
    //
    // Guarded by publishedSlipVersion: this OCR run's extractedData was
    // computed against the slip THIS request published, so the write must
    // be refused if a later upload has already replaced it - otherwise a
    // slow OCR run for slip B could publish B's extraction after the
    // customer moved on to slip C. Also refused if the payment was
    // finalized in the meantime, so a late OCR result can never reopen it.
    const publishedReview = await ApprovalService.sendToReview(
      payment.id,
      verificationResult.reviewReason || "MANUAL_REVIEW_REQUIRED",
      verificationResult.extractedData,
      verificationResult.fingerprint || null,
      publishedSlipVersion
    );

    if (!publishedReview) {
      const current = await db.getPaymentById(payment.id);
      const reason =
        current && (current.status === "approved" || current.status === "rejected")
          ? "OCR_SUPERSEDED_BY_FINALIZATION"
          : "OCR_SUPERSEDED_BY_SLIP_REPLACEMENT";
      return await superseded(reason);
    }

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

  // ── AUTOMATIC ATTEMPT HISTORY ───────────────────────────────────────────
  // Records the INITIAL run - including the provider failure that usually
  // caused the review in the first place. Previously only rechecks were
  // recorded, so history began at attempt #2 and never showed why the slip
  // needed reviewing. Best-effort by construction: recordOcrAttempt swallows
  // its own errors, so diagnostics can never break money correctness.
  await recordOcrAttempt({
    subjectType: "order_payment",
    subjectId: payment.id,
    trigger: "automatic",
    initiatedByUserId: null,
    startedAt: ocrStartedAt,
    stage: providerDiagnostic
      ? providerDiagnostic.code === "OCR_IMAGE_PREPARATION_FAILED"
        ? "image_preparation"
        : "provider_call"
      : "completed",
    result: !ocrEnabled
      ? "config_blocked"
      : providerDiagnostic
        ? "technical_failure"
        : shouldApprove
          ? "auto_approved"
          : "needs_review",
    reviewCategory: providerDiagnostic
      ? "TECHNICAL"
      : !ocrEnabled
        ? "CONFIG"
        : shouldApprove
          ? null
          : "DATA",
    reviewReason: verificationResult?.reviewReason ?? null,
    confidence:
      verificationResult?.extractedData?.confidenceKnown === false
        ? null
        : (verificationResult?.ocrConfidence ?? null),
    providerMode: providerDiagnostic?.providerMode ?? null,
    providerHttpStatus: providerDiagnostic?.providerHttpStatus ?? null,
    providerAttemptCount: providerDiagnostic?.providerAttemptCount ?? (ocrEnabled ? 1 : 0),
    verificationSnapshot: JSON.stringify({
      amountMatched: verificationResult?.breakdown?.amountMatched,
      datePresent: verificationResult?.breakdown?.datePresent,
      dateWithinWindow: verificationResult?.breakdown?.dateWithinWindow,
      referencePresent: verificationResult?.breakdown?.referencePresent,
      recipientVerified: verificationResult?.breakdown?.recipientVerified,
      recipientEvidenceType: verificationResult?.breakdown?.recipientEvidenceType,
      confidenceKnown: verificationResult?.breakdown?.confidenceKnown,
      fileHashAvailable: Boolean(slipFileHash),
    }),
  });

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
