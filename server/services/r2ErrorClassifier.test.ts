import { describe, it, expect } from "vitest";
import { classifyStorageSdkError } from "./r2ErrorClassifier";

/**
 * Every fixture below is a plain object shaped like a real AWS SDK v3 /
 * Cloudflare R2 error - never a real SDK call, never real credentials. Each
 * test asserts BOTH the resulting category/retryable AND that the returned
 * safe fields never include anything beyond the fixed allowlist (no
 * `.message`, no endpoint/bucket/key, regardless of what the fixture's own
 * `.message` string contains).
 */

function sdkError(overrides: Record<string, any>): any {
  const err: any = new Error(
    "LEAKY: endpoint=https://acct.r2.cloudflarestorage.com bucket=my-secret-bucket key=payment-slips/1/x.jpg secret=AKIAFAKESECRET"
  );
  Object.assign(err, overrides);
  return err;
}

describe("classifyStorageSdkError - never reads or returns .message", () => {
  it("never includes the raw message anywhere in the classified result, for every category fixture", () => {
    const fixtures = [
      sdkError({ name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } }),
      sdkError({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
      sdkError({ name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 } }),
      sdkError({ code: "ENOTFOUND" }),
      sdkError({ code: "ETIMEDOUT" }),
      sdkError({ code: "ECONNREFUSED" }),
      sdkError({ name: "EntityTooLarge", $metadata: { httpStatusCode: 400 } }),
      sdkError({ $metadata: { httpStatusCode: 503 } }),
      sdkError({}),
    ];
    for (const fixture of fixtures) {
      const result = classifyStorageSdkError(fixture);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("LEAKY");
      expect(serialized).not.toContain("r2.cloudflarestorage.com");
      expect(serialized).not.toContain("my-secret-bucket");
      expect(serialized).not.toContain("payment-slips");
      expect(serialized).not.toContain("AKIAFAKESECRET");
      expect(result).not.toHaveProperty("message");
      expect(result).not.toHaveProperty("stack");
    }
  });
});

describe("classifyStorageSdkError - category mapping from the SDK's own fixed error name", () => {
  it.each([
    ["NoSuchBucket", "BUCKET_NOT_FOUND", false],
    ["AccessDenied", "ACCESS_DENIED", false],
    ["AllAccessDisabled", "ACCESS_DENIED", false],
    ["AuthorizationHeaderMalformed", "ACCESS_DENIED", false],
    ["InvalidAccessKeyId", "AUTH_FAILED", false],
    ["SignatureDoesNotMatch", "AUTH_FAILED", false],
    ["CredentialsProviderError", "AUTH_FAILED", false],
    ["ExpiredToken", "AUTH_FAILED", false],
    ["InvalidToken", "AUTH_FAILED", false],
    ["RequestTimeTooSkewed", "AUTH_FAILED", false],
    ["EntityTooLarge", "PAYLOAD_TOO_LARGE", false],
    ["MaxMessageLengthExceeded", "PAYLOAD_TOO_LARGE", false],
    ["RequestTimeout", "CONNECTION_TIMEOUT", true],
  ] as const)("%s -> %s (retryable: %s)", (sdkName, expectedCategory, expectedRetryable) => {
    const result = classifyStorageSdkError(sdkError({ name: sdkName }));
    expect(result.category).toBe(expectedCategory);
    expect(result.retryable).toBe(expectedRetryable);
    expect(result.sdkErrorName).toBe(sdkName);
  });
});

describe("classifyStorageSdkError - category mapping from Node network error codes (no HTTP response at all)", () => {
  it.each([
    ["ENOTFOUND", "DNS_FAILED", true],
    ["EAI_AGAIN", "DNS_FAILED", true],
    ["ETIMEDOUT", "CONNECTION_TIMEOUT", true],
    ["ESOCKETTIMEDOUT", "CONNECTION_TIMEOUT", true],
    ["ECONNABORTED", "CONNECTION_TIMEOUT", true],
    ["ECONNREFUSED", "NETWORK_FAILED", true],
    ["ECONNRESET", "NETWORK_FAILED", true],
    ["EPIPE", "NETWORK_FAILED", true],
    ["EHOSTUNREACH", "NETWORK_FAILED", true],
    ["ENETUNREACH", "NETWORK_FAILED", true],
  ] as const)("%s -> %s (retryable: %s)", (code, expectedCategory, expectedRetryable) => {
    const result = classifyStorageSdkError(sdkError({ code }));
    expect(result.category).toBe(expectedCategory);
    expect(result.retryable).toBe(expectedRetryable);
  });

  it("reads the Node error code from `.cause.code` when the SDK wraps it (a common AWS SDK v3 NodeHttpHandler shape)", () => {
    const result = classifyStorageSdkError(sdkError({ cause: { code: "ENOTFOUND" } }));
    expect(result.category).toBe("DNS_FAILED");
  });

  it("reads the Node error code from `.errno` as a final fallback", () => {
    const result = classifyStorageSdkError(sdkError({ errno: "ECONNREFUSED" }));
    expect(result.category).toBe("NETWORK_FAILED");
  });
});

describe("classifyStorageSdkError - category mapping from HTTP status alone (no recognized SDK error name)", () => {
  it.each([
    [401, "AUTH_FAILED", false],
    [403, "ACCESS_DENIED", false],
    [404, "BUCKET_NOT_FOUND", false],
    [413, "PAYLOAD_TOO_LARGE", false],
    [500, "UPSTREAM_UNAVAILABLE", true],
    [502, "UPSTREAM_UNAVAILABLE", true],
    [503, "UPSTREAM_UNAVAILABLE", true],
  ] as const)("HTTP %i -> %s (retryable: %s)", (status, expectedCategory, expectedRetryable) => {
    const result = classifyStorageSdkError(sdkError({ $metadata: { httpStatusCode: status } }));
    expect(result.category).toBe(expectedCategory);
    expect(result.retryable).toBe(expectedRetryable);
    expect(result.httpStatusCode).toBe(status);
  });
});

describe("classifyStorageSdkError - fallback categories", () => {
  it("classifies as UPSTREAM_UNAVAILABLE (retryable) for a thrown value with no $metadata and no `.name` at all - the rare 'not even a real Error object' shape", () => {
    // A plain object (not `new Error()`, which always has .name = "Error")
    // - some non-standard throw sites (or a badly-shaped mock) produce this.
    const result = classifyStorageSdkError({ someUnrelatedField: 1 });
    expect(result.category).toBe("UPSTREAM_UNAVAILABLE");
    expect(result.retryable).toBe(true);
  });

  it("classifies a plain `new Error()` with no SDK metadata as UNKNOWN_STORAGE_ERROR (retryable) - matches r2PrivateStorage.test.ts's real usage, since `.name` is always the truthy string \"Error\" here, not absent", () => {
    const result = classifyStorageSdkError(sdkError({}));
    expect(result.category).toBe("UNKNOWN_STORAGE_ERROR");
    expect(result.retryable).toBe(true);
    expect(result.sdkErrorName).toBe("Error");
  });

  it("classifies as UNKNOWN_STORAGE_ERROR (retryable) for a recognized SDK name with an unmapped/unexpected error name", () => {
    const result = classifyStorageSdkError(sdkError({ name: "SomeFutureAwsErrorNeverSeenBefore", $metadata: {} }));
    expect(result.category).toBe("UNKNOWN_STORAGE_ERROR");
    expect(result.retryable).toBe(true);
  });

  it("handles null/undefined/primitive input safely, never throwing", () => {
    expect(() => classifyStorageSdkError(null)).not.toThrow();
    expect(() => classifyStorageSdkError(undefined)).not.toThrow();
    expect(() => classifyStorageSdkError("a string")).not.toThrow();
    expect(() => classifyStorageSdkError(42)).not.toThrow();
    expect(classifyStorageSdkError(null).category).toBe("UPSTREAM_UNAVAILABLE");
  });
});

describe("classifyStorageSdkError - safe correlation fields", () => {
  it("extracts a provider request ID from $metadata.requestId when present", () => {
    const result = classifyStorageSdkError(sdkError({ $metadata: { httpStatusCode: 500, requestId: "req-abc-123" } }));
    expect(result.providerRequestId).toBe("req-abc-123");
  });

  it("falls back to $metadata.cfId (Cloudflare's own correlation ID) when requestId is absent", () => {
    const result = classifyStorageSdkError(sdkError({ $metadata: { httpStatusCode: 500, cfId: "cf-xyz-789" } }));
    expect(result.providerRequestId).toBe("cf-xyz-789");
  });

  it("falls back to $metadata.extendedRequestId when neither requestId nor cfId is present", () => {
    const result = classifyStorageSdkError(sdkError({ $metadata: { httpStatusCode: 500, extendedRequestId: "ext-456" } }));
    expect(result.providerRequestId).toBe("ext-456");
  });

  it("omits httpStatusCode/providerRequestId entirely (not even as undefined keys) when unavailable", () => {
    const result = classifyStorageSdkError(sdkError({ name: "NoSuchBucket" }));
    expect(result).not.toHaveProperty("httpStatusCode");
    expect(result).not.toHaveProperty("providerRequestId");
    expect(Object.keys(result).sort()).toEqual(["category", "retryable", "sdkErrorName"]);
  });
});

describe("classifyStorageSdkError - retryable/non-retryable split matches the customer-message mapping this fix relies on", () => {
  const NON_RETRYABLE = ["AUTH_FAILED", "ACCESS_DENIED", "BUCKET_NOT_FOUND", "PAYLOAD_TOO_LARGE"] as const;
  const RETRYABLE = ["DNS_FAILED", "CONNECTION_TIMEOUT", "NETWORK_FAILED", "UPSTREAM_UNAVAILABLE", "UNKNOWN_STORAGE_ERROR"] as const;

  it.each(NON_RETRYABLE)("%s is never retryable (an admin must fix config/credentials/bucket/file size, not a retry)", (category) => {
    // Sanity-check via the actual mapping table indirectly: construct a
    // fixture known to produce this category and confirm retryable is false.
    const byCategory: Record<string, any> = {
      AUTH_FAILED: sdkError({ name: "InvalidAccessKeyId" }),
      ACCESS_DENIED: sdkError({ name: "AccessDenied" }),
      BUCKET_NOT_FOUND: sdkError({ name: "NoSuchBucket" }),
      PAYLOAD_TOO_LARGE: sdkError({ name: "EntityTooLarge" }),
    };
    expect(classifyStorageSdkError(byCategory[category]).retryable).toBe(false);
  });

  it.each(RETRYABLE)("%s is retryable (a customer retry might succeed)", (category) => {
    const byCategory: Record<string, any> = {
      DNS_FAILED: sdkError({ code: "ENOTFOUND" }),
      CONNECTION_TIMEOUT: sdkError({ code: "ETIMEDOUT" }),
      NETWORK_FAILED: sdkError({ code: "ECONNREFUSED" }),
      UPSTREAM_UNAVAILABLE: sdkError({ $metadata: { httpStatusCode: 503 } }),
      UNKNOWN_STORAGE_ERROR: sdkError({ name: "TotallyUnrecognized", $metadata: {} }),
    };
    expect(classifyStorageSdkError(byCategory[category]).retryable).toBe(true);
  });
});
