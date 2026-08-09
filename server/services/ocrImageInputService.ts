/**
 * Prepares a payment-slip image for the OCR/LLM vision call, scoped
 * strictly to the trusted payment-slip path (server/services/
 * slipSubmissionService.ts and walletTopupSubmissionService.ts) - never a
 * general-purpose URL fetcher. See getLLMRuntimeMode() in
 * server/_core/llm.ts for why: an arbitrary "fetch whatever URL the LLM
 * caller wants" primitive would broaden the SSRF attack surface for every
 * future invokeLLM() caller, not just this one trusted flow.
 *
 * Two runtime modes, two different behaviors (proven on Coolify staging -
 * a private R2 signed HTTPS URL handed directly to a generic
 * OpenAI-compatible provider as image_url.url gets HTTP 400; the exact
 * same object, fetched server-side and sent as a base64 data URL, gets
 * HTTP 200):
 *   - legacy_forge: completely unchanged - resolveStoredFileValue()'s
 *     existing signed-URL-or-legacy-URL-unchanged behavior, handed
 *     straight to Forge. No base64 conversion, no server-side image fetch
 *     added here.
 *   - generic: ONLY when the ORIGINAL stored value was a private `r2p:`
 *     reference (checked BEFORE resolving - once resolved, a signed URL
 *     and a legacy absolute URL both just look like https://, which is
 *     exactly the ambiguity this must not rely on) does this generate a
 *     fresh signed URL, fetch it server-side under a size/MIME/timeout
 *     bound, and convert it to a `data:<mime>;base64,...` URL. A legacy
 *     absolute URL in generic mode is NEVER server-fetched - it fails
 *     closed into the existing OCR technical-error/manual-review path,
 *     the same as every other failure mode here.
 */
import { getLLMRuntimeMode, type LLMRuntimeMode } from "../_core/llm";
import { resolveStoredFileValue } from "./r2PrivateStorage";
import { isPrivateObjectRef } from "@shared/privateFileRef";

/** Matches slipFileUploadService.ts's own MAX_FILE_SIZE - never larger than what a slip upload could have produced in the first place. */
export const MAX_OCR_IMAGE_BYTES = 5 * 1024 * 1024;

/** Bounds both the initial connection AND the body read below (same AbortController/signal for the whole operation). */
export const OCR_IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Only the MIME types the upload pipeline actually treats as
 * automatically-OCR-able images. `application/pdf` is deliberately absent
 * even though slipFileUploadService.ts accepts it for upload - PDFs already
 * require manual review, never automatic Vision OCR/auto-approval, and
 * must not be silently sent to a vision endpoint as if they were an image.
 */
const SUPPORTED_OCR_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export type OcrImagePreparationFailureReason =
  | "OCR_IMAGE_MODE_UNAVAILABLE"
  | "OCR_IMAGE_SIGNED_URL_FAILED"
  | "OCR_IMAGE_LEGACY_URL_UNSUPPORTED"
  | "OCR_IMAGE_FETCH_FAILED"
  | "OCR_IMAGE_FETCH_TIMEOUT"
  | "OCR_IMAGE_TOO_LARGE"
  | "OCR_IMAGE_UNSUPPORTED_TYPE"
  | "OCR_IMAGE_EMPTY_BODY";

/**
 * Thrown only internally (fetchAndEncodeImage/readBodyBounded) and always
 * caught by prepareSlipImageForOcr - never propagates to a caller. `.message`
 * is always exactly the fixed reason string, so even if some future caller
 * changes to log a caught error's `.message` directly, nothing unsafe (URL,
 * bytes, headers) can ever be in it.
 */
export class OcrImagePreparationError extends Error {
  constructor(public readonly reason: OcrImagePreparationFailureReason) {
    super(`OCR image preparation failed: ${reason}`);
    this.name = "OcrImagePreparationError";
  }
}

function logOcrImagePreparationFailure(reason: OcrImagePreparationFailureReason): void {
  console.warn(`[OCR] image preparation failed: ${reason}`);
}

/** Strips `; charset=...` and any other parameters - never trusts a filename/extension, only this header. */
function normalizeContentType(rawContentType: string | null): string {
  if (!rawContentType) return "";
  return rawContentType.split(";")[0].trim().toLowerCase();
}

/**
 * Reads the response body up to `maxBytes`, aborting as soon as the running
 * total exceeds it - never accumulates an unbounded stream in memory, and
 * never relies on Content-Length alone (the caller already checked that
 * header first; this is the real enforcement for a missing/understated one).
 */
async function readBodyBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new OcrImagePreparationError("OCR_IMAGE_TOO_LARGE");
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new OcrImagePreparationError("OCR_IMAGE_TOO_LARGE");
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof OcrImagePreparationError) throw err;
    throw new OcrImagePreparationError(signal.aborted ? "OCR_IMAGE_FETCH_TIMEOUT" : "OCR_IMAGE_FETCH_FAILED");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function fetchAndEncodeImage(
  signedUrl: string,
  opts: { fetchImpl: typeof fetch; timeoutMs: number; maxBytes: number }
): Promise<string> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      // redirect: "error" - a server-generated R2 presigned URL should
      // never need to redirect; following one would defeat the point of
      // only ever fetching a URL this server itself just generated.
      response = await opts.fetchImpl(signedUrl, { signal: controller.signal, redirect: "error" });
    } catch {
      throw new OcrImagePreparationError(
        controller.signal.aborted ? "OCR_IMAGE_FETCH_TIMEOUT" : "OCR_IMAGE_FETCH_FAILED"
      );
    }

    if (!response.ok) {
      throw new OcrImagePreparationError("OCR_IMAGE_FETCH_FAILED");
    }

    // A. Content-Length check first, when present - cheap early rejection
    // before spending any time on the body. Never trusted alone (see B).
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > opts.maxBytes) {
        throw new OcrImagePreparationError("OCR_IMAGE_TOO_LARGE");
      }
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!SUPPORTED_OCR_IMAGE_MIME_TYPES.has(contentType)) {
      throw new OcrImagePreparationError("OCR_IMAGE_UNSUPPORTED_TYPE");
    }

    // B. The real enforcement - bounded regardless of what Content-Length claimed.
    const bodyBytes = await readBodyBounded(response, opts.maxBytes, controller.signal);
    if (bodyBytes.length === 0) {
      throw new OcrImagePreparationError("OCR_IMAGE_EMPTY_BODY");
    }

    return `data:${contentType};base64,${bodyBytes.toString("base64")}`;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export type PrepareSlipImageForOcrDeps = {
  /** Defaults to server/_core/llm.ts's getLLMRuntimeMode(). */
  getRuntimeMode?: () => LLMRuntimeMode;
  /** Defaults to r2PrivateStorage.ts's resolveStoredFileValue(). Reused (not reimplemented) for both modes - a private ref always goes through the same signed-URL generation either way; only what happens AFTER differs. */
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
 * Call this BEFORE parseSlipImage() with the RAW value straight out of the
 * DB column (payments.slipImageUrl / walletTopups.slipImageUrl) - never a
 * pre-resolved URL, since the private-vs-legacy distinction this function
 * relies on can only be made on the original, unresolved value.
 *
 * Returns the string to hand to parseSlipImage(), or `null` on ANY failure
 * (unconfigured LLM, signed URL failure, fetch failure/timeout, too large,
 * unsupported/PDF MIME, empty body, or a legacy absolute URL in generic
 * mode) - callers should keep their existing `parseSlipImage(result || "")`
 * pattern exactly as it was; an empty image_url reaching invokeLLM() is
 * already handled by parseSlipImage()'s own try/catch as a technical error,
 * routing to the existing pending_review/OCR_PROCESSING_ERROR path. This
 * function itself never throws.
 */
export async function prepareSlipImageForOcr(
  rawStoredValue: string | null | undefined,
  deps: PrepareSlipImageForOcrDeps = {}
): Promise<string | null> {
  const getRuntimeMode = deps.getRuntimeMode ?? getLLMRuntimeMode;
  const resolveStoredFileValueFn = deps.resolveStoredFileValueFn ?? resolveStoredFileValue;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? OCR_IMAGE_FETCH_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? MAX_OCR_IMAGE_BYTES;

  let mode: LLMRuntimeMode;
  try {
    mode = getRuntimeMode();
  } catch {
    logOcrImagePreparationFailure("OCR_IMAGE_MODE_UNAVAILABLE");
    return null;
  }

  if (mode === "legacy_forge") {
    try {
      return await resolveStoredFileValueFn(rawStoredValue, "paymentSlip");
    } catch {
      logOcrImagePreparationFailure("OCR_IMAGE_SIGNED_URL_FAILED");
      return null;
    }
  }

  // generic mode: only ever fetches a value whose ORIGINAL form was a
  // private r2p: reference - an arbitrary legacy absolute URL is never
  // server-fetched, closing off the SSRF surface a general "fetch this
  // URL" helper would otherwise open.
  if (!isPrivateObjectRef(rawStoredValue)) {
    if (rawStoredValue) {
      logOcrImagePreparationFailure("OCR_IMAGE_LEGACY_URL_UNSUPPORTED");
    }
    return null;
  }

  let signedUrl: string | null;
  try {
    signedUrl = await resolveStoredFileValueFn(rawStoredValue, "paymentSlip");
  } catch {
    signedUrl = null;
  }
  if (!signedUrl) {
    logOcrImagePreparationFailure("OCR_IMAGE_SIGNED_URL_FAILED");
    return null;
  }

  try {
    return await fetchAndEncodeImage(signedUrl, { fetchImpl, timeoutMs, maxBytes });
  } catch (error) {
    logOcrImagePreparationFailure(
      error instanceof OcrImagePreparationError ? error.reason : "OCR_IMAGE_FETCH_FAILED"
    );
    return null;
  }
}
