import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export const LEGACY_SLIP_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export type LegacySlipAuditBytesErrorCode =
  | "ABORTED"
  | "BODY_MISSING"
  | "BODY_UNSUPPORTED"
  | "CHUNK_UNSUPPORTED"
  | "EMPTY_BODY"
  | "TOO_LARGE"
  | "UNSUPPORTED_SIGNATURE"
  | "READ_FAILED"
  | "INVALID_LIMIT";

/** Fixed diagnostic codes only: never expose storage keys or SDK messages. */
export class LegacySlipAuditBytesError extends Error {
  constructor(readonly code: LegacySlipAuditBytesErrorCode) {
    super(`LEGACY_SLIP_AUDIT_${code}`);
    this.name = "LegacySlipAuditBytesError";
  }
}

export interface LegacySlipByteInspection {
  rawHash: string;
  canonicalHash: string;
  byteLength: number;
  /** Signature recognition only, NOT a full image/PDF decode or validity check. */
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new LegacySlipAuditBytesError("ABORTED");
}

/** One pending read and one abort listener; no accumulation across chunks. */
function readNext(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal
): Promise<IteratorResult<unknown>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new LegacySlipAuditBytesError("ABORTED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // Both outcomes remain observed if abort wins while next() is stalled.
    Promise.resolve()
      .then(() => {
        requireActive(signal);
        return iterator.next();
      })
      .then(
        result => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        () => {
          signal.removeEventListener("abort", onAbort);
          reject(
            new LegacySlipAuditBytesError(
              signal.aborted ? "ABORTED" : "READ_FAILED"
            )
          );
        }
      );
  });
}

function detectSignature(header: Buffer): LegacySlipByteInspection["mimeType"] {
  if (
    header.length >= 3 &&
    header[0] === 0xff &&
    header[1] === 0xd8 &&
    header[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    header.length >= 8 &&
    header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    header.length >= 5 &&
    header.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))
  ) {
    return "application/pdf";
  }
  throw new LegacySlipAuditBytesError("UNSUPPORTED_SIGNATURE");
}

/**
 * Read-only inspection of a Node S3 GetObject body / byte AsyncIterable.
 * The caller owns the deadline and must abort `signal` when it expires.
 * Reads at most 5 MiB of actual bytes; ContentLength/ContentType are not trusted.
 * No transformToByteArray(), decoding, persistence, or object-store requests.
 * Two streaming digests consume exactly the same chunks, retaining only an
 * eight-byte signature prefix. An aborted/partial body never returns hashes.
 */
export async function inspectLegacySlipBytes(
  body: unknown,
  options: { signal: AbortSignal; maxBytes?: number }
): Promise<LegacySlipByteInspection> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? LEGACY_SLIP_AUDIT_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > LEGACY_SLIP_AUDIT_MAX_BYTES
  ) {
    throw new LegacySlipAuditBytesError("INVALID_LIMIT");
  }
  if (body == null) throw new LegacySlipAuditBytesError("BODY_MISSING");

  let iterator: AsyncIterator<unknown> | undefined;
  let canceled = false;
  const cancelBody = () => {
    if (canceled) return;
    canceled = true;
    try {
      const stream = body as { destroy?: () => unknown };
      if (typeof stream.destroy === "function") {
        void Promise.resolve(stream.destroy()).catch(() => {});
      }
    } catch {
      /* Cleanup cannot expose source errors or prevent cancellation. */
    }
    try {
      // Async generators may leave return() pending behind a stalled next().
      // Request cleanup but never extend the caller's deadline by awaiting it.
      if (iterator?.return)
        void Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      /* Observe synchronous cleanup failure without leaking it. */
    }
  };

  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    requireActive(signal);
    const getIterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator];
    if (typeof getIterator !== "function")
      throw new LegacySlipAuditBytesError("BODY_UNSUPPORTED");
    iterator = getIterator.call(body);
    if (!iterator || typeof iterator.next !== "function") {
      throw new LegacySlipAuditBytesError("BODY_UNSUPPORTED");
    }
    const raw = createHash("sha256");
    const canonical = createHash("sha256");
    let byteLength = 0;
    let header = Buffer.alloc(0);
    let chunkCount = 0;

    for (;;) {
      requireActive(signal);
      const { done, value } = await readNext(iterator, signal);
      requireActive(signal); // A cancellation-induced done is not a complete file.
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new LegacySlipAuditBytesError("CHUNK_UNSUPPORTED");
      if (value.byteLength > maxBytes - byteLength)
        throw new LegacySlipAuditBytesError("TOO_LARGE");
      byteLength += value.byteLength;
      if (header.length < 8) {
        header = Buffer.concat([
          header,
          Buffer.from(value.subarray(0, 8 - header.length)),
        ]);
      }
      raw.update(value);
      canonical.update(value);
      // Let the caller's timeout fire even for a microtask-only iterable (or
      // an endless sequence of empty chunks), without an unbounded read race.
      if (++chunkCount % 128 === 0) await yieldToEventLoop();
    }

    if (byteLength === 0) throw new LegacySlipAuditBytesError("EMPTY_BODY");
    const mimeType = detectSignature(header);
    requireActive(signal);
    return {
      rawHash: raw.digest("hex"),
      canonicalHash: canonical.update("slip:file:v1").digest("hex"),
      byteLength,
      mimeType,
    };
  } catch (error) {
    cancelBody();
    if (signal.aborted) throw new LegacySlipAuditBytesError("ABORTED");
    if (error instanceof LegacySlipAuditBytesError) throw error;
    throw new LegacySlipAuditBytesError("READ_FAILED");
  } finally {
    signal.removeEventListener("abort", cancelBody);
  }
}
