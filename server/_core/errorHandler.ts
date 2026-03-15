/**
 * Centralized Error Handler for consistent error responses and logging
 * Separates business errors from system errors
 */

import { TRPCError } from "@trpc/server";

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface AppError {
  code: string;
  message: string;
  severity: ErrorSeverity;
  userMessage: string;
  requestId?: string;
}

// Business/operational errors (safe to show to users)
export const BUSINESS_ERRORS = {
  CART_ITEM_NOT_FOUND: {
    code: "CART_ITEM_NOT_FOUND",
    message: "Cart item not found",
    severity: "low" as ErrorSeverity,
    userMessage: "Item not found in your cart",
  },
  EPISODE_ALREADY_PURCHASED: {
    code: "EPISODE_ALREADY_PURCHASED",
    message: "Episode already purchased",
    severity: "low" as ErrorSeverity,
    userMessage: "You already own this episode",
  },
  INVALID_COUPON: {
    code: "INVALID_COUPON",
    message: "Coupon is invalid or expired",
    severity: "low" as ErrorSeverity,
    userMessage: "This coupon code is invalid or has expired",
  },
  INSUFFICIENT_POINTS: {
    code: "INSUFFICIENT_POINTS",
    message: "Insufficient points for redemption",
    severity: "low" as ErrorSeverity,
    userMessage: "You don't have enough points for this redemption",
  },
  PAYMENT_NOT_FOUND: {
    code: "PAYMENT_NOT_FOUND",
    message: "Payment record not found",
    severity: "medium" as ErrorSeverity,
    userMessage: "Payment record not found. Please contact support.",
  },
  ORDER_NOT_FOUND: {
    code: "ORDER_NOT_FOUND",
    message: "Order not found",
    severity: "low" as ErrorSeverity,
    userMessage: "Order not found",
  },
  UNAUTHORIZED_ACCESS: {
    code: "UNAUTHORIZED_ACCESS",
    message: "User does not have permission to access this resource",
    severity: "medium" as ErrorSeverity,
    userMessage: "You don't have permission to access this",
  },
  ADMIN_ONLY: {
    code: "ADMIN_ONLY",
    message: "This action is only available to administrators",
    severity: "medium" as ErrorSeverity,
    userMessage: "This action is only available to administrators",
  },
  INVALID_ORDER_STATE: {
    code: "INVALID_ORDER_STATE",
    message: "Order is not in a valid state for this action",
    severity: "medium" as ErrorSeverity,
    userMessage: "This order cannot be modified in its current state",
  },
  FILE_UPLOAD_FAILED: {
    code: "FILE_UPLOAD_FAILED",
    message: "File upload failed",
    severity: "medium" as ErrorSeverity,
    userMessage: "File upload failed. Please try again.",
  },
  INVALID_FILE_TYPE: {
    code: "INVALID_FILE_TYPE",
    message: "Invalid file type",
    severity: "low" as ErrorSeverity,
    userMessage: "Please upload a valid file type (PDF, JPEG, PNG)",
  },
  DUPLICATE_ORDER_ITEM: {
    code: "DUPLICATE_ORDER_ITEM",
    message: "Duplicate order item",
    severity: "low" as ErrorSeverity,
    userMessage: "This episode is already in your order",
  },
  PAYMENT_ALREADY_APPROVED: {
    code: "PAYMENT_ALREADY_APPROVED",
    message: "Payment has already been approved",
    severity: "low" as ErrorSeverity,
    userMessage: "This payment has already been processed",
  },
};

// System errors (should not expose details to users)
export const SYSTEM_ERRORS = {
  DATABASE_ERROR: {
    code: "DATABASE_ERROR",
    message: "Database operation failed",
    severity: "high" as ErrorSeverity,
    userMessage: "An error occurred. Please try again later.",
  },
  TRANSACTION_FAILED: {
    code: "TRANSACTION_FAILED",
    message: "Database transaction failed",
    severity: "high" as ErrorSeverity,
    userMessage: "An error occurred. Please try again later.",
  },
  STORAGE_ERROR: {
    code: "STORAGE_ERROR",
    message: "Storage operation failed",
    severity: "high" as ErrorSeverity,
    userMessage: "An error occurred. Please try again later.",
  },
  INTERNAL_ERROR: {
    code: "INTERNAL_ERROR",
    message: "Internal server error",
    severity: "critical" as ErrorSeverity,
    userMessage: "An unexpected error occurred. Please contact support.",
  },
};

/**
 * Log error with context
 */
export function logError(error: AppError, context?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const logLevel = error.severity === "critical" ? "error" : "warn";

  console.log(
    JSON.stringify({
      timestamp,
      level: logLevel,
      errorCode: error.code,
      message: error.message,
      severity: error.severity,
      requestId: error.requestId,
      context,
    })
  );
}

/**
 * Convert business error to TRPCError
 */
export function throwBusinessError(errorDef: AppError, requestId?: string): never {
  const error = { ...errorDef, requestId };
  logError(error);

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: error.userMessage,
    cause: {
      code: error.code,
      requestId,
    },
  });
}

/**
 * Convert system error to TRPCError
 */
export function throwSystemError(errorDef: AppError, requestId?: string, details?: any): never {
  const error = { ...errorDef, requestId };
  logError(error, { details });

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error.userMessage,
    cause: {
      code: error.code,
      requestId,
    },
  });
}

/**
 * Safe error handler for unknown errors
 */
export function handleUnknownError(error: any, requestId?: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  logError(
    {
      ...SYSTEM_ERRORS.INTERNAL_ERROR,
      requestId,
    },
    { message, stack }
  );

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: SYSTEM_ERRORS.INTERNAL_ERROR.userMessage,
    cause: {
      code: "INTERNAL_ERROR",
      requestId,
    },
  });
}

/**
 * Extract user-safe error message from TRPCError
 */
export function getUserErrorMessage(error: any): string {
  if (error instanceof TRPCError) {
    return error.message || "An error occurred";
  }
  return "An unexpected error occurred";
}
