/**
 * OCR failure diagnostics.
 *
 * Exists to answer the one question an admin previously could not answer
 * from the order page: "did this fail because the OCR provider broke, or
 * because the slip data was genuinely wrong?" Both used to collapse into a
 * single opaque OCR_PROCESSING_ERROR, so a provider outage looked identical
 * to a customer uploading the wrong slip.
 *
 * Every code is sorted into one of three categories:
 *
 *   TECHNICAL - our pipeline or the provider failed. The slip was never
 *               fairly evaluated. A recheck may well succeed.
 *   DATA      - the pipeline worked; the slip's contents did not satisfy
 *               verification. Rechecking the same image will not change it
 *               unless the OCR read was itself wrong.
 *   CONFIG    - a deliberate operator setting suppressed the decision.
 *
 * SECURITY: nothing produced here may contain an API key, an Authorization
 * header, an endpoint URL, a signed R2 URL, base64 image data, or a raw
 * upstream response body. Only an HTTP status, a runtime mode, an attempt
 * count and a fixed code/message are ever surfaced.
 */

import { LLMInvokeError } from "../_core/llm";

export type OcrDiagnosticCategory = "TECHNICAL" | "DATA" | "CONFIG";

export type OcrTechnicalFailureCode =
  | "OCR_IMAGE_PREPARATION_FAILED"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_TRANSIENT_ERROR"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_BAD_REQUEST"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR"
  | "PROVIDER_RETRY_EXHAUSTED"
  | "RESPONSE_PARSE_ERROR"
  | "OCR_PROCESSING_ERROR";

export type OcrDataFailureCode =
  | "MISSING_AMOUNT"
  | "AMOUNT_MISMATCH"
  | "MISSING_TRANSACTION_DATE"
  | "TRANSACTION_OUTSIDE_TIME_WINDOW"
  | "MISSING_REFERENCE"
  | "DUPLICATE_REFERENCE"
  | "DUPLICATE_FILE"
  | "DUPLICATE_QR"
  | "WEAK_DUPLICATE_RISK"
  | "NO_STRONG_IDENTIFIER"
  | "LOW_CONFIDENCE"
  | "UNKNOWN_CONFIDENCE"
  | "RECIPIENT_NOT_VERIFIED"
  | "INSUFFICIENT_STRUCTURED_DATA"
  | "INVALID_PAYMENT_AMOUNT";

export type OcrConfigFailureCode = "OCR_DISABLED" | "AUTO_APPROVE_DISABLED" | "SHADOW_MODE";

export type OcrFailureCode =
  | OcrTechnicalFailureCode
  | OcrDataFailureCode
  | OcrConfigFailureCode;

const TECHNICAL_CODES = new Set<string>([
  "OCR_IMAGE_PREPARATION_FAILED",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_TRANSIENT_ERROR",
  "PROVIDER_AUTH_ERROR",
  "PROVIDER_BAD_REQUEST",
  "PROVIDER_TIMEOUT",
  "PROVIDER_NETWORK_ERROR",
  "PROVIDER_RETRY_EXHAUSTED",
  "RESPONSE_PARSE_ERROR",
  "OCR_PROCESSING_ERROR",
]);

const CONFIG_CODES = new Set<string>(["OCR_DISABLED", "AUTO_APPROVE_DISABLED", "SHADOW_MODE"]);

/**
 * Sorts any review reason - including legacy codes stored on old rows - into
 * a category. Unknown codes are treated as DATA rather than TECHNICAL: that
 * is the conservative default, because mislabelling a data problem as a
 * provider outage would invite an admin to "just recheck" forever.
 */
export function categorizeOcrFailure(code: string | null | undefined): OcrDiagnosticCategory {
  if (!code) return "DATA";
  if (TECHNICAL_CODES.has(code)) return "TECHNICAL";
  if (CONFIG_CODES.has(code)) return "CONFIG";
  return "DATA";
}

export interface ProviderDiagnostic {
  code: OcrTechnicalFailureCode;
  /** Runtime mode only ("generic" | "legacy_forge") - never an endpoint. */
  providerMode?: string;
  providerHttpStatus?: number;
  /** How many provider invocations were made, including retries. */
  providerAttemptCount: number;
  /** Fixed, admin-safe sentence. Never an upstream body. */
  message: string;
}

/**
 * Maps a thrown OCR error to a sanitized provider diagnostic.
 *
 * `attemptCount` distinguishes "failed once" from "failed after exhausting
 * retries", which is the difference between a blip and a sustained outage.
 */
export function describeProviderFailure(
  error: unknown,
  attemptCount = 1
): ProviderDiagnostic {
  // Image preparation never reached the provider at all.
  if (error instanceof Error && error.message === "OCR_IMAGE_PREPARATION_FAILED") {
    return {
      code: "OCR_IMAGE_PREPARATION_FAILED",
      providerAttemptCount: 0,
      message:
        "The slip image could not be prepared for OCR (fetch, size, or format problem). " +
        "The provider was never called.",
    };
  }

  if (error instanceof LLMInvokeError) {
    const status = error.httpStatus;
    const mode = error.runtimeMode;
    const exhausted = attemptCount > 1;

    const base = (code: OcrTechnicalFailureCode, message: string): ProviderDiagnostic => ({
      code,
      providerMode: mode,
      providerHttpStatus: status,
      providerAttemptCount: attemptCount,
      message,
    });

    if (status === 429) {
      return base(
        exhausted ? "PROVIDER_RETRY_EXHAUSTED" : "PROVIDER_RATE_LIMIT",
        exhausted
          ? `The OCR provider rate-limited us (HTTP 429) on all ${attemptCount} attempts.`
          : "The OCR provider rate-limited this request (HTTP 429)."
      );
    }

    if (status === 401 || status === 403) {
      // Never retried and never recheckable by an admin - this is an
      // operator credential problem, and saying so prevents pointless retries.
      return base(
        "PROVIDER_AUTH_ERROR",
        `The OCR provider rejected our credentials (HTTP ${status}). This is a server ` +
          `configuration problem, not a problem with the slip.`
      );
    }

    if (status === 408 || status === 504) {
      return base(
        exhausted ? "PROVIDER_RETRY_EXHAUSTED" : "PROVIDER_TIMEOUT",
        `The OCR provider timed out (HTTP ${status}) after ${attemptCount} attempt(s).`
      );
    }

    if (status >= 500) {
      return base(
        exhausted ? "PROVIDER_RETRY_EXHAUSTED" : "PROVIDER_TRANSIENT_ERROR",
        `The OCR provider failed with HTTP ${status} after ${attemptCount} attempt(s).`
      );
    }

    if (status >= 400) {
      return base(
        "PROVIDER_BAD_REQUEST",
        `The OCR provider rejected the request (HTTP ${status}). This is a server-side ` +
          `problem, not a problem with the slip.`
      );
    }

    return base("PROVIDER_TRANSIENT_ERROR", `The OCR provider failed with HTTP ${status}.`);
  }

  // Network-level failures surface as plain Errors with node error codes.
  const nodeCode = (error as { code?: string } | null)?.code;
  if (
    nodeCode === "ETIMEDOUT" ||
    nodeCode === "ECONNRESET" ||
    nodeCode === "ECONNREFUSED" ||
    nodeCode === "ENOTFOUND" ||
    nodeCode === "EAI_AGAIN"
  ) {
    return {
      code: "PROVIDER_NETWORK_ERROR",
      providerAttemptCount: attemptCount,
      message: "The OCR provider could not be reached (network error).",
    };
  }

  if (error instanceof SyntaxError) {
    return {
      code: "RESPONSE_PARSE_ERROR",
      providerAttemptCount: attemptCount,
      message: "The OCR provider returned a response that could not be parsed.",
    };
  }

  // Deliberately generic: an unrecognised error's own message may embed an
  // upstream body or URL, so it is never propagated to an admin surface.
  return {
    code: "OCR_PROCESSING_ERROR",
    providerAttemptCount: attemptCount,
    message: "OCR processing failed for an unexpected reason. The slip was sent to review.",
  };
}

/**
 * Plain-language root cause for the top of the admin panel, so the answer is
 * legible without reading the raw JSON.
 */
export function summarizeRootCause(input: {
  reviewReason?: string | null;
  providerDiagnostic?: ProviderDiagnostic | null;
  duplicateSourceLabel?: string | null;
  readyForAdminApproval?: boolean;
}): { category: OcrDiagnosticCategory; summary: string } {
  if (input.readyForAdminApproval) {
    return {
      category: "DATA",
      summary: "Verification passed on recheck - waiting for an admin to approve.",
    };
  }

  const category = categorizeOcrFailure(input.reviewReason);

  if (category === "TECHNICAL" && input.providerDiagnostic) {
    return { category, summary: `OCR system problem: ${input.providerDiagnostic.message}` };
  }

  switch (input.reviewReason) {
    case "MISSING_REFERENCE":
      return {
        category,
        summary: "Incomplete slip data: the parser found no transaction reference.",
      };
    case "MISSING_AMOUNT":
      return { category, summary: "Incomplete slip data: no amount could be read." };
    case "AMOUNT_MISMATCH":
      return {
        category,
        summary: "The amount on the slip does not match the amount owed.",
      };
    case "MISSING_TRANSACTION_DATE":
      return {
        category,
        summary:
          "No usable transaction date could be read. The printed date may have been " +
          "misread - check the slip image against the submission time.",
      };
    case "TRANSACTION_OUTSIDE_TIME_WINDOW":
      return {
        category,
        summary:
          "The transaction time is outside the allowed window. This can also happen when " +
          "OCR misreads the year on a Thai-calendar slip.",
      };
    case "DUPLICATE_REFERENCE":
      return {
        category,
        summary: `Duplicate reference${input.duplicateSourceLabel ? ` - already used by ${input.duplicateSourceLabel}` : ""}.`,
      };
    case "DUPLICATE_FILE":
      return {
        category,
        summary: `This exact slip image was already submitted${input.duplicateSourceLabel ? ` (${input.duplicateSourceLabel})` : ""}.`,
      };
    case "DUPLICATE_QR":
      return {
        category,
        summary: `This slip's QR payload was already used${input.duplicateSourceLabel ? ` (${input.duplicateSourceLabel})` : ""}.`,
      };
    case "WEAK_DUPLICATE_RISK":
      return {
        category,
        summary:
          "Possible duplicate only - same bank, account, amount and date as an earlier " +
          "submission, but a different (or missing) reference. NOT proof of a duplicate.",
      };
    case "NO_STRONG_IDENTIFIER":
      return {
        category,
        summary:
          "No strong identifier could be derived from this slip, so replay cannot be " +
          "prevented automatically. Human approval required.",
      };
    case "UNKNOWN_CONFIDENCE":
      return {
        category,
        summary: "The OCR provider did not report a confidence score, so auto-approval was refused.",
      };
    case "LOW_CONFIDENCE":
      return { category, summary: "OCR confidence was below the auto-approval threshold." };
    case "RECIPIENT_NOT_VERIFIED":
      return {
        category,
        summary: "The recipient could not be confirmed as this shop from the slip.",
      };
    case "INSUFFICIENT_STRUCTURED_DATA":
      return { category, summary: "Too few fields could be read from the slip to verify it." };
    case "OCR_DISABLED":
      return { category: "CONFIG", summary: "OCR is switched off; all slips go to manual review." };
    case "AUTO_APPROVE_DISABLED":
      return {
        category: "CONFIG",
        summary: "Auto-approval is switched off; verification ran but cannot approve.",
      };
    default:
      return { category, summary: "This slip needs manual review." };
  }
}
