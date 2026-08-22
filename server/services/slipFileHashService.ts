/**
 * Server-side computation of a slip's exact-file identifier.
 *
 * ── Why this is separate from the OCR image path ──────────────────────────
 * fileHash must be available even when OCR fails COMPLETELY. A provider
 * outage, a rate limit, or an unreadable image all leave us with no
 * reference and no QR payload - and without a file hash such a slip would
 * carry no strong identifier at all, meaning nothing could stop it being
 * submitted again. So the hash is computed from the stored bytes
 * independently of, and before, any LLM call.
 *
 * It is also deliberately independent of the LLM runtime mode: the OCR image
 * path only fetches bytes in "generic" mode (in "legacy_forge" it hands a
 * signed URL straight to the provider), whereas a slip needs its identifier
 * in both modes.
 *
 * ── Never trust the client ────────────────────────────────────────────────
 * The hash is ALWAYS derived from the bytes actually stored in the private
 * bucket. It is never accepted from a request, never round-tripped through
 * the browser, and never read back out of client-supplied JSON. A caller
 * cannot forge it because there is no input parameter through which to
 * supply one - the only argument is the server-held storage reference.
 *
 * ── SSRF ──────────────────────────────────────────────────────────────────
 * Only a private `r2p:` reference is ever fetched, exactly as
 * ocrImageInputService does. A legacy absolute URL is never server-fetched,
 * so this cannot be turned into a "fetch any URL for me" primitive.
 */

import crypto from "crypto";
import { resolveStoredFileValue } from "./r2PrivateStorage";
import { isPrivateObjectRef } from "@shared/privateFileRef";

/** Matches the OCR path's cap - a slip is never legitimately larger. */
export const MAX_SLIP_HASH_BYTES = 5 * 1024 * 1024;
export const SLIP_HASH_FETCH_TIMEOUT_MS = 10_000;

export type SlipFileHashFailureReason =
  | "SLIP_HASH_NOT_PRIVATE_REF"
  | "SLIP_HASH_SIGNED_URL_FAILED"
  | "SLIP_HASH_FETCH_FAILED"
  | "SLIP_HASH_FETCH_TIMEOUT"
  | "SLIP_HASH_TOO_LARGE"
  | "SLIP_HASH_EMPTY_BODY";

export type ComputeSlipFileHashDeps = {
  resolveStoredFileValueFn?: (
    value: string | null | undefined,
    context: "paymentSlip",
    expiresInSeconds?: number
  ) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * SHA-256 of the raw slip bytes, namespaced so it can never collide with a
 * reference hash or a QR hash. Exported for direct unit testing against
 * known byte arrays.
 */
export function hashSlipBytes(bytes: Uint8Array | Buffer): string {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(bytes))
    .update("slip:file:v1")
    .digest("hex");
}

function logFailure(reason: SlipFileHashFailureReason): void {
  // Fixed reason code only - never the key, bucket, signed URL, or bytes.
  console.warn(`[SlipHash] could not compute file identifier: ${reason}`);
}

async function readBodyBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  if (!response.body) {
    throw new Error("SLIP_HASH_EMPTY_BODY");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        // Bounded read: a slip larger than the cap is refused rather than
        // buffered, so this can never be used to exhaust memory.
        if (total > maxBytes) throw new Error("SLIP_HASH_TOO_LARGE");
        chunks.push(value);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) throw new Error("SLIP_HASH_FETCH_TIMEOUT");
    throw error;
  }

  if (total === 0) throw new Error("SLIP_HASH_EMPTY_BODY");
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Computes the exact-file identifier for a stored slip.
 *
 * Pass the RAW value straight out of the DB column
 * (payments.slipImageUrl / walletTopups.slipImageUrl) - never a pre-resolved
 * URL, since the private-vs-legacy distinction can only be made on the
 * original value.
 *
 * Returns `undefined` on ANY failure and never throws: a missing file hash
 * must degrade to "this slip has one fewer strong identifier", never to a
 * failed payment submission. Callers treat `undefined` as "no exact-file
 * identifier available".
 */
export async function computeSlipFileHash(
  rawStoredValue: string | null | undefined,
  deps: ComputeSlipFileHashDeps = {}
): Promise<string | undefined> {
  const resolveFn = deps.resolveStoredFileValueFn ?? resolveStoredFileValue;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SLIP_HASH_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? MAX_SLIP_HASH_BYTES;

  if (!rawStoredValue) return undefined;

  // SSRF guard: only ever fetch our own private objects.
  if (!isPrivateObjectRef(rawStoredValue)) {
    logFailure("SLIP_HASH_NOT_PRIVATE_REF");
    return undefined;
  }

  let signedUrl: string | null;
  try {
    signedUrl = await resolveFn(rawStoredValue, "paymentSlip");
  } catch {
    signedUrl = null;
  }
  if (!signedUrl) {
    logFailure("SLIP_HASH_SIGNED_URL_FAILED");
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(signedUrl, { signal: controller.signal });
    if (!response.ok) {
      logFailure("SLIP_HASH_FETCH_FAILED");
      return undefined;
    }

    const bytes = await readBodyBounded(response, maxBytes, controller.signal);
    return hashSlipBytes(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason: SlipFileHashFailureReason =
      message === "SLIP_HASH_TOO_LARGE"
        ? "SLIP_HASH_TOO_LARGE"
        : message === "SLIP_HASH_EMPTY_BODY"
          ? "SLIP_HASH_EMPTY_BODY"
          : controller.signal.aborted || message === "SLIP_HASH_FETCH_TIMEOUT"
            ? "SLIP_HASH_FETCH_TIMEOUT"
            : "SLIP_HASH_FETCH_FAILED";
    logFailure(reason);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Admin-safe display status for the exact-file identifier.
 *
 * The raw hash is NEVER surfaced - it is a fingerprint of a customer's
 * payment document, and showing it in a panel would leak it into
 * screenshots, logs and support tickets for no operational benefit. An admin
 * only ever needs to know whether the identifier exists and whether it
 * collided.
 */
export type FileIdentifierStatus = "AVAILABLE" | "MATCH" | "UNAVAILABLE";

export function describeFileIdentifierStatus(input: {
  fileHash?: string | null;
  duplicateFileMatch?: boolean;
}): FileIdentifierStatus {
  if (!input.fileHash) return "UNAVAILABLE";
  return input.duplicateFileMatch ? "MATCH" : "AVAILABLE";
}
