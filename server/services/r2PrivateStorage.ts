// Cloudflare R2 storage adapter for the PRIVATE bucket - payment slips and
// paid episode files. Intentionally separate from server/storage.ts (the
// Manus storage proxy, still used for sports-match images and AI-generated
// images) and from server/services/r2Storage.ts (the PUBLIC R2 bucket for
// novel covers/banners). Objects here are never publicly reachable: every
// read goes through getPrivateObjectSignedUrl(), which returns a
// short-lived presigned GetObject URL and nothing else is ever handed to a
// client.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "../_core/env";
import { isPrivateObjectRef, extractPrivateObjectKey } from "@shared/privateFileRef";
import { classifyStorageSdkError, type StorageErrorCategory } from "./r2ErrorClassifier";
import { validatePrivateR2Config } from "./r2PrivateConfigValidator";

/**
 * Which stored field a key/reference belongs to. Enforced on every
 * put/get/delete so a payment-slip reference can never be resolved (or
 * overwritten) through the episode-file call path or vice versa.
 */
export type PrivateObjectContext = "paymentSlip" | "episodeFile";

const CONTEXT_KEY_PREFIXES: Record<PrivateObjectContext, string> = {
  paymentSlip: "payment-slips/",
  episodeFile: "episodes/",
};

/** Which S3 operation was being attempted - one of the fixed safe fields
 *  allowed in logs (see getSafeDetails()). */
export type PrivateObjectOperation = "put" | "get" | "delete";

export interface R2PrivateStorageErrorDetails {
  key?: string;
  context?: PrivateObjectContext;
  operation?: PrivateObjectOperation;
  /** Stable, safe classification - see r2ErrorClassifier.ts. Present for
   *  config problems (CONFIG_MISSING/CONFIG_INVALID) and for classified SDK
   *  failures on put/get/delete; absent for invalid_reference (a caller bug,
   *  not a storage failure). */
  category?: StorageErrorCategory;
  /** True when a retry might succeed (transient network/upstream issue);
   *  false when only an admin fixing config/credentials/bucket can help. */
  retryable?: boolean;
  /** The AWS/S3 SDK's own fixed error name (e.g. "NoSuchBucket") - never a
   *  free-text message. */
  sdkErrorName?: string;
  httpStatusCode?: number;
  /** Cloudflare/AWS's own opaque request-correlation ID - safe to log. */
  providerRequestId?: string;
}

export class R2PrivateStorageError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "not_configured"
      | "upload_failed"
      | "object_already_exists"
      | "download_failed"
      | "delete_failed"
      | "invalid_reference",
    public readonly details?: R2PrivateStorageErrorDetails
  ) {
    super(message);
    this.name = "R2PrivateStorageError";
  }

  /**
   * Safe, no-secrets summary for server-side logging or for building a
   * client-facing error message from. Always includes operation, context,
   * reason; additionally includes category/retryable/sdkErrorName/
   * httpStatusCode/providerRequestId when known - all individually
   * allowlisted safe fields (see r2ErrorClassifier.ts) - and nothing else:
   * never the object key, never `.message` (which may echo an underlying
   * SDK error string), never a bucket name, endpoint, credential, or signed
   * URL. Callers must map `.reason`/`.details.category` to a fixed, generic
   * message before it ever reaches a client.
   */
  getSafeDetails() {
    const d = this.details;
    return {
      operation: d?.operation,
      context: d?.context,
      reason: this.reason,
      ...(d?.category !== undefined ? { category: d.category } : {}),
      ...(d?.retryable !== undefined ? { retryable: d.retryable } : {}),
      ...(d?.sdkErrorName !== undefined ? { sdkErrorName: d.sdkErrorName } : {}),
      ...(d?.httpStatusCode !== undefined ? { httpStatusCode: d.httpStatusCode } : {}),
      ...(d?.providerRequestId !== undefined ? { providerRequestId: d.providerRequestId } : {}),
    };
  }
}

function getMissingR2PrivateEnvVars(): string[] {
  const required: Array<[string, string]> = [
    ["R2_PRIVATE_ACCOUNT_ID", ENV.r2PrivateAccountId],
    ["R2_PRIVATE_ACCESS_KEY_ID", ENV.r2PrivateAccessKeyId],
    ["R2_PRIVATE_SECRET_ACCESS_KEY", ENV.r2PrivateSecretAccessKey],
    ["R2_PRIVATE_BUCKET_NAME", ENV.r2PrivateBucketName],
    ["R2_PRIVATE_ENDPOINT", ENV.r2PrivateEndpoint],
  ];
  return required.filter(([, value]) => !value).map(([name]) => name);
}

/** True only when every private-R2 env var is present. Safe to call from
 *  anywhere (e.g. an admin "upload disabled" hint) without risking a throw. */
export function isR2PrivateConfigured(): boolean {
  return getMissingR2PrivateEnvVars().length === 0;
}

let cachedClient: { client: S3Client; bucketName: string } | null = null;

/**
 * Builds (and caches) the private-R2 S3 client, after two independent safety
 * gates: presence (CONFIG_MISSING) then structural validity (CONFIG_INVALID
 * - see r2PrivateConfigValidator.ts for the exact rules: HTTPS-only, no
 * embedded credentials/query/fragment, no bucket path in the endpoint, the
 * endpoint's account hostname must agree with R2_PRIVATE_ACCOUNT_ID, the
 * bucket name must be a plain bucket name (not a URL), and the signed-URL
 * expiry must be in a sane range). All string values are trimmed before
 * either check and before being handed to the SDK - a trailing newline or
 * leading space pasted into an env var must never silently misconfigure the
 * client differently than what CONFIG_INVALID would have caught outright.
 *
 * Distinguishing CONFIG_MISSING from CONFIG_INVALID matters for real
 * diagnosis: "nothing set" and "endpoint has a typo" look identical as a
 * customer-facing "not available" message, but are very different admin
 * fixes, and only the latter previously surfaced as an opaque
 * "upload_failed" once the SDK attempted (and failed) to use the malformed
 * value.
 */
function getPrivateR2Client(): { client: S3Client; bucketName: string } {
  if (cachedClient) return cachedClient;

  const missing = getMissingR2PrivateEnvVars();
  if (missing.length > 0) {
    // The var *names* are not secrets - only used server-side for ops
    // visibility, never forwarded to a client (see getSafeDetails()).
    throw new R2PrivateStorageError(
      `Private R2 storage is not configured - missing env var(s): ${missing.join(", ")}`,
      "not_configured",
      { category: "CONFIG_MISSING", retryable: false }
    );
  }

  const problem = validatePrivateR2Config({
    accountId: ENV.r2PrivateAccountId,
    accessKeyId: ENV.r2PrivateAccessKeyId,
    secretAccessKey: ENV.r2PrivateSecretAccessKey,
    endpoint: ENV.r2PrivateEndpoint,
    bucketName: ENV.r2PrivateBucketName,
    signedUrlExpiresSeconds: ENV.r2PrivateSignedUrlExpiresSeconds,
  });
  if (problem) {
    // `problem.detail` names the failed rule only (e.g. "R2_PRIVATE_ENDPOINT
    // must use https") - never the actual configured endpoint/bucket/account
    // value, safe to log and to include in the thrown error's own message.
    console.error("[R2PrivateStorage] Configuration invalid", { category: problem.category, detail: problem.detail });
    throw new R2PrivateStorageError(
      `Private R2 storage configuration is invalid: ${problem.detail}`,
      "not_configured",
      { category: problem.category, retryable: false }
    );
  }

  const bucketName = ENV.r2PrivateBucketName.trim();
  cachedClient = {
    bucketName,
    client: new S3Client({
      region: "auto",
      endpoint: ENV.r2PrivateEndpoint.trim(),
      forcePathStyle: true,
      credentials: {
        accessKeyId: ENV.r2PrivateAccessKeyId.trim(),
        secretAccessKey: ENV.r2PrivateSecretAccessKey.trim(),
      },
    }),
  };
  return cachedClient;
}

/**
 * Validates a RAW object key before any S3 call - never strips or
 * normalizes anything first (a previous version stripped a leading slash
 * before validating, which meant "/episodes/9/file.pdf" was silently
 * accepted as "episodes/9/file.pdf" instead of being rejected; that
 * silent-rewrite behavior is gone). Checks: non-empty, no control/null
 * characters, no backslashes, no leading slash, no `..` path-traversal
 * segment, and must live under the exact prefix owned by `context`
 * (payment-slips/ or episodes/). Throws "invalid_reference" on any
 * violation - this never runs against user-typed free text, only against
 * server-generated keys or values already stored in our own DB columns, so
 * a failure here indicates a bug or tampering, not a normal user error.
 */
function assertSafeObjectKey(key: string, context: PrivateObjectContext): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new R2PrivateStorageError("Object key is empty", "invalid_reference", { context });
  }
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new R2PrivateStorageError("Object key contains control characters", "invalid_reference", { key, context });
  }
  if (key.includes("\\")) {
    throw new R2PrivateStorageError("Object key must not contain a backslash", "invalid_reference", { key, context });
  }
  if (key.startsWith("/")) {
    throw new R2PrivateStorageError("Object key must not start with a slash", "invalid_reference", { key, context });
  }
  if (key.split("/").some((segment) => segment === "..")) {
    throw new R2PrivateStorageError("Object key must not contain a path-traversal segment", "invalid_reference", { key, context });
  }
  const requiredPrefix = CONTEXT_KEY_PREFIXES[context];
  if (!key.startsWith(requiredPrefix)) {
    throw new R2PrivateStorageError(`Object key must start with "${requiredPrefix}" for this context`, "invalid_reference", { key, context });
  }
  return key;
}

/**
 * Upload a buffer to the private R2 bucket. Returns only the object key -
 * never a URL, since private objects have no public URL. Store the key
 * (via toPrivateObjectRef()) in the DB; resolve it to a signed URL only at
 * the moment it's actually needed (see resolveStoredFileValue below).
 */
export async function putPrivateObject(
  context: PrivateObjectContext,
  relKey: string,
  data: Buffer,
  contentType: string
): Promise<{ key: string }> {
  const { client, bucketName } = getPrivateR2Client();
  const key = assertSafeObjectKey(relKey, context);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
  } catch (err) {
    // Fixed, safe fields only - never the object key, never `.message`
    // (which can itself echo the endpoint/bucket in some AWS SDK error
    // variants), never a bucket name, endpoint, or credential. See
    // r2ErrorClassifier.ts - only structural, non-secret fields are read.
    const classified = classifyStorageSdkError(err);
    console.error("[R2PrivateStorage] Operation failed", { operation: "put", context, reason: "upload_failed", ...classified });
    throw new R2PrivateStorageError("Private R2 upload failed", "upload_failed", { key, context, operation: "put", ...classified });
  }

  return { key };
}

/**
 * Payment-evidence writer. `IfNoneMatch: "*"` makes the provider reject an
 * overwrite even when a caller accidentally reuses a key. Only payment slips
 * use this contract; episode/media migration keeps the legacy put helper.
 */
export async function putPrivateObjectCreateOnly(
  context: "paymentSlip",
  relKey: string,
  data: Buffer,
  contentType: string
): Promise<{ key: string }> {
  const { client, bucketName } = getPrivateR2Client();
  const key = assertSafeObjectKey(relKey, context);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
        IfNoneMatch: "*",
        Metadata: { "ipenovel-sha256": createHash("sha256").update(data).digest("hex") },
      })
    );
  } catch (err) {
    const classified = classifyStorageSdkError(err);
    const alreadyExists = classified.httpStatusCode === 412;
    console.error("[R2PrivateStorage] Operation failed", {
      operation: "put",
      context,
      reason: alreadyExists ? "object_already_exists" : "upload_failed",
      ...classified,
      retryable: !alreadyExists && classified.retryable,
    });
    throw new R2PrivateStorageError(
      alreadyExists ? "Private R2 object identity already exists" : "Private R2 upload failed",
      alreadyExists ? "object_already_exists" : "upload_failed",
      { key, context, operation: "put", ...classified, retryable: !alreadyExists && classified.retryable }
    );
  }

  return { key };
}

/**
 * Generate a presigned GetObject URL for an existing private object.
 * Expires after `expiresInSeconds` (default: R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS,
 * falling back to 900s). Never logs the resulting URL (it embeds the
 * signature/query string that grants access) - only the key.
 */
export async function getPrivateObjectSignedUrl(
  context: PrivateObjectContext,
  relKey: string,
  expiresInSeconds: number = ENV.r2PrivateSignedUrlExpiresSeconds
): Promise<string> {
  const { client, bucketName } = getPrivateR2Client();
  const key = assertSafeObjectKey(relKey, context);

  try {
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  } catch (err) {
    // Fixed, safe fields only - see putPrivateObject's catch block above.
    // Deliberately never logs the signed URL itself (it wouldn't exist yet
    // on a failure) or anything from the underlying SDK/presigner error.
    const classified = classifyStorageSdkError(err);
    console.error("[R2PrivateStorage] Operation failed", { operation: "get", context, reason: "download_failed", ...classified });
    throw new R2PrivateStorageError("Failed to create signed URL for private object", "download_failed", { key, context, operation: "get", ...classified });
  }
}

/**
 * Delete an object from the private bucket. Exported for completeness (per
 * the storage adapter contract) - used by server/services/
 * legacyManusAssetMigrationService.ts as best-effort cleanup of the exact
 * just-uploaded object when a compare-and-swap DB write loses its race (see
 * migrateSlipRow there). server/services/fileService.ts's deleteEpisodeFile
 * is still a separate no-op stub with zero callers.
 */
export async function deletePrivateObject(context: PrivateObjectContext, relKey: string): Promise<void> {
  const { client, bucketName } = getPrivateR2Client();
  const key = assertSafeObjectKey(relKey, context);

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (err) {
    // Fixed, safe fields only - see putPrivateObject's catch block above.
    const classified = classifyStorageSdkError(err);
    console.error("[R2PrivateStorage] Operation failed", { operation: "delete", context, reason: "delete_failed", ...classified });
    throw new R2PrivateStorageError("Private R2 delete failed", "delete_failed", { key, context, operation: "delete", ...classified });
  }
}

/**
 * The single read-side resolver: given a value straight out of a
 * slipImageUrl/fileUrl DB column, return whatever a browser/HTTP client can
 * actually fetch right now.
 * - empty/null -> null
 * - a legacy absolute http(s) URL (Manus, public R2, or anything else
 *   already in the DB) -> returned completely unchanged. Never rewritten,
 *   never re-fetched, never validated further - this is the entire legacy
 *   compatibility guarantee.
 * - a private object reference (r2p:<key>) -> resolved to a fresh,
 *   short-lived presigned URL, generated fresh on every call (never
 *   cached/reused - see callers in slipSubmissionService.ts and
 *   walletTopupSubmissionService.ts, which must call this immediately
 *   before every parseSlipImage() call, including retries).
 *
 * Only call this AFTER any entitlement/ownership/admin check has already
 * passed - it performs no authorization of its own.
 */
export async function resolveStoredFileValue(
  value: string | null | undefined,
  context: PrivateObjectContext,
  expiresInSeconds?: number
): Promise<string | null> {
  if (!value) return null;
  if (isPrivateObjectRef(value)) {
    return getPrivateObjectSignedUrl(context, extractPrivateObjectKey(value), expiresInSeconds);
  }
  return value;
}
