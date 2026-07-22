/**
 * Pure decision logic for the "upload slip, then checkout" flow in
 * CartPage.tsx, extracted so it can be unit-tested independently of React
 * rendering (this repo has no client component/DOM test harness - see
 * client/src/pages/checkoutOutcome.test.ts).
 *
 * Three distinct outcomes must never be confused with one another:
 * 1. payment.uploadSlipFile itself failed - no Order was created.
 * 2. checkout.create failed before the Order/Payment transaction committed -
 *    no Order was created, safe to retry with the same slip.
 * 3. checkout.create succeeded (the Order/Payment/OrderItems are committed
 *    and the cart is cleared) but post-commit slip/OCR processing could not
 *    complete - this is NOT a failure. The customer must never be told to
 *    submit the same cart again.
 */

export type CheckoutFailureStage = "upload" | "checkoutBeforeCommit";

/**
 * Message shown when payment.uploadSlipFile itself throws. Never shown for a
 * checkout.create failure, and never shown once the Order has committed.
 */
export function resolveUploadFailureMessage(error: unknown, t: (key: string) => string): string {
  const message = (error as any)?.message;
  return typeof message === "string" && message.length > 0 ? message : t("payment.uploadFailed");
}

/**
 * Message shown when checkout.create throws BEFORE the Order/Payment
 * transaction commits (e.g. cart empty/consumed by a concurrent request,
 * invalid coupon). No Order exists yet, so it is safe for the customer to
 * retry. Deliberately distinct copy from resolveUploadFailureMessage - the
 * upload already succeeded, so telling the customer their upload failed
 * would be actively misleading.
 */
export function resolveCheckoutFailureMessage(error: unknown, t: (key: string) => string): string {
  const message = (error as any)?.message;
  return typeof message === "string" && message.length > 0 ? message : t("payment.checkoutFailed");
}

export interface SlipResultLike {
  status?: string;
  reviewReason?: string;
  processingDeferred?: boolean;
  ocrConfidence?: number;
  duplicateStatus?: {
    isDuplicateReference?: boolean;
    isDuplicateFingerprint?: boolean;
  };
}

/**
 * Message shown once checkout.create has already succeeded (the Order is
 * committed) - covers every slipResult shape the server can return,
 * including processingDeferred (Phase 2 - OCR/post-commit processing -
 * failed, but the Order/Payment are real and the customer must not retry).
 * A missing slipResult (no slip was submitted) is treated as plain success.
 */
export function resolveCheckoutSuccessMessage(slipResult: SlipResultLike | undefined | null, t: (key: string) => string): string {
  if (!slipResult) return t("order.createdSuccess");

  if (slipResult.status === "approved") {
    return t("payment.autoApprovedOrderMessage");
  }

  if (slipResult.status === "pending_review") {
    if (slipResult.processingDeferred || slipResult.reviewReason === "OCR_PROCESSING_ERROR") {
      return t("payment.ocrErrorReviewMessage");
    }
    if (slipResult.duplicateStatus?.isDuplicateReference || slipResult.duplicateStatus?.isDuplicateFingerprint) {
      return t("payment.duplicateReviewMessage");
    }
    if (slipResult.ocrConfidence !== undefined && slipResult.ocrConfidence < 85) {
      return t("payment.lowConfidenceReviewMessage");
    }
    return t("payment.pendingReviewOrderMessage");
  }

  return t("order.createdSuccess");
}
