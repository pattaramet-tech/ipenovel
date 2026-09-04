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
  getRawReferenceForLegacyLookup,
  hasStrongIdentifier,
} from "./slipIdentifierService";
import { recordOcrAttempt } from "./ocrAttemptService";
import {
  computeSlipFileHash,
  describeFileIdentifierStatus,
  type FileIdentifierStatus,
} from "./slipFileHashService";
import type { SlipClaimSourceType } from "./slipClaimService";
import { resolveMatchedSourceNavigation } from "./matchedSourceNavigationService";
import { evaluateSlipConflict, type SlipConflict } from "./slipConflictEvaluator";
import { sameSlipVersion, SLIP_INTEGRITY_BLOCK_REASON } from "./orderService";

/**
 * Carries an already-sanitized provider diagnostic out of the OCR block
 * without it being re-derived (and thereby flattened) by the catch.
 */
class PreservedProviderFailure extends Error {
  constructor(readonly diagnostic: ProviderDiagnostic) {
    super(diagnostic.code);
    this.name = "PreservedProviderFailure";
  }
}

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
  /**
   * The EFFECTIVE freshness window actually used by verification. Returned so
   * the admin panel renders the same number the server judged against,
   * instead of assuming a hard-coded 120.
   */
  effectiveWindowMinutes: number;
  /** Admin-safe file identifier status - never the hash itself. */
  fileIdentifierStatus: FileIdentifierStatus;
  /**
   * True when an admin finalized the payment while this recheck was running.
   * Nothing was written; the finalized evidence is intact.
   */
  supersededByFinalization?: boolean;
  /** True when a legacy case ambiguity needs an explicit admin decision. */
  requiresAdminResolution?: boolean;
  /** Read-only conflict finding. Approve still runs its own atomic claim. */
  duplicate?: {
    strength: "strong" | "legacy_case_ambiguity" | "unresolved" | "legacy_case_ambiguity_group" | "known_collision";
    kind: string;
    matchedSourceType: SlipClaimSourceType;
    matchedSourceId: number;
    /**
     * Resolved server-side so the panel can link to the real detail route. A
     * matched order_payment id is a PAYMENT id and the route is keyed by
     * ORDER id; the client must never guess one from the other.
     */
    matchedOrderId?: number;
    viaLegacyCompatibility: boolean;
  };
}

/**
 * Re-hashes the SAME stored slip against a baseline established earlier in
 * THIS recheck and, on a mismatch OR an unavailable second hash, durably
 * blocks approval - never returns a terminal result that would let normal
 * Approve use the baseline as current file identity for bytes that were
 * never confirmed stable.
 *
 * IPE-001-C08: this checkpoint used to run ONLY after successful OCR
 * (`recomputedFileHash ?? preOcrFileHash` - a missing second hash silently
 * fell back to being treated as stable). The provider/image-preparation
 * failure path had no re-check at all: it terminalized with
 * `technicalPathFileHash = preOcrFileHash` straight from the baseline,
 * regardless of how long the (possibly retried) provider call took or
 * whether the object at that URL changed underneath it. Both are the same
 * class of bug this helper closes uniformly: a hash computed once, before
 * slow work, must never become approval authority without being re-verified
 * immediately before the terminal write that would let it be used.
 *
 * Returns `undefined` when the baseline is confirmed stable (A->A) and the
 * caller should proceed using `baselineHash` as current file identity.
 * Returns a terminal `RecheckOcrResult` (the durable block, or a superseded
 * result if the CAS lost the race) when the caller must return immediately.
 */
async function verifyStableOrBlock(
  payment: any,
  order: any,
  slipVersionAtStart: { slipImageUrl: string | null; slipSubmittedAt: Date | null; evidenceVersion?: number },
  adminUserId: number,
  startedAt: Date,
  config: { maxTimeWindowMinutes: number },
  baselineHash: string,
  providerAttemptCount: number,
  confidenceKnown: boolean
): Promise<RecheckOcrResult | undefined> {
  const rehash = await computeSlipFileHash(payment.slipImageUrl);
  if (rehash === baselineHash) return undefined;

  const wroteBlock = await db.updatePaymentIfNotFinalized(
    payment.id,
    {
      reviewReason: SLIP_INTEGRITY_BLOCK_REASON,
      ocrDecision: "needs_review",
    },
    undefined,
    slipVersionAtStart
  );

  if (!wroteBlock) {
    return await buildSupersededResult(payment, slipVersionAtStart, order.id, adminUserId, startedAt, config);
  }

  const attemptNo = await recordOcrAttempt({
    subjectType: "order_payment",
    subjectId: payment.id,
    trigger: "admin_recheck",
    initiatedByUserId: adminUserId,
    startedAt,
    stage: "completed",
    result: "needs_review",
    reviewCategory: "DATA",
    reviewReason: SLIP_INTEGRITY_BLOCK_REASON,
    providerAttemptCount,
  });

  return {
    paymentId: payment.id,
    orderId: order.id,
    paymentStatus: payment.status,
    attemptNo,
    verificationPassed: false,
    readyForAdminApproval: false,
    reviewReason: SLIP_INTEGRITY_BLOCK_REASON,
    category: "DATA",
    rootCauseSummary:
      "The stored slip image changed while this recheck was running. The originally " +
      "recovered file identifier was kept and nothing was overwritten. Normal Approve is " +
      "now blocked until a stable Recheck re-establishes integrity for this exact slip, or " +
      "the customer uploads a genuine replacement. A human needs to establish which image " +
      "this payment actually belongs to.",
    confidenceKnown,
    // The identifier recovered BEFORE the change is still persisted.
    hasStrongIdentifier: true,
    effectiveWindowMinutes: config.maxTimeWindowMinutes,
    fileIdentifierStatus: describeFileIdentifierStatus({ fileHash: baselineHash }),
  };
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

  // Captured once, up front. Every conditional write this recheck makes
  // below - the pre-OCR fileHash recovery and the final extraction write -
  // requires the row to still carry THIS exact slip, not just still be
  // non-finalized. A customer replacing the slip mid-recheck does not
  // change status (a replacement re-opens it to "pending"), so a status-only
  // CAS would let this recheck of the OLD slip land its result on the NEW
  // one; binding to the version closes that.
  const slipVersionAtStart = {
    slipImageUrl: payment.slipImageUrl as string | null,
    slipSubmittedAt: payment.slipSubmittedAt as Date | null,
    evidenceVersion: Number(payment.evidenceVersion ?? 0),
  };

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

  // ── PRE-OCR: recover and persist the exact-file identifier ────────────
  // Deliberately ABOVE the OCR-enabled guard. This needs no provider - it
  // hashes the stored bytes - and when OCR is disabled the guard returns
  // early, which previously meant a legacy row could never be repaired at
  // all: normal Approve refused NO_STRONG_IDENTIFIER and told the admin to
  // run Recheck, but Recheck could not help under that configuration.
  //
  // Written CONDITIONALLY, so a payment finalized in the meantime is never
  // mutated; losing that race stops the recheck before any provider call.
  const preOcrFileHash = await computeSlipFileHash(payment.slipImageUrl);

  if (preOcrFileHash) {
    const wrote = await db.updatePaymentIfNotFinalized(payment.id, {
      extractedData: mergeFileHashInto(payment.extractedData as string | null, preOcrFileHash),
    }, undefined, slipVersionAtStart);

    if (!wrote) {
      return await buildSupersededResult(payment, slipVersionAtStart, order.id, input.adminUserId, startedAt, config);
    }
  }

  // IPE-001-C08 consistency audit: this early exit persists preOcrFileHash
  // then returns with NO provider call, NO OCR, and no other await between
  // the hash write above and this return - unlike the technical-failure and
  // post-extraction paths, there is no slow work here for the same-URL
  // object to change during, so there is no second boundary to re-verify
  // against. The hash write itself (guarded by slipVersionAtStart, like
  // every other write in this function) IS the terminal boundary, exactly
  // like any first-time hash establishment elsewhere in the codebase - not
  // an instance of the "use a hash after slow work without re-checking it"
  // class verifyStableOrBlock exists to close.
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
      // Reported accurately, never fabricated: the identifier is recovered
      // above without the provider, so a legacy row CAN be repaired while OCR
      // is disabled - which is what lets the admin's later normal Approve
      // derive a strong identifier instead of refusing forever.
      hasStrongIdentifier: Boolean(preOcrFileHash),
      effectiveWindowMinutes: config.maxTimeWindowMinutes,
      fileIdentifierStatus: describeFileIdentifierStatus({ fileHash: preOcrFileHash }),
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
      // Use the diagnostic parseSlipImage already produced. Re-wrapping this
      // in a plain Error (as it previously did) discarded the HTTP status,
      // runtime mode and attempt count, so every failed recheck was recorded
      // as an unspecified one-attempt error - the exact defect Codex flagged.
      throw new PreservedProviderFailure(
        parsed.providerDiagnostic ?? describeProviderFailure(new Error("OCR_PROCESSING_ERROR"))
      );
    }

    ocrText = parsed.text;
    confidenceKnown = parsed.confidenceKnown === true;
    providerConfidence = confidenceKnown ? parsed.ocrConfidence : undefined;
  } catch (error) {
    providerDiagnostic =
      error instanceof PreservedProviderFailure
        ? error.diagnostic
        : describeProviderFailure(error);
    const summary = summarizeRootCause({
      reviewReason: providerDiagnostic.code,
      providerDiagnostic,
    });

    // Already computed AND conditionally persisted before the provider call,
    // while the payment was still pending - so it is valid historical
    // evidence and the panel's AVAILABLE status is backed by a real write.
    //
    // IPE-001-C08: the provider call (or image preparation) that just failed
    // can itself take long enough for the stored object to change underneath
    // it. Re-verify against the SAME baseline right here, before this path
    // can terminalize using it - a mismatch, or an unavailable second hash,
    // durably blocks approval instead of silently trusting a hash that was
    // only ever proven true BEFORE the slow work that just failed.
    if (preOcrFileHash) {
      const blocked = await verifyStableOrBlock(
        payment,
        order,
        slipVersionAtStart,
        input.adminUserId,
        startedAt,
        config,
        preOcrFileHash,
        providerDiagnostic.providerAttemptCount ?? 1,
        false
      );
      if (blocked) return blocked;
    }

    // Deliberately NO write here. Repeating it unconditionally is precisely
    // the hazard: an admin may have finalized the payment during the provider
    // call, and this path must never overwrite approved or rejected evidence.
    const technicalPathFileHash = preOcrFileHash;

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
      // Even with OCR down, the exact-file identifier is recomputed from the
      // stored bytes, so an admin can see the slip is still anti-replay
      // protected for manual handling.
      hasStrongIdentifier: Boolean(technicalPathFileHash),
      effectiveWindowMinutes: config.maxTimeWindowMinutes,
      fileIdentifierStatus: describeFileIdentifierStatus({ fileHash: technicalPathFileHash }),
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

  // ── INTEGRITY: the stored bytes must not change mid-recheck ────────────
  // Re-verify against the SAME baseline established before OCR ran. A
  // mismatch, OR an unavailable second hash (IPE-001-C08 - a transient
  // re-fetch failure must never be mistaken for stability), durably blocks
  // approval via the shared checkpoint: the first hash stays persisted and is
  // NOT overwritten, nothing OCR-derived from unverifiable bytes is
  // published, and Approve is blocked until a stable Recheck or a genuine
  // replacement re-establishes integrity. Guarded by slipVersionAtStart
  // exactly like the other writes below - see verifyStableOrBlock's own doc.
  let effectiveFileHash: string | undefined = preOcrFileHash || undefined;
  if (preOcrFileHash) {
    const blocked = await verifyStableOrBlock(
      payment,
      order,
      slipVersionAtStart,
      input.adminUserId,
      startedAt,
      config,
      preOcrFileHash,
      providerDiagnostic?.providerAttemptCount ?? 1,
      confidenceKnown
    );
    if (blocked) return blocked;
  } else {
    // ── MONOTONIC: a recheck may ADD a strong identifier, never REMOVE one ──
    // No pre-OCR baseline existed at all (the very first hash attempt
    // failed), so there is nothing to verify against - but this second
    // attempt, taken from the SAME stored bytes, may still succeed and give
    // this payment an identifier it never had.
    effectiveFileHash = await computeSlipFileHash(payment.slipImageUrl);
  }

  const extractedWithFile = effectiveFileHash
    ? { ...extracted, fileHash: effectiveFileHash }
    : extracted;

  const { identifiers } = deriveStrongIdentifiersFromExtractedData(
    JSON.stringify(extractedWithFile)
  );
  const strongIdentifierPresent = hasStrongIdentifier(identifiers);

  // ── GLOBAL DUPLICATE LOOKUP (READ-ONLY) ───────────────────────────────
  // A recheck must never report READY FOR ADMIN APPROVAL for a slip whose
  // identifiers are already owned by another submission - that would invite
  // an admin to approve something Approve is guaranteed to refuse.
  //
  // Strictly read-only: it queries the claim registry and the pre-migration
  // approved records, and NEVER inserts a claim. Approve remains the sole
  // authority and runs its own atomic claim, so a race opened after this
  // read is still closed there.
  // Delegated to the SAME shared evaluator the claim path uses, so Recheck
  // cannot report READY for a payment Approve is guaranteed to refuse. It
  // previously consulted the registry and the legacy scan but NOT the
  // advisory alias, which is exactly how that contradiction arose.
  let conflict: SlipConflict = { kind: "none" };

  if (strongIdentifierPresent) {
    const database = await db.getDb();
    if (database) {
      conflict = await evaluateSlipConflict(
        {
          identifiers,
          rawReference: getRawReferenceForLegacyLookup(JSON.stringify(extractedWithFile)),
          sourceType: "order_payment",
          sourceId: payment.id,
        },
        database
      );
    }
  }

  const strongDuplicate = conflict.kind === "strong_duplicate" ? conflict : undefined;
  const legacyAmbiguity = conflict.kind === "legacy_case_ambiguity" ? conflict : undefined;
  // An approved historical row that could not be verified at all - no
  // persisted fileHash, none recoverable from its own stored bytes. Not a
  // proven duplicate and not provably clean, so it must block READY exactly
  // as firmly as a duplicate: normal Approve is guaranteed to refuse with
  // LEGACY_APPROVED_SLIP_UNRESOLVED (server/services/slipClaimService.ts),
  // and reporting READY here would send the admin into that refusal.
  const unresolvedLegacy = conflict.kind === "unresolved" ? conflict : undefined;
  // MORE THAN ONE historical source shares the alias this submission folds
  // to. Distinct from a single-member legacyAmbiguity: there is no audited
  // "confirm distinct" escape for this state, since any such resolution
  // could only ever have adjudicated one arbitrary member of the group.
  const aliasGroupAmbiguity =
    conflict.kind === "legacy_case_ambiguity_group" ? conflict : undefined;
  // This submission's own strong identifier durably matches a KNOWN
  // historical collision (paymentSlipLegacyCollisions). Same "no waiver,
  // block READY" treatment as aliasGroupAmbiguity: Approve is guaranteed to
  // refuse with LEGACY_KNOWN_COLLISION.
  const knownCollision = conflict.kind === "known_collision" ? conflict : undefined;

  // Resolve the matched source to something an admin can actually open. Same
  // shared helper the detail query uses, so the two cannot disagree.
  const matchedSource =
    strongDuplicate ?? legacyAmbiguity ?? unresolvedLegacy ?? aliasGroupAmbiguity ?? knownCollision;
  let matchedNavigation: { orderId?: number } = {};
  if (matchedSource) {
    const navDb = await db.getDb();
    if (navDb) {
      matchedNavigation = await resolveMatchedSourceNavigation(
        matchedSource.matchedSourceType,
        matchedSource.matchedSourceId,
        navDb
      );
    }
  }

  // Passing verification is NOT approval - Approve re-runs its own atomic
  // claim regardless. An ambiguity or an unresolved legacy row blocks READY
  // just as firmly as a duplicate: Approve would return
  // LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION or LEGACY_APPROVED_SLIP_UNRESOLVED
  // respectively, so showing the payment as ready would send the admin into
  // a guaranteed refusal either way.
  const verificationPassed =
    verification.isAutoApproved &&
    !strongDuplicate &&
    !legacyAmbiguity &&
    !unresolvedLegacy &&
    !aliasGroupAmbiguity &&
    !knownCollision;
  const readyForAdminApproval = verificationPassed && strongIdentifierPresent;

  const conflictReason = strongDuplicate
    ? strongDuplicate.matchedKind === "file"
      ? "DUPLICATE_FILE"
      : strongDuplicate.matchedKind === "qr"
        ? "DUPLICATE_QR"
        : "DUPLICATE_REFERENCE"
    : legacyAmbiguity
      ? "LEGACY_REFERENCE_CASE_AMBIGUITY"
      : unresolvedLegacy
        ? "LEGACY_APPROVED_SLIP_UNRESOLVED"
        : aliasGroupAmbiguity
          ? "LEGACY_ALIAS_GROUP_AMBIGUITY"
          : knownCollision
            ? "LEGACY_KNOWN_COLLISION"
            : undefined;

  const reviewReason =
    conflictReason ??
    (verification.isAutoApproved
      ? strongIdentifierPresent
        ? undefined
        : "NO_STRONG_IDENTIFIER"
      : verification.reviewReason);

  const matchedConflict =
    strongDuplicate ?? legacyAmbiguity ?? unresolvedLegacy ?? aliasGroupAmbiguity ?? knownCollision;
  const matchedSourceLabel = matchedConflict
    ? matchedConflict.matchedSourceType === "order_payment"
      ? `order payment #${matchedConflict.matchedSourceId}`
      : `wallet top-up #${matchedConflict.matchedSourceId}`
    : null;

  const summary = summarizeRootCause({
    reviewReason,
    readyForAdminApproval,
    duplicateSourceLabel: matchedSourceLabel,
  });

  // Refresh the DISPLAY metadata only. status/slipSubmittedAt are excluded
  // by construction - this update names every column it writes.
  // CONDITIONAL: only while the payment is still non-finalized. An admin may
  // have approved or rejected it during the provider call, and a late recheck
  // must never replace finalized evidence - for an approval the persisted
  // extraction could otherwise disagree with the identifiers already written
  // to paymentSlipClaims.
  const wroteFinal = await db.updatePaymentIfNotFinalized(payment.id, {
    extractedData: JSON.stringify(extractedWithFile),
    ocrConfidence: extracted.confidence ?? 0,
    reviewReason: reviewReason ?? null,
    ocrDecision: "needs_review",
  }, undefined, slipVersionAtStart);

  if (!wroteFinal) {
    // Lost the race. The pre-OCR fileHash write - made while the payment was
    // still pending - stands as valid historical evidence; nothing else is
    // touched.
    return await buildSupersededResult(payment, slipVersionAtStart, order.id, input.adminUserId, startedAt, config);
  }

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
    effectiveWindowMinutes: config.maxTimeWindowMinutes,
    fileIdentifierStatus: describeFileIdentifierStatus({
      // The EFFECTIVE hash: reporting UNAVAILABLE after a transient second
      // fetch failure would contradict the identifier still persisted.
      fileHash: effectiveFileHash,
      duplicateFileMatch: strongDuplicate?.matchedKind === "file",
    }),
    // Strong duplicate and legacy ambiguity are reported as DIFFERENT
    // strengths, so the panel can never render an advisory fold with the
    // confident language of proof.
    duplicate: strongDuplicate
      ? {
          strength: "strong",
          kind: strongDuplicate.matchedKind,
          matchedSourceType: strongDuplicate.matchedSourceType,
          matchedSourceId: strongDuplicate.matchedSourceId,
          matchedOrderId: matchedNavigation.orderId,
          viaLegacyCompatibility: strongDuplicate.viaLegacyCompatibility,
        }
      : legacyAmbiguity
        ? {
            strength: "legacy_case_ambiguity",
            kind: "reference",
            matchedSourceType: legacyAmbiguity.matchedSourceType,
            matchedSourceId: legacyAmbiguity.matchedSourceId,
            matchedOrderId: matchedNavigation.orderId,
            viaLegacyCompatibility: true,
          }
        : unresolvedLegacy
          ? {
              // A THIRD, distinct strength - never "strong" (it is not proof)
              // and never "legacy_case_ambiguity" (that has its own audited
              // admin resolution flow this state does not support; an
              // unresolved row means the evidence needed to evaluate it is
              // missing, not that two references happen to fold together).
              strength: "unresolved",
              kind: "unresolved",
              matchedSourceType: unresolvedLegacy.matchedSourceType,
              matchedSourceId: unresolvedLegacy.matchedSourceId,
              matchedOrderId: matchedNavigation.orderId,
              viaLegacyCompatibility: true,
            }
          : aliasGroupAmbiguity
            ? {
                // A FOURTH, distinct strength - MORE THAN ONE historical
                // source shares this alias. Never "legacy_case_ambiguity":
                // that state's audited "confirm distinct" resolution can only
                // ever adjudicate ONE member, which is exactly what this
                // state exists to refuse.
                strength: "legacy_case_ambiguity_group",
                kind: "reference",
                matchedSourceType: aliasGroupAmbiguity.matchedSourceType,
                matchedSourceId: aliasGroupAmbiguity.matchedSourceId,
                matchedOrderId: matchedNavigation.orderId,
                viaLegacyCompatibility: true,
              }
            : knownCollision
              ? {
                  // A FIFTH, distinct strength - this submission's own
                  // strong identifier durably matches a KNOWN historical
                  // collision. Never "strong" (we don't know THIS submission
                  // is one of the colliding rows) and never a resolvable
                  // ambiguity - there is no waiver for an unpicked group.
                  strength: "known_collision",
                  kind: knownCollision.matchedKind,
                  matchedSourceType: knownCollision.matchedSourceType,
                  matchedSourceId: knownCollision.matchedSourceId,
                  matchedOrderId: matchedNavigation.orderId,
                  viaLegacyCompatibility: true,
                }
              : undefined,
    // Only a single-member legacy-case ambiguity has an audited "confirm
    // distinct" escape. An unresolved row and an alias GROUP ambiguity are
    // not that state - both mean an admin must investigate manually rather
    // than adjudicate a single casing fold - so neither may route into that
    // resolution UI.
    requiresAdminResolution: Boolean(legacyAmbiguity),
  };
}


/**
 * Merges a server-derived file hash into a persisted extraction WITHOUT
 * discarding what is already there - a provider failure must never destroy
 * financial evidence an earlier successful read had stored.
 *
 * A corrupt blob falls back to the identifier alone, which cannot lose data
 * because nothing was readable out of it anyway.
 */
export function mergeFileHashInto(
  existingJson: string | null | undefined,
  fileHash: string
): string {
  let merged: Record<string, unknown> = {};
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : null;
    if (parsed && typeof parsed === "object") merged = parsed;
  } catch {
    merged = {};
  }
  merged.fileHash = fileHash;
  return JSON.stringify(merged);
}

/**
 * Result for a recheck that finished after an admin already finalized the
 * payment.
 *
 * Classified as STATE, deliberately NOT as a provider/OCR failure or a
 * duplicate: the provider may have worked perfectly and the slip may be
 * fine - the only thing that happened is that a human got there first.
 * Mislabelling it would send an admin chasing an OCR problem that does not
 * exist.
 *
 * Nothing is written here. The attempt is still recorded for diagnostics.
 */
async function buildSupersededResult(
  originalPayment: any,
  slipVersionAtStart: { slipImageUrl: string | null; slipSubmittedAt: Date | null; evidenceVersion?: number },
  orderId: number,
  adminUserId: number,
  startedAt: Date,
  config: { maxTimeWindowMinutes: number }
): Promise<RecheckOcrResult> {
  // Reload so the admin sees the CURRENT state that beat this recheck.
  const current = await db.getPaymentById(originalPayment.id);
  const currentStatus = current?.status ?? originalPayment.status;
  const isFinalized = currentStatus === "approved" || currentStatus === "rejected";

  // Two distinct causes lose this CAS: an admin finalized the payment while
  // this recheck ran, or the customer replaced the slip this recheck
  // started against (which does NOT change status - a replacement re-opens
  // it to "pending"). Comparing the reloaded row's slip identity against the
  // one this recheck was bound to tells them apart, so the admin is told
  // which one actually happened rather than always being told "finalized"
  // when the payment may still be sitting in pending_review on a new slip.
  const slipReplaced =
    !isFinalized &&
    current != null &&
    !sameSlipVersion(slipVersionAtStart, {
      slipImageUrl: current.slipImageUrl as string | null,
      slipSubmittedAt: current.slipSubmittedAt as Date | null,
      evidenceVersion: Number(current.evidenceVersion ?? 0),
    });

  const reviewReason = slipReplaced
    ? "RECHECK_SUPERSEDED_BY_SLIP_REPLACEMENT"
    : "RECHECK_SUPERSEDED_BY_FINALIZATION";

  const attemptNo = await recordOcrAttempt({
    subjectType: "order_payment",
    subjectId: originalPayment.id,
    trigger: "admin_recheck",
    initiatedByUserId: adminUserId,
    startedAt,
    stage: "completed",
    // needs_review, not technical_failure: nothing technical went wrong.
    result: "needs_review",
    reviewCategory: "STATE",
    reviewReason,
    providerAttemptCount: 0,
  });

  return {
    paymentId: originalPayment.id,
    orderId,
    paymentStatus: currentStatus,
    attemptNo,
    verificationPassed: false,
    readyForAdminApproval: false,
    reviewReason,
    category: "DATA",
    rootCauseSummary: slipReplaced
      ? "This recheck finished after the customer had already replaced the slip it started " +
        "against. No OCR evidence was written - the new slip is untouched and needs its own " +
        "recheck."
      : "This recheck finished after the payment was already finalized. No OCR evidence " +
        "was changed.",
    confidenceKnown: false,
    hasStrongIdentifier: false,
    effectiveWindowMinutes: config.maxTimeWindowMinutes,
    fileIdentifierStatus: "UNAVAILABLE",
    supersededByFinalization: !slipReplaced,
  };
}
