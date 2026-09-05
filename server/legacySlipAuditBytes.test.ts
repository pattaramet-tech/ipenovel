import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  inspectLegacySlipBytes,
  LEGACY_SLIP_AUDIT_MAX_BYTES,
  LegacySlipAuditBytesError,
} from "./helpers/legacySlipAuditBytes";
import { hashSlipBytes } from "./services/slipFileHashService";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7\nheader-only-fixture");

describe("legacy slip audit byte inspection", () => {
  it.each([
    { name: "JPEG", bytes: JPEG, mimeType: "image/jpeg" },
    { name: "PNG", bytes: PNG, mimeType: "image/png" },
    { name: "PDF", bytes: PDF, mimeType: "application/pdf" },
  ])(
    "recognizes $name signatures and hashes the same complete bytes in both namespaces",
    async ({ bytes, mimeType }) => {
      const controller = new AbortController();
      const result = await inspectLegacySlipBytes(
        Readable.from([
          bytes.subarray(0, 2),
          bytes.subarray(2, 5),
          bytes.subarray(5),
        ]),
        { signal: controller.signal }
      );

      expect(result).toEqual({
        rawHash: createHash("sha256").update(bytes).digest("hex"),
        canonicalHash: hashSlipBytes(bytes),
        byteLength: bytes.length,
        mimeType,
      });
      expect(result.rawHash).not.toBe(result.canonicalHash);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  );

  it("is explicitly signature-only, not an image/PDF decoder", async () => {
    const result = await inspectLegacySlipBytes(
      Readable.from([Buffer.from("%PDF-")]),
      {
        signal: new AbortController().signal,
      }
    );
    expect(result.mimeType).toBe("application/pdf");
    expect(result.byteLength).toBe(5);
  });

  it("ignores declared MIME, declared length, and unbounded SDK transform helpers", async () => {
    const body = Object.assign(Readable.from([PNG]), {
      ContentType: "application/pdf",
      ContentLength: 1,
      transformToByteArray: vi.fn(() => {
        throw new Error("must never be invoked");
      }),
    });
    const result = await inspectLegacySlipBytes(body, {
      signal: new AbortController().signal,
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.byteLength).toBe(PNG.length);
    expect(body.transformToByteArray).not.toHaveBeenCalled();
  });

  it("aborts a stalled native Node Readable and destroys the stream", async () => {
    const body = new Readable({ read() {} });
    const controller = new AbortController();
    const result = inspectLegacySlipBytes(body, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(result).rejects.toMatchObject({
      code: "ABORTED",
      message: "LEGACY_SLIP_AUDIT_ABORTED",
    });
    expect(body.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("never returns partial hashes when an AsyncIterable next and return both stall", async () => {
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>(resolve => {
      notifyWaiting = resolve;
    });
    let readCount = 0;
    const body = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: vi.fn(() => {
        if (++readCount === 1)
          return Promise.resolve({ done: false, value: PNG });
        notifyWaiting();
        return new Promise<IteratorResult<Buffer>>(() => {});
      }),
      return: vi.fn(() => new Promise<IteratorResult<Buffer>>(() => {})),
      destroy: vi.fn(),
    };
    const controller = new AbortController();
    const result = inspectLegacySlipBytes(body, { signal: controller.signal });
    await waiting;
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "ABORTED" });
    expect(body.next).toHaveBeenCalledTimes(2);
    expect(body.return).toHaveBeenCalledTimes(1);
    expect(body.destroy).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("observes delayed next rejection and rejected cleanup after abort without leaking source errors", async () => {
    let rejectRead!: (error: Error) => void;
    const body = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () =>
        new Promise<IteratorResult<Buffer>>((_resolve, reject) => {
          rejectRead = reject;
        }),
      return: vi.fn(async () => {
        throw new Error("private SDK cleanup detail");
      }),
      destroy: vi.fn(),
    };
    const controller = new AbortController();
    const result = inspectLegacySlipBytes(body, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "ABORTED" });
    rejectRead(new Error("private SDK read detail"));
    await Promise.resolve();
    expect(body.return).toHaveBeenCalledTimes(1);
  });

  it("destroys pre-aborted bodies without beginning a read", async () => {
    const body = new Readable({ read() {} });
    const iterate = vi.spyOn(body, Symbol.asyncIterator);
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectLegacySlipBytes(body, { signal: controller.signal })
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(iterate).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("stops on actual streamed oversize regardless of declared length", async () => {
    const body = Object.assign(Readable.from([PNG]), { ContentLength: 1 });
    await expect(
      inspectLegacySlipBytes(body, {
        signal: new AbortController().signal,
        maxBytes: PNG.length - 1,
      })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(body.destroyed).toBe(true);
  });

  it("enforces the default 5 MiB cap on actual bytes", async () => {
    const body = Readable.from([
      PNG,
      Buffer.alloc(LEGACY_SLIP_AUDIT_MAX_BYTES),
    ]);
    await expect(
      inspectLegacySlipBytes(body, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(body.destroyed).toBe(true);
  });

  it.each([0, -1, 1.5, Infinity, LEGACY_SLIP_AUDIT_MAX_BYTES + 1])(
    "refuses invalid or over-cap limits (%s)",
    async maxBytes => {
      await expect(
        inspectLegacySlipBytes(Readable.from([PNG]), {
          signal: new AbortController().signal,
          maxBytes,
        })
      ).rejects.toMatchObject({ code: "INVALID_LIMIT" });
    }
  );

  it.each([null, undefined])("rejects missing bodies (%s)", async body => {
    await expect(
      inspectLegacySlipBytes(body, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "BODY_MISSING" });
  });

  it("rejects a transform-only body instead of using an unbounded fallback", async () => {
    const body = { transformToByteArray: vi.fn(async () => PNG) };
    await expect(
      inspectLegacySlipBytes(body, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "BODY_UNSUPPORTED" });
    expect(body.transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects empty bodies", async () => {
    await expect(
      inspectLegacySlipBytes(Readable.from([]), {
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "EMPTY_BODY" });
  });

  it("refuses string chunks that may have been re-encoded", async () => {
    const body = Readable.from(["%PDF-1.7"]);
    await expect(
      inspectLegacySlipBytes(body, { signal: new AbortController().signal })
    ).rejects.toMatchObject({ code: "CHUNK_UNSUPPORTED" });
    expect(body.destroyed).toBe(true);
  });

  it.each([
    Buffer.from("not an image"),
    PNG.subarray(0, 4),
    Buffer.from("%PDFx"),
  ])("rejects unsupported or truncated signatures", async bytes => {
    await expect(
      inspectLegacySlipBytes(Readable.from([bytes]), {
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SIGNATURE" });
  });

  it("maps source failures to fixed safe errors", async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error("private endpoint/credential detail"));
      },
    });
    const error = await inspectLegacySlipBytes(body, {
      signal: new AbortController().signal,
    }).catch(value => value);
    expect(error).toBeInstanceOf(LegacySlipAuditBytesError);
    expect(error.code).toBe("READ_FAILED");
    expect(error.message).toBe("LEGACY_SLIP_AUDIT_READ_FAILED");
    expect(error.cause).toBeUndefined();
  });

  it("allows the caller's timer to abort an endless microtask-only empty iterable", async () => {
    const body = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => ({ done: false, value: new Uint8Array(0) }),
      return: vi.fn(async () => ({ done: true, value: undefined })),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(
        inspectLegacySlipBytes(body, { signal: controller.signal })
      ).rejects.toMatchObject({ code: "ABORTED" });
      expect(body.return).toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      clearTimeout(timer);
    }
  });

  it("sanitizes iterator construction failures too", async () => {
    const body = {
      get [Symbol.asyncIterator]() {
        throw new Error("private source detail");
      },
      destroy: vi.fn(),
    };
    await expect(
      inspectLegacySlipBytes(body, { signal: new AbortController().signal })
    ).rejects.toMatchObject({
      code: "READ_FAILED",
      message: "LEGACY_SLIP_AUDIT_READ_FAILED",
    });
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });
});
