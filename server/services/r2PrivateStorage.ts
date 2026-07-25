// Cloudflare R2 storage adapter for the PRIVATE bucket - payment slips and
// paid episode files. Intentionally separate from server/storage.ts (the
// Manus storage proxy, still used for sports-match images and AI-generated
// images) and from server/services/r2Storage.ts (the PUBLIC R2 bucket for
// novel covers/banners). Objects here are never publicly reachable: every
// read goes through getPrivateObjectSignedUrl(), which returns a
// short-lived presigned GetObject URL and nothing else is ever handed to a
// client.
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "../_core/env";
import { isPrivateObjectRef, extractPrivateObjectKey } from "@shared/privateFileRef";

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

export class R2PrivateStorageError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "not_configured"
      | "upload_failed"
      | "download_failed"
      | "delete_failed"
      | "invalid_reference",
    public readonly details?: { key?: string; context?: PrivateObjectContext }
  ) {
    super(message);
    this.name = "R2PrivateStorageError";
  }

  /**
   * Safe, no-secrets summary for server-side logging or for building a
   * client-facing error message from. Deliberately excludes `.message`
   * (which may echo an underlying SDK error string) - callers must map
   * `.reason` to a fixed, generic message before it ever reaches a client.
   * Never includes bucket name, endpoint, credentials, or a signed URL.
   */
  getSafeDetails() {
    return { reason: this.reason, context: this.details?.context, key: this.details?.key };
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

let cachedClient: S3Client | null = null;

function getPrivateR2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const missing = getMissingR2PrivateEnvVars();
  if (missing.length > 0) {
    // The var *names* are not secrets - only used server-side for ops
    // visibility, never forwarded to a client (see getSafeDetails()).
    throw new R2PrivateStorageError(
      `Private R2 storage is not configured - missing env var(s): ${missing.join(", ")}`,
      "not_configured"
    );
  }

  cachedClient = new S3Client({
    region: "auto",
    endpoint: ENV.r2PrivateEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENV.r2PrivateAccessKeyId,
      secretAccessKey: ENV.r2PrivateSecretAccessKey,
    },
  });
  return cachedClient;
}

function normalizeKey(relKey: string): string {
  return typeof relKey === "string" ? relKey.replace(/^\/+/, "") : relKey;
}

/**
 * Validates an object key before any S3 call: non-empty, no control/null
 * characters, no backslashes, no leading slash (checked again here even
 * after normalizeKey strips leading slashes from well-formed input, so a
 * key built any other way still gets the same guarantee), no `..`
 * path-traversal segment, and must live under the exact prefix owned by
 * `context` (payment-slips/ or episodes/). Throws "invalid_reference" on
 * any violation - this never runs against user-typed free text, only
 * against server-generated keys or values already stored in our own DB
 * columns, so a failure here indicates a bug or tampering, not a normal
 * user error.
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
  const client = getPrivateR2Client();
  const key = assertSafeObjectKey(normalizeKey(relKey), context);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: ENV.r2PrivateBucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
  } catch (error) {
    console.error("[R2PrivateStorage] Upload failed", {
      key,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new R2PrivateStorageError("Private R2 upload failed", "upload_failed", { key, context });
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
  const client = getPrivateR2Client();
  const key = assertSafeObjectKey(normalizeKey(relKey), context);

  try {
    const command = new GetObjectCommand({ Bucket: ENV.r2PrivateBucketName, Key: key });
    return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  } catch (error) {
    console.error("[R2PrivateStorage] Failed to create signed URL", {
      key,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new R2PrivateStorageError("Failed to create signed URL for private object", "download_failed", { key, context });
  }
}

/**
 * Delete an object from the private bucket. Exported for completeness (per
 * the storage adapter contract) - not currently wired into any caller,
 * since no real deletion flow exists yet anywhere in the app
 * (server/services/fileService.ts's deleteEpisodeFile is still a no-op
 * stub with zero callers).
 */
export async function deletePrivateObject(context: PrivateObjectContext, relKey: string): Promise<void> {
  const client = getPrivateR2Client();
  const key = assertSafeObjectKey(normalizeKey(relKey), context);

  try {
    await client.send(new DeleteObjectCommand({ Bucket: ENV.r2PrivateBucketName, Key: key }));
  } catch (error) {
    console.error("[R2PrivateStorage] Delete failed", {
      key,
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new R2PrivateStorageError("Private R2 delete failed", "delete_failed", { key, context });
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
