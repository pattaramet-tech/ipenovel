import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSlipFileHash,
  computeTrustedLegacySlipFileHash,
  hashSlipBytes,
  SLIP_HASH_FETCH_TIMEOUT_MS,
  type ComputeSlipFileHashDeps,
} from "./slipFileHashService";

const PRIVATE_REF = "r2p:payment-slips/1/deadline-test.png";
const SIGNED_URL = "https://signed.example.com/deadline-test.png";
const LEGACY_URL = "https://d2xsxph8kpxj0f.cloudfront.net/slips/deadline-test.png";
const TIMEOUT_MS = 25;

const paths = [
  {
    name: "private R2",
    compute: (deps: ComputeSlipFileHashDeps) => computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: async () => SIGNED_URL,
      ...deps,
    }),
  },
  {
    name: "trusted legacy CDN",
    compute: (deps: ComputeSlipFileHashDeps) => computeTrustedLegacySlipFileHash(LEGACY_URL, deps),
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(paths)("$name file-read cancellation", ({ compute }) => {
  it("cancels a body stalled after headers, even when fetch ignores the signal", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const fetchImpl = vi.fn(async () => response);
    const result = compute({ fetchImpl, timeoutMs: TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never hashes a partial body when abort turns its pending read into done", async () => {
    const partialBytes = new Uint8Array([1, 2, 3]);
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(partialBytes); },
      cancel,
    }));
    const result = compute({ fetchImpl: async () => response, timeoutMs: TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const hash = await result;
    expect(hash).toBeUndefined();
    expect(hash).not.toBe(hashSlipBytes(partialBytes));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait forever for the underlying source's cancel promise", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = compute({ fetchImpl: async () => response, timeoutMs: TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a rejected cancel promise without an unhandled rejection", async () => {
    const cancel = vi.fn(async () => { throw new Error("source cancellation failed"); });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const result = compute({ fetchImpl: async () => response, timeoutMs: TIMEOUT_MS });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an unread non-OK response without awaiting its stalled cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 });

    await expect(compute({ fetchImpl: async () => response })).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an oversized stream without accepting bytes or waiting for cleanup", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel,
    }));

    await expect(compute({ fetchImpl: async () => response, maxBytes: 8 })).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the existing default timeout for a stalled body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    let settled = false;
    const result = compute({ fetchImpl: async () => response }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(SLIP_HASH_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the canonical hash and releases the reader and timer after success", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const response = new Response(bytes);

    await expect(compute({ fetchImpl: async () => response })).resolves.toBe(hashSlipBytes(bytes));
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("private signing shares the per-file deadline", () => {
  it("refuses elapsed signing even before the timeout callback gets an event-loop turn", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const fetchImpl = vi.fn();
    const result = computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: async () => {
        now.mockReturnValue(TIMEOUT_MS);
        return SIGNED_URL;
      },
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
    });

    await expect(result).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits a noncooperative signer but refuses its late URL without fetching", async () => {
    let resolveSigning!: (url: string) => void;
    const signing = new Promise<string>((resolve) => { resolveSigning = resolve; });
    const fetchImpl = vi.fn();
    let settled = false;
    const result = computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: () => signing,
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
    }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(settled).toBe(false); // No race leaves asynchronous transaction work behind.
    expect(fetchImpl).not.toHaveBeenCalled();
    resolveSigning(SIGNED_URL);

    await expect(result).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reset the deadline when signing finishes before a stalled fetch body", async () => {
    let resolveSigning!: (url: string) => void;
    const signing = new Promise<string>((resolve) => { resolveSigning = resolve; });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const fetchImpl = vi.fn(async () => response);
    const result = computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: () => signing,
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    resolveSigning(SIGNED_URL);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
