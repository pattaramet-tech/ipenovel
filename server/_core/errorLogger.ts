/**
 * Structured error logging for procedures
 * Logs: procedure name, error code, error message, user context, input summary
 */

export interface ErrorLogContext {
  procedureName: string;
  userId?: string;
  errorCode: string;
  errorMessage: string;
  inputSummary?: Record<string, any>;
  timestamp?: string;
}

export function logProcedureError(context: ErrorLogContext) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    procedure: context.procedureName,
    userId: context.userId || "anonymous",
    errorCode: context.errorCode,
    errorMessage: context.errorMessage,
    input: context.inputSummary || {},
  };

  // Log to console in development
  if (process.env.NODE_ENV !== "production") {
    console.error("[PROCEDURE_ERROR]", JSON.stringify(logEntry, null, 2));
  }

  // In production, you could send to external logging service
  // Example: Sentry, LogRocket, DataDog, etc.
  // await sendToLoggingService(logEntry);

  return logEntry;
}

/**
 * Helper to create safe input summary (excludes sensitive data)
 */
export function createInputSummary(input: any): Record<string, any> {
  if (!input) return {};

  const summary: Record<string, any> = {};
  const sensitiveFields = ["password", "passwordHash", "token", "secret", "apiKey"];

  for (const [key, value] of Object.entries(input)) {
    if (sensitiveFields.some((field) => key.toLowerCase().includes(field))) {
      summary[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 100) {
      summary[key] = value.substring(0, 100) + "...";
    } else if (typeof value === "object") {
      summary[key] = "[OBJECT]";
    } else {
      summary[key] = value;
    }
  }

  return summary;
}
