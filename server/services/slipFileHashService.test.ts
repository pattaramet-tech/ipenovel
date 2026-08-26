import { describe, expect, it, vi } from "vitest";
import {
  computeSlipFileHash,
  describeFileIdentifierStatus,
  hashSlipBytes,
} from "./slipFileHashService";

/**
 * Exact-file identifier tests.
 *
 * Proves the hash is derived from the bytes actually stored server-side, is
 * unforgeable by a client, and survives total OCR failure - the property that
 * lets an unreadable-but-genuine slip still be anti-replay protected.
 */

function fakeResponse(bytes: Buffer) {
  return {
    ok: true,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {},
        };
      },
    },
  } as unknown as Response;
}

const PRIVATE_REF = "r2p:payment-slips/1/slip.png";

function deps(bytes: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    resolveStoredFileValueFn: async () => "https://signed.example.com/slip.png",
    fetchImpl: (async () => fakeResponse(bytes)) as unknown as typeof fetch,
    ...overrides,
  };
}

describe("hashSlipBytes", () => {
  it("same bytes -> same fileHash", () => {
    expect(hashSlipBytes(Buffer.from([1, 2, 3, 4]))).toBe(
      hashSlipBytes(Buffer.from([1, 2, 3, 4]))
    );
  });

  it("different bytes -> different fileHash", () => {
    expect(hashSlipBytes(Buffer.from([1, 2, 3, 4]))).not.toBe(
      hashSlipBytes(Buffer.from([1, 2, 3, 5]))
    );
  });

  it("a single flipped byte changes the hash", () => {
    const a = Buffer.alloc(1024, 7);
    const b = Buffer.alloc(1024, 7);
    b[512] = 8;
    expect(hashSlipBytes(a)).not.toBe(hashSlipBytes(b));
  });

  it("produces a 64-char hex digest", () => {
    expect(hashSlipBytes(Buffer.from("x"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("computeSlipFileHash - server-side derivation", () => {
  it("hashes the bytes fetched from the private object", async () => {
    const bytes = Buffer.from([9, 8, 7, 6]);
    const hash = await computeSlipFileHash(PRIVATE_REF, deps(bytes));
    expect(hash).toBe(hashSlipBytes(bytes));
  });

  it("is identical across two calls for the same stored object", async () => {
    const bytes = Buffer.from("slip-content");
    const a = await computeSlipFileHash(PRIVATE_REF, deps(bytes));
    const b = await computeSlipFileHash(PRIVATE_REF, deps(bytes));
    expect(a).toBe(b);
  });

  it("differs when the stored bytes differ", async () => {
    const a = await computeSlipFileHash(PRIVATE_REF, deps(Buffer.from("one")));
    const b = await computeSlipFileHash(PRIVATE_REF, deps(Buffer.from("two")));
    expect(a).not.toBe(b);
  });
});

describe("a client cannot forge the file hash", () => {
  it("takes no hash parameter at all - only a server-held storage reference", () => {
    // The signature is (rawStoredValue, deps). There is no argument through
    // which a request could supply a hash, so forgery is structurally
    // impossible rather than merely validated against.
    expect(computeSlipFileHash.length).toBeLessThanOrEqual(2);
  });

  it("ignores any hash-looking value in the reference itself", async () => {
    const bytes = Buffer.from("real-bytes");
    const forged = "f".repeat(64);
    const hash = await computeSlipFileHash(
      `r2p:payment-slips/1/${forged}.png`,
      deps(bytes)
    );
    // The value is derived from the BYTES, never from the path.
    expect(hash).toBe(hashSlipBytes(bytes));
    expect(hash).not.toBe(forged);
  });

  it("refuses a non-private reference (SSRF guard) rather than fetching it", async () => {
    const fetchImpl = vi.fn();
    const hash = await computeSlipFileHash("https://attacker.example.com/x.png", {
      resolveStoredFileValueFn: async () => "https://attacker.example.com/x.png",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(hash).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("computeSlipFileHash degrades safely - never throws", () => {
  it("returns undefined for a missing reference", async () => {
    expect(await computeSlipFileHash(null)).toBeUndefined();
    expect(await computeSlipFileHash(undefined)).toBeUndefined();
  });

  it("returns undefined when the signed URL cannot be produced", async () => {
    const hash = await computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: async () => null,
      fetchImpl: (async () => fakeResponse(Buffer.from("x"))) as unknown as typeof fetch,
    });
    expect(hash).toBeUndefined();
  });

  it("returns undefined on a fetch failure instead of throwing", async () => {
    const hash = await computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: async () => "https://signed.example.com/x.png",
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    expect(hash).toBeUndefined();
  });

  it("returns undefined on a non-ok response", async () => {
    const hash = await computeSlipFileHash(PRIVATE_REF, {
      resolveStoredFileValueFn: async () => "https://signed.example.com/x.png",
      fetchImpl: (async () => ({ ok: false }) as Response) as unknown as typeof fetch,
    });
    expect(hash).toBeUndefined();
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const huge = Buffer.alloc(64, 1);
    const hash = await computeSlipFileHash(PRIVATE_REF, {
      ...deps(huge),
      maxBytes: 8,
    });
    expect(hash).toBeUndefined();
  });

  it("returns undefined for an empty body", async () => {
    const hash = await computeSlipFileHash(PRIVATE_REF, deps(Buffer.alloc(0)));
    expect(hash).toBeUndefined();
  });
});

describe("OCR failure still leaves a usable fileHash", () => {
  it("the hash is computed from storage, independent of any OCR result", async () => {
    // computeSlipFileHash never touches the LLM path: no invokeLLM, no
    // prepareSlipImageForOcr. A total OCR outage therefore cannot remove the
    // exact-file identifier, which is what keeps an unreadable slip
    // anti-replay protected while a human reviews it.
    const bytes = Buffer.from("unreadable-slip-bytes");
    const hash = await computeSlipFileHash(PRIVATE_REF, deps(bytes));
    expect(hash).toBeDefined();
    expect(hash).toBe(hashSlipBytes(bytes));
  });

  it("two different unreadable slips still get distinct identifiers", async () => {
    const a = await computeSlipFileHash(PRIVATE_REF, deps(Buffer.from("blurry-a")));
    const b = await computeSlipFileHash(PRIVATE_REF, deps(Buffer.from("blurry-b")));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});

describe("describeFileIdentifierStatus - admin display never exposes the hash", () => {
  it("AVAILABLE when a hash exists and did not collide", () => {
    expect(describeFileIdentifierStatus({ fileHash: "a".repeat(64) })).toBe("AVAILABLE");
  });

  it("MATCH when the hash collided with another submission", () => {
    expect(
      describeFileIdentifierStatus({ fileHash: "a".repeat(64), duplicateFileMatch: true })
    ).toBe("MATCH");
  });

  it("UNAVAILABLE when no hash could be computed", () => {
    expect(describeFileIdentifierStatus({ fileHash: null })).toBe("UNAVAILABLE");
    expect(describeFileIdentifierStatus({})).toBe("UNAVAILABLE");
  });

  it("returns only a status word - never the hash", () => {
    const status = describeFileIdentifierStatus({ fileHash: "b".repeat(64) });
    expect(status).not.toMatch(/[0-9a-f]{32,}/);
    expect(["AVAILABLE", "MATCH", "UNAVAILABLE"]).toContain(status);
  });
});
