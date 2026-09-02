import { TRPCError } from "@trpc/server";
import { looksLikeRawDatabaseError } from "../_core/trpc";
import { hasDatabaseDriverMetadata } from "./databaseErrorClassifier";

/**
 * Keeps the established admin order-payment error contract while preventing
 * an unexpected Drizzle/mysql exception from being relabelled BAD_REQUEST.
 * The original cause is retained only on the server-side TRPCError chain so
 * the global formatter can log code/errno/sqlState safely; no cause, SQL, or
 * parameters are serialized to the browser.
 */
export function mapOrderPaymentApprovalError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;

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
