import { TRPCError } from "@trpc/server";
import { looksLikeRawDatabaseError } from "../_core/trpc";
import { hasDatabaseDriverMetadata, isLockWaitTimeout } from "./databaseErrorClassifier";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

export const ORDER_PAYMENT_BUSY_MESSAGE =
  "This payment is busy with another request. Please wait a moment and try again.";

function lockTimeoutError(error: unknown, operation: "Approval" | "Recheck", stage: string) {
  console.error(`[OrderPayment${operation}] lock stage=${stage} ${safeErrorSummary(error)}`);
  return new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message: ORDER_PAYMENT_BUSY_MESSAGE,
    cause: error,
  });
}

/**
 * Keeps the established admin order-payment error contract while preventing
 * an unexpected Drizzle/mysql exception from being relabelled BAD_REQUEST.
 * The original cause is retained only on the server-side TRPCError chain so
 * the global formatter can log code/errno/sqlState safely; no cause, SQL, or
 * parameters are serialized to the browser.
 */
export function mapOrderPaymentApprovalError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;

  if (isLockWaitTimeout(error)) {
    return lockTimeoutError(error, "Approval", "approval_transaction");
  }

  const message = error instanceof Error ? error.message : String((error as any)?.message ?? "");

  if (message.startsWith("SLIP_ALREADY_CLAIMED")) {
    return new TRPCError({ code: "CONFLICT", message });
  }
  if (
    message.startsWith("NO_STRONG_IDENTIFIER") ||
    message.startsWith("LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION")
  ) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message });
  }

  if (looksLikeRawDatabaseError(message) || hasDatabaseDriverMetadata(error)) {
    return new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to approve this order payment due to an unexpected server error.",
      cause: error,
    });
  }

  // Preserve the prior behavior for deliberate business-rule errors that
  // are not one of the three specially classified prefixes above.
  return new TRPCError({
    code: "BAD_REQUEST",
    message: message || "Failed to approve payment. Please try again.",
  });
}

/** Safe API boundary for the diagnostic-only OCR Recheck mutation. */
export function mapOrderPaymentRecheckError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;

  if (isLockWaitTimeout(error)) {
    return lockTimeoutError(error, "Recheck", "recheck_persist");
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to recheck this order payment due to an unexpected server error.",
    cause: error,
  });
}
