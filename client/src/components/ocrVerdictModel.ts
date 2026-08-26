/**
 * Pure presentation model for the Admin OCR Detail panel.
 *
 * Kept React-free and in its own module so it can be unit tested directly:
 * this repo's unit test project runs in a Node environment with no DOM and no
 * React Testing Library (same pattern as client/src/pages/adminUsersPagination.ts).
 * The component below renders exactly what these functions return, so testing
 * this module IS testing what an admin sees.
 *
 * GOAL: an admin should learn what happened by LOOKING, not by reading raw
 * JSON. Every derived string here is written for that reader.
 *
 * This module never decides anything financial - it only describes state that
 * the server already decided.
 */

import {
  effectiveFreshnessWindowMinutes,
  isWithinFreshnessWindow,
} from "@shared/slipFreshness";

export type CheckState = "pass" | "fail" | "warning" | "not_evaluated";

export type OcrVerdict =
  | "auto_approved"
  /**
   * Shadow mode's `ocrDecision: "shadow_auto_approved"` - the server
   * DELIBERATELY forced `isAutoApproved: false` (see
   * server/ocr-slip-integration-staging.ts), so the payment stays
   * `pending_review` and NO financial value was created. This records only
   * what auto-approval WOULD have decided, for monitoring/comparison. It
   * must never render as if real approval happened - see verdictLabel and
   * the "final" checklist row below.
   */
  | "shadow_auto_approved"
  | "ready_for_admin_approval"
  | "needs_review"
  | "ocr_disabled"
  | "unknown";

export interface ChecklistRow {
  key: string;
  label: string;
  state: CheckState;
  detail?: string;
}

export interface OcrPanelInput {
  ocrDecision?: string | null;
  reviewReason?: string | null;
  ocrConfidence?: number | null;
  paymentStatus?: string | null;
  /** Server-reported, set after a recheck whose verification passed. */
  readyForAdminApproval?: boolean;
  extracted?: {
    amount?: number;
    reference?: string;
    referenceRaw?: string;
    referenceNormalized?: string;
    referenceHash?: string;
    semanticFingerprint?: string;
    confidenceKnown?: boolean;
    transactionDate?: string | Date;
    transactionDateTime?: string | Date;
    detectedBank?: string;
    detectedBankName?: string;
    merchantCode?: string;
    merchantTransactionCode?: string;
    receiverAccountOrId?: string;
    shopName?: string;
    receiverName?: string;
    maskedAccount?: string;
  } | null;
  expectedAmount?: number | null;
  slipSubmittedAt?: string | Date | null;
  allowedWindowMinutes?: number | null;
  /** Legacy rows carry a fingerprint with no strength information. */
  legacyFingerprint?: string | null;
  duplicate?: {
    strength?:
      | "strong"
      | "weak"
      | "legacy_case_ambiguity"
      | "unresolved"
      | "legacy_case_ambiguity_group";
    matchedSourceType?: "order_payment" | "wallet_topup";
    matchedSourceId?: number;
    /**
     * RESOLVED SERVER-SIDE for an order payment. A matched `order_payment`
     * id is a PAYMENT id, while the detail route is keyed by ORDER id, so
     * this cannot be derived on the client - guessing would link confidently
     * to the wrong order. Absent means "no link", never "invent one".
     */
    matchedOrderId?: number;
    /** True when found in pre-migration approved records, not the registry. */
    viaLegacyCompatibility?: boolean;
  } | null;
  /**
   * The server's recipient verdict (verifySlipData's breakdown). When present
   * it is authoritative and is rendered verbatim; the local grading is only a
   * legacy-row display fallback.
   */
  serverRecipient?: {
    recipientVerified?: boolean;
    recipientEvidenceType?: string;
    recipientEvidenceStrength?: string;
  } | null;
  /** Admin-safe exact-file identifier status. The hash itself is never sent. */
  fileIdentifierStatus?: "AVAILABLE" | "MATCH" | "UNAVAILABLE" | null;
  providerDiagnostic?: {
    code?: string;
    providerHttpStatus?: number;
    providerAttemptCount?: number;
    message?: string;
  } | null;
  rootCauseSummary?: string | null;
  category?: "TECHNICAL" | "DATA" | "CONFIG" | null;
}

// ─── Verdict ──────────────────────────────────────────────────────────────

export function deriveVerdict(input: OcrPanelInput): OcrVerdict {
  if (input.readyForAdminApproval) return "ready_for_admin_approval";
  // Checked BEFORE "auto_approved" - shadow is what auto-approval simulated,
  // never what it actually did. Collapsing the two here would be the exact
  // bug this state exists to prevent: a payment still sitting pending_review
  // rendering as if it were already finalized.
  if (input.ocrDecision === "shadow_auto_approved") return "shadow_auto_approved";
  if (input.ocrDecision === "auto_approved") return "auto_approved";
  if (input.ocrDecision === "ocr_disabled" || input.reviewReason === "OCR_DISABLED") {
    return "ocr_disabled";
  }
  if (input.ocrDecision === "needs_review" || input.reviewReason) return "needs_review";
  return "unknown";
}

export function verdictLabel(verdict: OcrVerdict): string {
  switch (verdict) {
    case "auto_approved":
      return "AUTO APPROVED";
    case "shadow_auto_approved":
      // "SIMULATED", never "APPROVED" alone - this payment is still
      // pending_review and no value was created.
      return "SIMULATED AUTO-APPROVE (SHADOW MODE, NOT APPROVED)";
    case "ready_for_admin_approval":
      return "READY FOR ADMIN APPROVAL";
    case "needs_review":
      return "NEEDS REVIEW";
    case "ocr_disabled":
      return "OCR DISABLED";
    default:
      return "UNKNOWN";
  }
}

// ─── Time comparison ──────────────────────────────────────────────────────

function toDate(value: string | Date | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export interface TimeComparison {
  transactionAt?: Date;
  submittedAt?: Date;
  differenceMinutes?: number;
  allowedWindowMinutes?: number;
  withinWindow?: boolean;
  /**
   * Set when the gap is so large it more likely reflects an OCR year misread
   * on a Thai-calendar slip than a genuinely ancient transfer. Advisory text
   * for a human - never used to alter the parsed value.
   */
  possibleMisreadWarning?: string;
}

/** A year or more apart is far likelier a misread year than a real transfer. */
const MISREAD_HINT_THRESHOLD_MINUTES = 365 * 24 * 60;

export function compareTransactionTime(input: OcrPanelInput): TimeComparison {
  const hasTransactionTime = Boolean(input.extracted?.transactionDateTime);
  const transactionAt =
    toDate(input.extracted?.transactionDateTime) ?? toDate(input.extracted?.transactionDate);
  const submittedAt = toDate(input.slipSubmittedAt);

  // The allowance is derived with the SAME shared rule the server verifies
  // with (shared/slipFreshness.ts), so a date-only result gets the server's
  // at-least-one-day floor here too. Comparing every result against the bare
  // configured window is what made the panel show FAIL for date-only slips
  // the server had accepted.
  const allowedWindowMinutes =
    input.allowedWindowMinutes == null
      ? undefined
      : effectiveFreshnessWindowMinutes(input.allowedWindowMinutes, hasTransactionTime);

  if (!transactionAt || !submittedAt) {
    return { transactionAt, submittedAt, allowedWindowMinutes };
  }

  const differenceMinutes = Math.round(
    (submittedAt.getTime() - transactionAt.getTime()) / 60000
  );

  const withinWindow =
    allowedWindowMinutes === undefined
      ? undefined
      : isWithinFreshnessWindow(differenceMinutes, allowedWindowMinutes);

  const possibleMisreadWarning =
    Math.abs(differenceMinutes) >= MISREAD_HINT_THRESHOLD_MINUTES
      ? "The gap is a year or more. Thai-calendar slips are commonly misread by OCR " +
        "(e.g. 69 read as 67). Compare the date on the slip image before deciding - " +
        "the value shown here is what OCR read, uncorrected."
      : undefined;

  return {
    transactionAt,
    submittedAt,
    differenceMinutes,
    allowedWindowMinutes,
    withinWindow,
    possibleMisreadWarning,
  };
}

// ─── Duplicate presentation ───────────────────────────────────────────────

export interface DuplicatePresentation {
  strength:
    | "strong"
    | "weak"
    | "legacy"
    | "legacy_case_ambiguity"
    | "unresolved"
    | "legacy_case_ambiguity_group"
    | "none";
  headline: string;
  /** Always present for weak/legacy - the caveat must never be omitted. */
  caveat?: string;
  matchedLabel?: string;
  matchedHref?: string;
}

/**
 * The ONLY place a matched-source link is built.
 *
 * Previously each branch wrote its own URL, and both wrote ones that do not
 * navigate anywhere useful: `/admin/orders?paymentId=` and
 * `/admin/topup-logs?topupId=` are not the detail routes, and the list pages
 * ignore those parameters entirely.
 *
 * These are the routes actually registered in App.tsx:
 *   /admin/orders/:orderId
 *   /admin/wallet-topups/:topupId
 *
 * `href` is null when the target cannot be resolved. The panel then shows the
 * source as plain text - a correct dead end beats a confident wrong link.
 */
export function matchedSourceNavigation(dup: {
  matchedSourceType?: "order_payment" | "wallet_topup";
  matchedSourceId?: number;
  matchedOrderId?: number;
} | null | undefined): { label: string; href: string | null } | undefined {
  if (!dup?.matchedSourceType || !dup?.matchedSourceId) return undefined;

  if (dup.matchedSourceType === "order_payment") {
    return {
      label: `Order payment #${dup.matchedSourceId}`,
      href:
        typeof dup.matchedOrderId === "number"
          ? `/admin/orders/${dup.matchedOrderId}`
          : null,
    };
  }

  return {
    label: `Wallet top-up #${dup.matchedSourceId}`,
    href: `/admin/wallet-topups/${dup.matchedSourceId}`,
  };
}

const WEAK_CAVEAT =
  "Possible duplicate only - not proof of a duplicate transaction. The same customer " +
  "may legitimately transfer the same amount from the same account more than once on " +
  "the same day.";

export function describeDuplicate(input: OcrPanelInput): DuplicatePresentation {
  const dup = input.duplicate;

  // A legacy CASE ambiguity is not a duplicate finding at all - it is an
  // unanswered question. Shown first so it can never be rendered with the
  // confident language of a strong match.
  if (
    input.reviewReason === "LEGACY_REFERENCE_CASE_AMBIGUITY" ||
    dup?.strength === "legacy_case_ambiguity"
  ) {
    const matched = matchedSourceNavigation(dup);

    return {
      strength: "legacy_case_ambiguity",
      headline: "Legacy reference case ambiguity",
      caveat:
        "This reference matches an older transaction only when letter casing is ignored. " +
        "That older record lost its original casing, so this is NOT proof the transaction " +
        "is duplicated - the two references may be genuinely different. An admin must " +
        "decide: reject it as a duplicate, or approve it as a distinct transaction.",
      matchedLabel: matched?.label,
      matchedHref: matched?.href ?? undefined,
    };
  }

  // An approved historical record could not be verified at all - not a
  // proven duplicate, not provably clean. Shown before "strong"/"weak" so it
  // can never be silently swallowed by a later, more confident-sounding
  // branch, and never falls through to "No duplicate signal": that would
  // hide a real blocker from the admin (Approve refuses server-side with
  // LEGACY_APPROVED_SLIP_UNRESOLVED regardless of what the panel shows).
  if (
    input.reviewReason === "LEGACY_APPROVED_SLIP_UNRESOLVED" ||
    dup?.strength === "unresolved"
  ) {
    const matched = matchedSourceNavigation(dup);

    return {
      strength: "unresolved",
      headline: "Historical record could not be verified",
      caveat:
        "An approved record predates the claim registry and its slip image could not be " +
        "verified server-side, so historical replay protection for it is incomplete. This " +
        "is NOT a proven duplicate - it cannot be confirmed either way. An admin must " +
        "review the historical record manually before this can be approved.",
      matchedLabel: matched?.label,
      matchedHref: matched?.href ?? undefined,
    };
  }

  // MORE THAN ONE historical source shares this lossy alias - never a
  // duplicate verdict, and never safely waivable by adjudicating just one
  // arbitrary member (Approve refuses server-side with
  // LEGACY_ALIAS_GROUP_AMBIGUITY and never consults a single-member
  // resolution for this state). Shown before "strong"/"weak" for the same
  // reason as above - it must never read as "No duplicate signal".
  if (
    input.reviewReason === "LEGACY_ALIAS_GROUP_AMBIGUITY" ||
    dup?.strength === "legacy_case_ambiguity_group"
  ) {
    const matched = matchedSourceNavigation(dup);

    return {
      strength: "legacy_case_ambiguity_group",
      headline: "Multiple historical records share this reference (case-folded)",
      caveat:
        "This reference matches MORE THAN ONE approved historical record - including the " +
        "one shown below, if any - only after letter casing is ignored. Because more than " +
        "one older record shares this fold, no single one of them can be safely confirmed " +
        "as distinct: this submission could be a replay of any member of that group. This " +
        "is NOT proof of a duplicate. An admin must manually investigate the complete " +
        "group of matching historical records before this can be approved.",
      matchedLabel: matched?.label,
      matchedHref: matched?.href ?? undefined,
    };
  }

  if (dup?.strength === "strong") {
    const matched = matchedSourceNavigation(dup);

    return {
      strength: "strong",
      headline: dup.viaLegacyCompatibility
        ? "Confirmed duplicate - matched an approved record that predates the claim registry."
        : "Confirmed duplicate - a strong identifier matched an earlier submission.",
      matchedLabel: matched?.label,
      matchedHref: matched?.href ?? undefined,
    };
  }

  if (dup?.strength === "weak" || input.reviewReason === "WEAK_DUPLICATE_RISK") {
    return {
      strength: "weak",
      headline: "Possible duplicate (weak signal)",
      caveat: WEAK_CAVEAT,
    };
  }

  // A pre-existing row stores only an opaque fingerprint with no recorded
  // strength. It must be shown as LEGACY/WEAK rather than inheriting the
  // credibility of a strong identifier by default.
  if (input.legacyFingerprint && !input.extracted?.referenceHash) {
    return {
      strength: "legacy",
      headline: "Legacy fingerprint (weak)",
      caveat:
        "This submission predates strong identifiers. Its fingerprint is a coarse " +
        "bank/account/amount/date hash and is NOT proof of a duplicate transaction.",
    };
  }

  return { strength: "none", headline: "No duplicate signal" };
}

// ─── Verification checklist ───────────────────────────────────────────────

/**
 * Builds the row-per-check list shown in the panel.
 *
 * "not_evaluated" is a first-class state: when the pipeline stopped early
 * (say the provider was down), later checks genuinely never ran, and showing
 * them as failures would blame the slip for an outage.
 */
export function buildChecklist(input: OcrPanelInput): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const technical = input.category === "TECHNICAL";
  const e = input.extracted ?? undefined;

  // Provider + image preparation
  const providerFailed = technical && !!input.providerDiagnostic;
  const prepFailed = input.providerDiagnostic?.code === "OCR_IMAGE_PREPARATION_FAILED";

  rows.push({
    key: "provider",
    label: "OCR Provider",
    state: providerFailed && !prepFailed ? "fail" : technical && prepFailed ? "not_evaluated" : "pass",
    detail:
      providerFailed && !prepFailed
        ? `${input.providerDiagnostic?.message ?? "Provider failed"}${
            input.providerDiagnostic?.providerHttpStatus
              ? ` (HTTP ${input.providerDiagnostic.providerHttpStatus}, ${input.providerDiagnostic.providerAttemptCount ?? 1} attempt(s))`
              : ""
          }`
        : prepFailed
          ? "Never called - the image could not be prepared."
          : undefined,
  });

  rows.push({
    key: "image",
    label: "Image Preparation",
    state: prepFailed ? "fail" : "pass",
    detail: prepFailed ? input.providerDiagnostic?.message : undefined,
  });

  // Everything below depends on OCR text existing at all.
  const notEvaluated = technical;

  const amountState: CheckState = notEvaluated
    ? "not_evaluated"
    : e?.amount === undefined
      ? "fail"
      : input.expectedAmount != null && Math.abs(e.amount - input.expectedAmount) < 0.01
        ? "pass"
        : "fail";

  rows.push({
    key: "amount",
    label: "Amount",
    state: amountState,
    detail:
      notEvaluated || e?.amount === undefined
        ? e?.amount === undefined && !notEvaluated
          ? "No amount could be read from the slip."
          : undefined
        : `Expected ${input.expectedAmount ?? "?"} / extracted ${e.amount}`,
  });

  const recipient = describeRecipient(input);
  rows.push({
    key: "recipient",
    label: "Recipient / Merchant",
    state: notEvaluated ? "not_evaluated" : recipient.state,
    detail: notEvaluated ? undefined : recipient.detail,
  });

  const time = compareTransactionTime(input);
  rows.push({
    key: "transaction_date",
    label: "Transaction Date",
    state: notEvaluated ? "not_evaluated" : time.transactionAt ? "pass" : "fail",
    detail: !notEvaluated && !time.transactionAt ? "No usable transaction date was read." : undefined,
  });

  rows.push({
    key: "transaction_time",
    label: "Transaction Time",
    state: notEvaluated
      ? "not_evaluated"
      : e?.transactionDateTime
        ? "pass"
        : time.transactionAt
          ? "warning"
          : "not_evaluated",
    detail:
      !notEvaluated && !e?.transactionDateTime && time.transactionAt
        ? "Date only - no time of day was read, so freshness is judged loosely."
        : undefined,
  });

  rows.push({
    key: "freshness",
    label: "Freshness",
    state: notEvaluated
      ? "not_evaluated"
      : time.withinWindow === undefined
        ? "not_evaluated"
        : time.withinWindow
          ? "pass"
          : "fail",
    detail:
      time.differenceMinutes !== undefined
        ? `${time.differenceMinutes} min after submission${
            time.allowedWindowMinutes ? ` (allowed ${time.allowedWindowMinutes} min)` : ""
          }`
        : undefined,
  });

  const referenceValue = e?.referenceRaw ?? e?.reference;
  rows.push({
    key: "reference",
    label: "Reference",
    state: notEvaluated ? "not_evaluated" : referenceValue ? "pass" : "fail",
    detail: !notEvaluated && !referenceValue ? "No transaction reference was found." : referenceValue,
  });

  const dup = describeDuplicate(input);
  rows.push({
    key: "duplicate_reference",
    label: "Duplicate Reference",
    state:
      input.reviewReason === "DUPLICATE_REFERENCE" ? "fail" : notEvaluated ? "not_evaluated" : "pass",
  });

  rows.push({
    key: "duplicate_file",
    label: "Exact File Duplicate",
    state:
      input.reviewReason === "DUPLICATE_FILE" || input.fileIdentifierStatus === "MATCH"
        ? "fail"
        : input.fileIdentifierStatus === "AVAILABLE"
          ? "pass"
          : "not_evaluated",
    // The raw hash is never shown - it fingerprints a customer's payment
    // document and would leak into screenshots and support tickets.
    detail:
      input.fileIdentifierStatus === "UNAVAILABLE"
        ? "Exact File Identifier: UNAVAILABLE"
        : `Exact File Identifier: ${input.fileIdentifierStatus ?? "UNAVAILABLE"}`,
  });

  rows.push({
    key: "duplicate_qr",
    label: "QR Duplicate",
    // QR decoding is not implemented yet, so this genuinely never ran.
    state: input.reviewReason === "DUPLICATE_QR" ? "fail" : "not_evaluated",
    detail: input.reviewReason === "DUPLICATE_QR" ? undefined : "QR decoding is not enabled.",
  });

  rows.push({
    key: "legacy_case_ambiguity",
    label: "Legacy Case Ambiguity",
    // WARNING, never FAIL: nothing is proven, and a human decides.
    state: dup.strength === "legacy_case_ambiguity" ? "warning" : "not_evaluated",
    detail:
      dup.strength === "legacy_case_ambiguity"
        ? "Matches an older reference only after case folding. Requires admin resolution."
        : undefined,
  });

  rows.push({
    key: "legacy_unresolved",
    label: "Legacy Record Unresolved",
    // WARNING, never FAIL: not a proven duplicate, but never silently PASS -
    // Approve refuses server-side until this is resolved manually.
    state: dup.strength === "unresolved" ? "warning" : "not_evaluated",
    detail:
      dup.strength === "unresolved"
        ? "An approved historical record predates the claim registry and could not be " +
          "verified server-side. Requires manual investigation - not a resolvable ambiguity."
        : undefined,
  });

  rows.push({
    key: "legacy_alias_group",
    label: "Legacy Alias Group Ambiguity",
    state: dup.strength === "legacy_case_ambiguity_group" ? "warning" : "not_evaluated",
    detail:
      dup.strength === "legacy_case_ambiguity_group"
        ? "Matches MORE THAN ONE historical record after case folding. Requires manual " +
          "investigation of the complete group - no single-member resolution applies."
        : undefined,
  });

  rows.push({
    key: "weak_duplicate",
    label: "Weak Duplicate Risk",
    state: dup.strength === "weak" || dup.strength === "legacy" ? "warning" : "pass",
    detail: dup.caveat,
  });

  const confidenceKnown = e?.confidenceKnown !== false;
  rows.push({
    key: "confidence",
    label: "Confidence",
    state: notEvaluated
      ? "not_evaluated"
      : !confidenceKnown
        ? "fail"
        : input.reviewReason === "LOW_CONFIDENCE"
          ? "fail"
          : "pass",
    detail: !confidenceKnown
      ? "Not reported by the provider - auto-approval refused."
      : input.ocrConfidence != null
        ? `${input.ocrConfidence}%`
        : undefined,
  });

  const verdict = deriveVerdict(input);
  rows.push({
    key: "final",
    label: "Final Verification",
    state:
      verdict === "auto_approved" || verdict === "ready_for_admin_approval"
        ? "pass"
        : verdict === "shadow_auto_approved"
          // Neither PASS (no value was created) nor FAIL (verification did
          // not actually fail - shadow mode just never acts on it).
          ? "warning"
          : verdict === "ocr_disabled"
            ? "not_evaluated"
            : "fail",
    detail:
      verdict === "shadow_auto_approved"
        ? "Shadow mode: auto-approval would have passed, but nothing was approved or created."
        : input.rootCauseSummary ?? undefined,
  });

  return rows;
}

// ─── Recipient / merchant verification ────────────────────────────────────

export type RecipientEvidenceType =
  | "merchant_transaction_code"
  | "merchant_code"
  | "biller_id"
  | "receiver_name"
  | "shop_alias"
  | "insufficient";

export interface RecipientVerification {
  verified: boolean;
  evidenceType: RecipientEvidenceType;
  state: CheckState;
  detail: string;
}

export const MERCHANT_EXPECTATIONS = {
  merchantCode: "KB000002283068",
  merchantTransactionCode: "KPS004KB000002283068",
  billerId: "010753600031501",
  shopAliases: ["ipe novel", "ipenovel", "ไอพี โนเวล", "ไอพีโนเวล"],
};

/**
 * Renders the SERVER's recipient verdict when one is present.
 *
 * The financial authority is server-side (verifySlipData -> verifyRecipient);
 * this function must never be the thing that decides whether the money
 * reached IpeNovel. When the server verdict is available on the breakdown it
 * is displayed verbatim. The local grading below is a DISPLAY-ONLY fallback
 * for legacy rows stored before the server gate existed, and is deliberately
 * incapable of authorising anything - nothing reads its result to approve.
 */
export function describeRecipient(input: OcrPanelInput): RecipientVerification {
  const server = input.serverRecipient;
  if (server && server.recipientEvidenceType) {
    const strength = server.recipientEvidenceStrength;
    return {
      verified: server.recipientVerified === true,
      evidenceType: server.recipientEvidenceType as RecipientEvidenceType,
      state: !server.recipientVerified ? "warning" : strength === "strong" ? "pass" : "warning",
      detail: !server.recipientVerified
        ? "Server could not confirm the recipient. Check the slip image manually."
        : strength === "strong"
          ? "Verified by exact merchant/biller code (server-verified)."
          : "Verified by approved shop/receiver name only - weaker than a code match (server-verified).",
    };
  }

  const e = input.extracted;

  if (e?.merchantTransactionCode === MERCHANT_EXPECTATIONS.merchantTransactionCode) {
    return {
      verified: true,
      evidenceType: "merchant_transaction_code",
      state: "pass",
      detail: "Merchant transaction code matched exactly.",
    };
  }

  if (e?.merchantCode === MERCHANT_EXPECTATIONS.merchantCode) {
    return {
      verified: true,
      evidenceType: "merchant_code",
      state: "pass",
      detail: "Merchant code matched exactly.",
    };
  }

  if (e?.receiverAccountOrId === MERCHANT_EXPECTATIONS.billerId) {
    return {
      verified: true,
      evidenceType: "biller_id",
      state: "pass",
      detail: "Biller ID matched exactly.",
    };
  }

  const name = (e?.shopName ?? e?.receiverName ?? "").trim().toLowerCase();
  if (name && MERCHANT_EXPECTATIONS.shopAliases.some((alias) => name.includes(alias))) {
    return {
      verified: true,
      evidenceType: e?.shopName ? "shop_alias" : "receiver_name",
      state: "warning",
      detail: "Matched by shop name only - weaker than a merchant/biller code match.",
    };
  }

  return {
    verified: false,
    evidenceType: "insufficient",
    state: "warning",
    detail: "Not enough evidence to confirm the recipient. Check the slip image manually.",
  };
}

// ─── Recheck availability ─────────────────────────────────────────────────

/**
 * Recheck is offered only where it can do something useful. A finalized
 * payment is excluded because the endpoint deliberately cannot change it.
 */
/**
 * True when the panel must offer the explicit resolution actions instead of
 * the normal Approve button - the normal action is guaranteed to refuse.
 */
export function requiresLegacyCaseResolution(input: OcrPanelInput): boolean {
  return (
    input.reviewReason === "LEGACY_REFERENCE_CASE_AMBIGUITY" ||
    input.duplicate?.strength === "legacy_case_ambiguity"
  );
}

export function canRecheckOcr(input: OcrPanelInput): boolean {
  const status = input.paymentStatus;
  if (status === "approved" || status === "rejected") return false;
  return status === "pending_review" || status === "pending";
}
