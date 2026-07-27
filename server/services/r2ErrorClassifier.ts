// Safe, no-secrets classification of AWS SDK / Cloudflare R2 errors into a
// small set of stable internal categories - built so a real Production R2
// failure becomes diagnosable from safe server logs alone (operation,
// context, category, SDK error name/code, HTTP status, retryable, provider
// request ID), without ever touching the underlying SDK error's `.message`
// (which can itself echo the endpoint, bucket name, or credential in some
// AWS SDK error variants - see r2PrivateStorage.test.ts's "leaky SDK error"
// regression test).
//
// Every category maps to exactly one of two customer-facing Thai messages
// via `retryable` (see slipFileUploadService.ts): non-retryable categories
// mean an admin must fix something (config/credentials/bucket/endpoint) and
// a customer retry cannot help; retryable categories mean the failure looks
// transient (DNS/timeout/network/upstream) and a retry might succeed.

export type StorageErrorCategory =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "AUTH_FAILED"
  | "ACCESS_DENIED"
  | "BUCKET_NOT_FOUND"
  | "ENDPOINT_INVALID"
  | "DNS_FAILED"
  | "CONNECTION_TIMEOUT"
  | "NETWORK_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UPSTREAM_UNAVAILABLE"
  | "UNKNOWN_STORAGE_ERROR";

/** Categories an admin must resolve (bad config/credentials/bucket/endpoint) -
 *  a customer retry cannot help, so these map to the "contact admin" message. */
const NON_RETRYABLE_CATEGORIES = new Set<StorageErrorCategory>([
  "CONFIG_MISSING",
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "ACCESS_DENIED",
  "BUCKET_NOT_FOUND",
  "ENDPOINT_INVALID",
  "PAYLOAD_TOO_LARGE",
]);

export interface ClassifiedStorageError {
  category: StorageErrorCategory;
  retryable: boolean;
  /** The AWS/S3 SDK's own fixed error name (e.g. "NoSuchBucket",
   *  "AccessDenied") - a stable identifier, never a free-text message. */
  sdkErrorName?: string;
  httpStatusCode?: number;
  /** Cloudflare/AWS's own opaque correlation ID for the failed request
   *  ($metadata.requestId / cfId / extendedRequestId) - safe to log; it
   *  identifies the request to Cloudflare/AWS support, not the account. */
  providerRequestId?: string;
}

function readNodeErrorCode(error: any): string | undefined {
  // AWS SDK v3's NodeHttpHandler wraps a raw Node network error (ENOTFOUND,
  // ECONNREFUSED, ETIMEDOUT, ...) either directly on the thrown error or as
  // `.cause` - check both without ever reading `.message`.
  return error?.code ?? error?.cause?.code ?? error?.errno ?? undefined;
}

const SDK_NAME_TO_CATEGORY: Record<string, StorageErrorCategory> = {
  NoSuchBucket: "BUCKET_NOT_FOUND",
  AccessDenied: "ACCESS_DENIED",
  AllAccessDisabled: "ACCESS_DENIED",
  AuthorizationHeaderMalformed: "ACCESS_DENIED",
  InvalidAccessKeyId: "AUTH_FAILED",
  SignatureDoesNotMatch: "AUTH_FAILED",
  CredentialsProviderError: "AUTH_FAILED",
  ExpiredToken: "AUTH_FAILED",
  InvalidToken: "AUTH_FAILED",
  RequestTimeTooSkewed: "AUTH_FAILED",
  EntityTooLarge: "PAYLOAD_TOO_LARGE",
  MaxMessageLengthExceeded: "PAYLOAD_TOO_LARGE",
  RequestTimeout: "CONNECTION_TIMEOUT",
};

const NODE_ERROR_CODE_TO_CATEGORY: Record<string, StorageErrorCategory> = {
  ENOTFOUND: "DNS_FAILED",
  EAI_AGAIN: "DNS_FAILED",
  ETIMEDOUT: "CONNECTION_TIMEOUT",
  ESOCKETTIMEDOUT: "CONNECTION_TIMEOUT",
  ECONNABORTED: "CONNECTION_TIMEOUT",
  ECONNREFUSED: "NETWORK_FAILED",
  ECONNRESET: "NETWORK_FAILED",
  EPIPE: "NETWORK_FAILED",
  EHOSTUNREACH: "NETWORK_FAILED",
  ENETUNREACH: "NETWORK_FAILED",
};

function httpStatusToCategory(status: number | undefined): StorageErrorCategory | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return "AUTH_FAILED";
  if (status === 403) return "ACCESS_DENIED";
  if (status === 404) return "BUCKET_NOT_FOUND";
  if (status === 413) return "PAYLOAD_TOO_LARGE";
  if (status >= 500 && status < 600) return "UPSTREAM_UNAVAILABLE";
  return undefined;
}

/**
 * Classifies a caught AWS SDK / R2 error into a stable, safe category.
 * Reads only structural, non-secret fields: `.name` (a fixed SDK error
 * identifier), `.$metadata.*` (HTTP status/request IDs), `.code`/`.cause.code`
 * (Node network error codes). Never reads, returns, or logs `.message` or
 * `.stack` - both can embed the endpoint, bucket, key, or credential
 * fragments in various AWS SDK error shapes.
 */
export function classifyStorageSdkError(error: unknown): ClassifiedStorageError {
  const err: any = error;
  const sdkErrorName: string | undefined = typeof err?.name === "string" ? err.name : undefined;
  const httpStatusCode: number | undefined =
    typeof err?.$metadata?.httpStatusCode === "number" ? err.$metadata.httpStatusCode : undefined;
  const providerRequestId: string | undefined =
    err?.$metadata?.requestId ?? err?.$metadata?.cfId ?? err?.$metadata?.extendedRequestId ?? undefined;
  const nodeErrorCode = readNodeErrorCode(err);

  let category: StorageErrorCategory | undefined;
  if (sdkErrorName && SDK_NAME_TO_CATEGORY[sdkErrorName]) {
    category = SDK_NAME_TO_CATEGORY[sdkErrorName];
  } else if (nodeErrorCode && NODE_ERROR_CODE_TO_CATEGORY[nodeErrorCode]) {
    category = NODE_ERROR_CODE_TO_CATEGORY[nodeErrorCode];
  } else {
    category = httpStatusToCategory(httpStatusCode);
  }
  if (!category) {
    // No HTTP response was ever received (no $metadata at all) and no
    // recognized network error code - still classify as a (retryable)
    // upstream problem rather than falling straight to UNKNOWN, since the
    // vast majority of unrecognized SDK-level failures with no response are
    // transient connectivity issues, not a genuinely new failure mode.
    category = err?.$metadata === undefined && !sdkErrorName ? "UPSTREAM_UNAVAILABLE" : "UNKNOWN_STORAGE_ERROR";
  }

  return {
    category,
    retryable: !NON_RETRYABLE_CATEGORIES.has(category),
    ...(sdkErrorName !== undefined ? { sdkErrorName } : {}),
    ...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}
