// Safe, DB/network-free validation of the private-R2 configuration, run
// before a client is ever constructed. Distinguishes three cases:
//   - CONFIG_MISSING: one or more required vars are absent entirely.
//   - ENDPOINT_INVALID: every rule specific to R2_PRIVATE_ENDPOINT itself
//     (must be HTTPS, no embedded credentials/query/fragment/bucket-path, a
//     real Cloudflare R2 host, and its account must agree with
//     R2_PRIVATE_ACCOUNT_ID) - this is almost always a copy-paste mistake in
//     exactly one variable, worth its own category so an admin can jump
//     straight to R2_PRIVATE_ENDPOINT instead of re-checking all five vars.
//   - CONFIG_INVALID: every other malformation (bucket name shaped like a
//     URL/path/has whitespace/invalid characters, signed-URL expiry out of
//     range).
// All three are safe to detect and log without ever exposing the actual
// endpoint/bucket/account values, only which named rule failed.

export interface R2PrivateConfigInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucketName: string;
  signedUrlExpiresSeconds: number;
}

export interface R2PrivateConfigProblem {
  category: "CONFIG_MISSING" | "CONFIG_INVALID" | "ENDPOINT_INVALID";
  /** Safe to log: the name of the failed rule only - never an actual
   *  configured value (endpoint, bucket, account ID, or credential). */
  detail: string;
}

const MIN_SIGNED_URL_EXPIRES_SECONDS = 60; // 1 minute
const MAX_SIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Real S3/R2 bucket-name rules: lowercase letters, digits, dots, hyphens;
// 3-63 chars; must start/end with a letter or digit.
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Validates the private-R2 configuration. Returns `null` when everything is
 * present and well-formed, or a single `R2PrivateConfigProblem` describing
 * the first rule that failed (safe detail string, no values). All string
 * inputs are trimmed before any check - "whitespace around environment
 * values must be handled safely" per this pass's own requirement.
 */
export function validatePrivateR2Config(input: R2PrivateConfigInput): R2PrivateConfigProblem | null {
  const accountId = input.accountId.trim();
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const endpoint = input.endpoint.trim();
  const bucketName = input.bucketName.trim();

  const missing: string[] = [];
  if (!accountId) missing.push("R2_PRIVATE_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_PRIVATE_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_PRIVATE_SECRET_ACCESS_KEY");
  if (!endpoint) missing.push("R2_PRIVATE_ENDPOINT");
  if (!bucketName) missing.push("R2_PRIVATE_BUCKET_NAME");
  if (missing.length > 0) {
    return { category: "CONFIG_MISSING", detail: `missing: ${missing.join(", ")}` };
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT is not a valid URL" };
  }

  if (parsedEndpoint.protocol !== "https:") {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT must use https" };
  }
  if (parsedEndpoint.username || parsedEndpoint.password) {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT must not contain credentials" };
  }
  if (parsedEndpoint.search) {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT must not contain a query string" };
  }
  if (parsedEndpoint.hash) {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT must not contain a fragment" };
  }
  if (parsedEndpoint.pathname !== "" && parsedEndpoint.pathname !== "/") {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT must not include a bucket path" };
  }
  const hostname = parsedEndpoint.hostname.toLowerCase();
  if (!hostname.endsWith(".r2.cloudflarestorage.com")) {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ENDPOINT is not a valid Cloudflare R2 endpoint" };
  }
  if (!hostname.startsWith(`${accountId.toLowerCase()}.`)) {
    return { category: "ENDPOINT_INVALID", detail: "R2_PRIVATE_ACCOUNT_ID does not match R2_PRIVATE_ENDPOINT hostname" };
  }

  if (bucketName.includes("://") || /^[a-z][a-z0-9+.-]*:/i.test(bucketName)) {
    return { category: "CONFIG_INVALID", detail: "R2_PRIVATE_BUCKET_NAME must not be a URL" };
  }
  if (bucketName.includes("/")) {
    return { category: "CONFIG_INVALID", detail: "R2_PRIVATE_BUCKET_NAME must not contain a path separator" };
  }
  if (/\s/.test(bucketName)) {
    return { category: "CONFIG_INVALID", detail: "R2_PRIVATE_BUCKET_NAME must not contain whitespace" };
  }
  if (!BUCKET_NAME_PATTERN.test(bucketName)) {
    return { category: "CONFIG_INVALID", detail: "R2_PRIVATE_BUCKET_NAME is not a valid bucket name" };
  }

  const expires = input.signedUrlExpiresSeconds;
  if (
    !Number.isFinite(expires) ||
    expires < MIN_SIGNED_URL_EXPIRES_SECONDS ||
    expires > MAX_SIGNED_URL_EXPIRES_SECONDS
  ) {
    return { category: "CONFIG_INVALID", detail: "R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS is out of the allowed range" };
  }

  return null;
}
