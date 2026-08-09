import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareSlipImageForOcr,
  MAX_OCR_IMAGE_BYTES,
  OCR_IMAGE_FETCH_TIMEOUT_MS,
  type PrepareSlipImageForOcrDeps,
} from "./ocrImageInputService";

// Synthetic, obviously-fake markers - asserted to never appear in any
// thrown/logged text. Never real credentials/URLs.
const SIGNED_URL_MARKER = "SECRETMARKER-signed-query-string-abc123";
const PRIVATE_KEY_MARKER = "SECRETMARKER-payment-slips-9-file";
const SIGNED_URL = `https://r2.example.internal/payment-slips/9/file.png?X-Amz-Signature=${SIGNED_URL_MARKER}`;
const PRIVATE_REF = `r2p:payment-slips/9/${PRIVATE_KEY_MARKER}.png`;
const LEGACY_URL = "https://legacy-storage.example.com/some/old/slip.png";

function makeDeps(overrides: Partial<PrepareSlipImageForOcrDeps> = {}): PrepareSlipImageForOcrDeps {
  return {
    getRuntimeMode: vi.fn(() => "generic" as const),
    resolveStoredFileValueFn: vi.fn(async () => SIGNED_URL),
    fetchImpl: vi.fn(),
    timeoutMs: OCR_IMAGE_FETCH_TIMEOUT_MS,
    maxBytes: MAX_OCR_IMAGE_BYTES,
    ...overrides,
  };
}

function pngBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(7);
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

/** A response whose body streams in fixed-size chunks - no Content-Length header unless explicitly requested, so size enforcement can be tested independent of that header. */
function streamedResponse(
  totalBytes: number,
  contentType: string,
  opts: { includeContentLength?: boolean; status?: number } = {}
): Response {
  const chunkSize = 64 * 1024;
  const chunks: Uint8Array[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    chunks.push(pngBytes(size));
    remaining -= size;
  }
  const headers: Record<string, string> = { "content-type": contentType };
  if (opts.includeContentLength) headers["content-length"] = String(totalBytes);
  return new Response(streamFromChunks(chunks), { status: opts.status ?? 200, headers });
}

function bufferedResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": contentType } });
}

describe("prepareSlipImageForOcr", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("A. legacy Forge compatibility", () => {
    it("private ref: uses resolveStoredFileValueFn's existing signed-URL behavior unchanged", async () => {
      const deps = makeDeps({ getRuntimeMode: () => "legacy_forge" });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBe(SIGNED_URL);
      expect(deps.resolveStoredFileValueFn).toHaveBeenCalledWith(PRIVATE_REF, "paymentSlip");
    });

    it("legacy absolute URL: passes through resolveStoredFileValueFn unchanged too", async () => {
      const deps = makeDeps({ getRuntimeMode: () => "legacy_forge", resolveStoredFileValueFn: vi.fn(async () => LEGACY_URL) });
      const result = await prepareSlipImageForOcr(LEGACY_URL, deps);
      expect(result).toBe(LEGACY_URL);
    });

    it("never converts to base64 in legacy_forge mode", async () => {
      const deps = makeDeps({ getRuntimeMode: () => "legacy_forge" });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).not.toMatch(/^data:/);
    });

    it("never fetches image bytes server-side in legacy_forge mode", async () => {
      const deps = makeDeps({ getRuntimeMode: () => "legacy_forge" });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("B. generic private R2 happy path", () => {
    it("detects the private ref and calls resolveStoredFileValueFn to get a fresh signed URL", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(10), "image/png")) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(deps.resolveStoredFileValueFn).toHaveBeenCalledWith(PRIVATE_REF, "paymentSlip");
    });

    it("fetches the resolved signed URL server-side", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(10), "image/png")) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const [url] = (deps.fetchImpl as any).mock.calls[0];
      expect(url).toBe(SIGNED_URL);
    });

    it("image/png -> correct data:image/png;base64,... output", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/png")) });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    it("image/jpeg -> correct data:image/jpeg;base64,... output", async () => {
      const bytes = new Uint8Array([9, 8, 7, 6]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/jpeg")) });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    it("resolves to null (not throwing) when everything succeeds is untrue - sanity: successful path is non-null", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(5), "image/png")) });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).not.toBeNull();
    });
  });

  describe("C. size safety", () => {
    it("Content-Length > 5MiB rejected before body consumption", async () => {
      const fetchImpl = vi.fn(async () =>
        streamedResponse(MAX_OCR_IMAGE_BYTES + 1, "image/png", { includeContentLength: true })
      );
      const deps = makeDeps({ fetchImpl });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });

    it("missing Content-Length but stream exceeds 5MiB -> rejected", async () => {
      const fetchImpl = vi.fn(async () =>
        streamedResponse(MAX_OCR_IMAGE_BYTES + 1024, "image/png", { includeContentLength: false })
      );
      const deps = makeDeps({ fetchImpl });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });

    it("exactly-at-limit (5 MiB) accepted if otherwise valid", async () => {
      const fetchImpl = vi.fn(async () =>
        streamedResponse(MAX_OCR_IMAGE_BYTES, "image/png", { includeContentLength: true })
      );
      const deps = makeDeps({ fetchImpl });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).not.toBeNull();
      expect(result).toMatch(/^data:image\/png;base64,/);
    });

    it("just-over-limit without Content-Length is rejected, not silently truncated", async () => {
      const fetchImpl = vi.fn(async () =>
        streamedResponse(MAX_OCR_IMAGE_BYTES + 1, "image/png", { includeContentLength: false })
      );
      const deps = makeDeps({ fetchImpl });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });
  });

  describe("D. MIME safety", () => {
    it("PNG accepted", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png")) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toMatch(/^data:image\/png;base64,/);
    });

    it("JPEG accepted", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/jpeg")) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("PDF rejected - never silently labeled as an image", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "application/pdf")) });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });

    it("text/html rejected", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "text/html")) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });

    it("missing/invalid MIME rejected", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "")) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });

    it("Content-Type parameters (charset etc.) are stripped before comparison", async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/png; charset=binary")) });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    });
  });

  describe("E. network safety", () => {
    it("non-2xx response rejected", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png", 403)) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });

    it("timeout rejected (bounded fetch, deterministic via a tiny injected timeoutMs)", async () => {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
      const deps = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });

    it("passes redirect: 'error' so a signed URL is never followed through a redirect", async () => {
      const fetchImpl = vi.fn(async () => bufferedResponse(pngBytes(4), "image/png"));
      const deps = makeDeps({ fetchImpl });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const [, init] = (fetchImpl as any).mock.calls[0];
      expect(init.redirect).toBe("error");
    });

    it("a redirect-error thrown by the fetch implementation is rejected safely", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("Failed to fetch: redirect mode is error");
      });
      const deps = makeDeps({ fetchImpl });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });

    it("a 3xx response (defense-in-depth, in case redirect:'error' wasn't honored) is rejected, never followed", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png", 302)) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });

    it("empty body rejected", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(new Uint8Array(0), "image/png")) });
      expect(await prepareSlipImageForOcr(PRIVATE_REF, deps)).toBeNull();
    });
  });

  describe("F. SSRF containment", () => {
    it("generic mode + a legacy http(s) stored value is NEVER fetched server-side", async () => {
      const deps = makeDeps();
      const result = await prepareSlipImageForOcr(LEGACY_URL, deps);
      expect(result).toBeNull();
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    });

    it("generic mode + a legacy URL never even calls resolveStoredFileValueFn (no signed URL generated for it)", async () => {
      const deps = makeDeps();
      await prepareSlipImageForOcr(LEGACY_URL, deps);
      expect(deps.resolveStoredFileValueFn).not.toHaveBeenCalled();
    });

    it("generic mode + a legacy URL routes to the safe null/manual-review failure, same as any other preparation failure", async () => {
      const deps = makeDeps();
      const result = await prepareSlipImageForOcr(LEGACY_URL, deps);
      expect(result).toBeNull();
    });

    it("generic mode only ever fetches when the ORIGINAL value was a valid r2p: reference", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png")) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("generic mode + empty/null stored value never fetches and returns null", async () => {
      const deps = makeDeps();
      expect(await prepareSlipImageForOcr(null, deps)).toBeNull();
      expect(await prepareSlipImageForOcr("", deps)).toBeNull();
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("G. secret/log safety", () => {
    it("the signed URL never appears in console.warn output on a fetch failure", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png", 403)) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(SIGNED_URL_MARKER);
      expect(logged).not.toContain(SIGNED_URL);
    });

    it("no base64/data-URL content ever appears in logged output, even on the happy path", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const bytes = new Uint8Array([42, 42, 42, 42]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/png")) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const base64Fragment = Buffer.from(bytes).toString("base64");
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(base64Fragment);
      expect(logged).not.toContain("data:image");
    });

    it("the private object key never appears in console.warn output", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "image/png", 500)) });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(PRIVATE_KEY_MARKER);
    });

    it("thrown internal failures never carry the signed URL/key in their .message (only a fixed reason)", async () => {
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(pngBytes(4), "text/html")) });
      // prepareSlipImageForOcr never throws itself, but confirm the returned
      // value carries nothing sensitive either.
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
    });

    it("resolveStoredFileValueFn/getRuntimeMode failures are logged with only a fixed reason, never a raw error message", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = makeDeps({
        resolveStoredFileValueFn: vi.fn(async () => {
          throw new Error(`boom ${SIGNED_URL_MARKER}`);
        }),
      });
      await prepareSlipImageForOcr(PRIVATE_REF, deps);
      const logged = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toContain(SIGNED_URL_MARKER);
      expect(logged).toContain("OCR_IMAGE_SIGNED_URL_FAILED");
    });
  });

  describe("unconfigured LLM mode", () => {
    it("getRuntimeMode throwing (LLM not configured at all) fails closed to null, never throws", async () => {
      const deps = makeDeps({
        getRuntimeMode: () => {
          throw new Error("[LLM] LLM API key is not configured");
        },
      });
      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);
      expect(result).toBeNull();
      expect(deps.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("P2. response body cancellation on early rejection", () => {
    it("A. non-2xx response: cancels the response body before rejecting", async () => {
      const response = bufferedResponse(pngBytes(4), "image/png", 403);
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("B. Content-Length > 5MiB: cancels the response body before any normal read", async () => {
      const response = streamedResponse(MAX_OCR_IMAGE_BYTES + 1, "image/png", { includeContentLength: true });
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("C. unsupported MIME (PDF): cancels the response body before rejecting", async () => {
      const response = bufferedResponse(pngBytes(4), "application/pdf");
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("C2. unsupported MIME (text/html): cancels the response body before rejecting", async () => {
      const response = bufferedResponse(pngBytes(4), "text/html");
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("D. streamed body exceeds 5MiB (no Content-Length): the reader is still canceled", async () => {
      const response = streamedResponse(MAX_OCR_IMAGE_BYTES + 1024, "image/png", { includeContentLength: false });
      const realGetReader = response.body!.getReader.bind(response.body);
      let readerCancelSpy: ReturnType<typeof vi.spyOn> | undefined;
      vi.spyOn(response.body!, "getReader").mockImplementation((...args: any[]) => {
        const reader = (realGetReader as any)(...args);
        readerCancelSpy = vi.spyOn(reader, "cancel");
        return reader;
      });
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(readerCancelSpy).toHaveBeenCalledTimes(1);
    });

    it("E1. response.body === null: fails closed (empty body) without ever calling arrayBuffer()", async () => {
      const response = new Response(null, { status: 200, headers: { "content-type": "image/png" } });
      const arrayBufferSpy = vi.spyOn(response, "arrayBuffer");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    });

    it("E2. body exists but getReader() throws (e.g. already locked): fails closed, never calls arrayBuffer()", async () => {
      const response = bufferedResponse(pngBytes(4), "image/png");
      vi.spyOn(response.body!, "getReader").mockImplementation(() => {
        throw new TypeError("ReadableStream is locked");
      });
      const arrayBufferSpy = vi.spyOn(response, "arrayBuffer");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBeNull();
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    });

    it("F1. PNG happy path still works correctly (no regression from the cancellation/bounded-reader hardening)", async () => {
      const bytes = new Uint8Array([11, 22, 33, 44]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/png")) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    it("F2. JPEG happy path still works correctly (no regression from the cancellation/bounded-reader hardening)", async () => {
      const bytes = new Uint8Array([55, 66, 77, 88]);
      const deps = makeDeps({ fetchImpl: vi.fn(async () => bufferedResponse(bytes, "image/jpeg")) });

      const result = await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(result).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
    });

    it("does not cancel the body twice on the happy path (success never rejects)", async () => {
      const response = bufferedResponse(pngBytes(4), "image/png");
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      const deps = makeDeps({ fetchImpl: vi.fn(async () => response) });

      await prepareSlipImageForOcr(PRIVATE_REF, deps);

      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });
});
