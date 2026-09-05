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
/** Historical Manus storage CDN used by legacy absolute slip URLs. Keeping
 * this as an exact hostname allowlist (rather than accepting arbitrary
 * http(s)) lets approval prove current bytes without re-introducing SSRF. */
export const TRUSTED_LEGACY_SLIP_HOSTS = new Set(["d2xsxph8kpxj0f.cloudfront.net"]);

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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("SLIP_HASH_FETCH_TIMEOUT");
}

function checkDeadline(controller: AbortController, expiresAt: number): void {
  // Also reject elapsed deadlines before the event loop has run the timer,
  // e.g. if a signer or a ready body completes through queued microtasks.
  if (performance.now() >= expiresAt) controller.abort();
  throwIfAborted(controller.signal);
}

/** Cleanup must not extend the read deadline if a source never finishes canceling. */
function cancelWithoutWaiting(cancel: () => Promise<unknown>): void {
  try {
    // Observe asynchronous rejection without awaiting an uncooperative source.
    void cancel().catch(() => {});
  } catch {
    // A synchronous cleanup failure cannot turn this into a usable identifier.
  }
}

function cancelResponseBody(response: Response): void {
  if (response.body) cancelWithoutWaiting(() => response.body!.cancel());
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
  let canceled = false;
  const cancelReader = () => {
    if (canceled) return;
    canceled = true;
    cancelWithoutWaiting(() => reader.cancel());
  };

  // A fetch may have returned headers before its body stalls. Canceling the
  // reader also settles a pending read when the source's cancel promise hangs.
  signal.addEventListener("abort", cancelReader, { once: true });

  try {
    throwIfAborted(signal);
    while (true) {
      const { done, value } = await reader.read();
      // cancel() can resolve read() with done=true after some chunks arrived;
      // those partial bytes must never become a successful file identifier.
      throwIfAborted(signal);
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        // Bounded read: a slip larger than the cap is refused rather than
        // buffered, so this can never be used to exhaust memory.
        if (total > maxBytes) throw new Error("SLIP_HASH_TOO_LARGE");
        chunks.push(value);
      }
    }
    if (total === 0) throw new Error("SLIP_HASH_EMPTY_BODY");
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } catch (error) {
    cancelReader();
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
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
/**
 * Exact-byte hash for the one historical public CDN that legacy Manus slip
 * rows can reference. This path is intentionally narrower than a generic URL
 * fetch: HTTPS only, exact hostname allowlist, default port only, no embedded
 * credentials, and redirects are rejected so an allowlisted URL cannot bounce
 * the server toward an internal address. Same timeout/size bounds as private
 * R2 hashing. Returns undefined on every validation/fetch failure.
 */
function parseTrustedLegacySlipUrl(rawUrl: string | null | undefined): URL | undefined {
  if (!rawUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    !TRUSTED_LEGACY_SLIP_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return undefined;
  }
  return parsed;
}

/** True only for the exact historical CDN URL shape eligible for legacy handling. */
export function isTrustedLegacySlipUrl(rawUrl: string | null | undefined): boolean {
  return parseTrustedLegacySlipUrl(rawUrl) !== undefined;
}

export async function computeTrustedLegacySlipFileHash(
  rawUrl: string | null | undefined,
  deps: Pick<ComputeSlipFileHashDeps, "fetchImpl" | "timeoutMs" | "maxBytes"> = {}
): Promise<string | undefined> {
  const parsed = parseTrustedLegacySlipUrl(rawUrl);
  if (!parsed) return undefined;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SLIP_HASH_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? MAX_SLIP_HASH_BYTES;
  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    checkDeadline(controller, expiresAt);
    const response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      cancelResponseBody(response);
      return undefined;
    }
    const bytes = await readBodyBounded(response, maxBytes, controller.signal);
    checkDeadline(controller, expiresAt);
    return hashSlipBytes(bytes);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

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

  const controller = new AbortController();
  const expiresAt = performance.now() + timeoutMs;
  // Include signing in the budget. The production signer uses local static
  // credentials; an injected/noncooperative signer cannot be forcibly canceled,
  // so await it but refuse any result that arrives after this deadline.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let signedUrl: string | null;
    try {
      signedUrl = await resolveFn(rawStoredValue, "paymentSlip");
    } catch {
      signedUrl = null;
    }
    checkDeadline(controller, expiresAt);
    if (!signedUrl) {
      logFailure("SLIP_HASH_SIGNED_URL_FAILED");
      return undefined;
    }

    const response = await fetchImpl(signedUrl, { signal: controller.signal });
    if (!response.ok) {
      cancelResponseBody(response);
      logFailure("SLIP_HASH_FETCH_FAILED");
      return undefined;
    }

    const bytes = await readBodyBounded(response, maxBytes, controller.signal);
    checkDeadline(controller, expiresAt);
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
