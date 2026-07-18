// Cloudflare R2 storage adapter for newly-uploaded, optimized media (novel
// covers, banners) - see imageOptimizer.ts for the WebP conversion step that
// runs before a buffer reaches r2Put(). Intentionally separate from
// server/storage.ts (the Manus storage proxy used everywhere else - payment
// slips, etc.), which is left completely untouched: existing DB rows that
// still point at the old storage keep working unchanged, only NEW
// cover/banner uploads are routed here.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { ENV } from "../_core/env";

export class R2StorageError extends Error {
  constructor(
    message: string,
    public readonly reason: "not_configured" | "upload_failed"
  ) {
    super(message);
    this.name = "R2StorageError";
  }

  /** Safe, no-secrets summary for server-side logging. */
  getSafeDetails() {
    return { reason: this.reason };
  }
}

function getMissingR2EnvVars(): string[] {
  const required: Array<[string, string]> = [
    ["R2_ACCOUNT_ID", ENV.r2AccountId],
    ["R2_ACCESS_KEY_ID", ENV.r2AccessKeyId],
    ["R2_SECRET_ACCESS_KEY", ENV.r2SecretAccessKey],
    ["R2_BUCKET_NAME", ENV.r2BucketName],
    ["R2_PUBLIC_BASE_URL", ENV.r2PublicBaseUrl],
    ["R2_ENDPOINT", ENV.r2Endpoint],
  ];
  return required.filter(([, value]) => !value).map(([name]) => name);
}

/** True only when every R2 env var is present - safe to call from anywhere
 *  (e.g. to decide whether to show an "upload disabled" hint in the admin
 *  UI) without risking a throw. */
export function isR2Configured(): boolean {
  return getMissingR2EnvVars().length === 0;
}

let cachedClient: S3Client | null = null;

function getR2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const missing = getMissingR2EnvVars();
  if (missing.length > 0) {
    throw new R2StorageError(
      `R2 storage is not configured - missing env var(s): ${missing.join(", ")}`,
      "not_configured"
    );
  }

  cachedClient = new S3Client({
    region: "auto",
    endpoint: ENV.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: ENV.r2AccessKeyId,
      secretAccessKey: ENV.r2SecretAccessKey,
    },
  });
  return cachedClient;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function buildPublicUrl(key: string): string {
  const base = ENV.r2PublicBaseUrl.replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * Upload a buffer to the R2 bucket and return its public URL, built as
 * `${R2_PUBLIC_BASE_URL}/${key}` (the bucket must be configured for public
 * read access / a public custom domain for this URL to actually resolve).
 * Throws R2StorageError - "not_configured" when any R2 env var is missing,
 * "upload_failed" for any error the R2 API itself returns - so callers (the
 * uploadCover/uploadImage tRPC procedures) can map it to a clear message
 * without ever leaking credentials.
 */
export async function r2Put(
  relKey: string,
  data: Buffer,
  contentType: string
): Promise<{ key: string; url: string }> {
  const client = getR2Client();
  const key = normalizeKey(relKey);

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: ENV.r2BucketName,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
  } catch (error: any) {
    throw new R2StorageError(
      `R2 upload failed: ${error?.message || "unknown error"}`,
      "upload_failed"
    );
  }

  return { key, url: buildPublicUrl(key) };
}
