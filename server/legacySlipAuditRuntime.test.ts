import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  AuditReadError,
  auditPreviewLegacySlips,
  classifyCandidateListing,
  createObjectReaders,
  createSourceReader,
  type AuditReaders,
  type AuditTarget,
  type ListedCandidate,
} from "../scripts/lib/legacySlipAuditRuntime";
import { PREVIEW_AUDIT_TARGETS } from "../scripts/lib/legacySlipAuditOptions";
import { LEGACY_SLIP_AUDIT_MAX_BYTES } from "./helpers/legacySlipAuditBytes";
import type { AuditSource } from "./helpers/legacySlipReconciliationPlan";

const ORDER = PREVIEW_AUDIT_TARGETS.find(
  t => t.sourceType === "order_payment"
)!;
const WALLET = PREVIEW_AUDIT_TARGETS.find(
  t => t.sourceType === "wallet_topup"
)!;
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const RAW = createHash("sha256").update(PNG).digest("hex");
const HASH = createHash("sha256")
  .update(PNG)
  .update("slip:file:v1")
  .digest("hex");
const ETAG = '"version-1"';
const config = {
  host: "db-preview.invalid",
  user: "readonly",
  password: "not-logged",
  database: "preview",
} as any;
const bytes = {
  rawHash: RAW,
  canonicalHash: HASH,
  byteLength: PNG.length,
  mimeType: "image/png" as const,
};
const prefix = (target = ORDER) =>
  `payment-slips/legacy/${target.sourceType === "order_payment" ? "payments" : "wallet-topups"}/${target.sourceId}/`;
const candidate = (target = ORDER): ListedCandidate => ({
  key: `${prefix(target)}123-abc.png`,
  size: PNG.length,
  etag: ETAG,
});
const listedObject = (target = ORDER) => ({
  Key: candidate(target).key,
  Size: PNG.length,
  ETag: ETAG,
});
const source = (
  target: AuditTarget = ORDER,
  overrides: Partial<AuditSource> = {}
): AuditSource => ({
  ...target,
  ownerUserId: 91,
  status: "approved",
  slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/secret-slip.png",
  slipEvidenceClass: "legacy_compatibility_required",
  evidenceVersion: 1,
  slipEvidenceId: null,
  extractedEvidenceVersion: 1,
  extractedData: JSON.stringify({ fileHash: HASH }),
  bindings: [],
  claims: [],
  relatedReadTruncated: false,
  ...overrides,
});

function fakeConnection(
  target: AuditTarget,
  options: {
    row?: Record<string, unknown> | null;
    bindings?: unknown[];
    claims?: unknown[];
    queryError?: unknown;
    destroyError?: unknown;
  } = {}
) {
  const {
    sourceType: _sourceType,
    sourceId: _sourceId,
    bindings: _bindings,
    claims: _claims,
    relatedReadTruncated: _truncated,
    ...fields
  } = source(target);
  const row =
    options.row === undefined
      ? { id: String(target.sourceId), ...fields }
      : options.row;
  const query = vi.fn(async (request: any) => {
    if (options.queryError) throw options.queryError;
    const rows = /FROM slipEvidenceBindings/.test(request.sql)
      ? (options.bindings ?? [])
      : /FROM paymentSlipClaims/.test(request.sql)
        ? (options.claims ?? [])
        : row
          ? [row]
          : [];
    return [rows, []];
  });
  const destroy = vi.fn(() => {
    if (options.destroyError) throw options.destroyError;
  });
  return { query, destroy };
}

function fakeS3(response: unknown | ((command: any, options: any) => unknown)) {
  const send = vi.fn(async (command: any, options: any) =>
    typeof response === "function" ? response(command, options) : response
  );
  return {
    send,
    readers: createObjectReaders({ send } as any, "preview-only-bucket"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("read-only audit source adapter", () => {
  it.each(["order_payment", "wallet_topup"] as const)(
    "uses parameterized bounded SELECTs and destroys the %s connection",
    async type => {
      const target = type === "order_payment" ? ORDER : WALLET;
      const connection = fakeConnection(target, {
        claims: [{ id: "7", userId: "91", fileHash: HASH }],
      });
      const connect = vi.fn(async () => connection as any);
      const result = await createSourceReader(config, connect)(target);
      expect(result).toMatchObject({
        ...target,
        ownerUserId: 91,
        claims: [{ id: 7, userId: 91, fileHash: HASH }],
      });
      expect(connect).toHaveBeenCalledWith(config);
      expect(connection.destroy).toHaveBeenCalledTimes(1);
      const queries = connection.query.mock.calls.map(call => call[0]);
      expect(queries).toHaveLength(3);
      expect(
        queries.every(
          q => /^SELECT\b/.test(q.sql.trim()) && q.timeout === 5_000
        )
      ).toBe(true);
      expect(queries[0].values).toEqual([target.sourceId]);
      expect(queries[0].sql).toMatch(/WHERE (?:p\.)?id = \? LIMIT 1/);
      if (type === "order_payment")
        expect(queries[0].sql).toMatch(
          /o\.userId AS ownerUserId[\s\S]*LEFT JOIN orders o ON o\.id = p\.orderId/
        );
      else
        expect(queries[0].sql).toMatch(
          /userId AS ownerUserId[\s\S]*FROM walletTopups/
        );
      for (const q of queries.slice(1)) {
        expect(q.values).toEqual([target.sourceType, target.sourceId]);
        expect(q.sql).toMatch(/ORDER BY id LIMIT 21$/);
      }
    }
  );

  it("marks 21 related rows as truncated rather than silently treating a partial list as complete", async () => {
    const connection = fakeConnection(ORDER, {
      bindings: Array.from({ length: 21 }, (_, i) => ({ id: i + 1 })),
    });
    const report = await createSourceReader(
      config,
      async () => connection as any
    )(ORDER);
    expect(report?.relatedReadTruncated).toBe(true);
    expect(report?.bindings).toHaveLength(21);
  });

  it.each([10020002, 82350007, -1])(
    "rejects out-of-scope source %i before opening a connection",
    async sourceId => {
      const connect = vi.fn();
      await expect(
        createSourceReader(
          config,
          connect
        )({ sourceType: "order_payment", sourceId })
      ).rejects.toMatchObject({ code: "SOURCE_READ_FAILED" });
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it("returns missing rows without related queries and always cleans up", async () => {
    const connection = fakeConnection(ORDER, { row: null });
    await expect(
      createSourceReader(config, async () => connection as any)(ORDER)
    ).resolves.toBeNull();
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["query", "destroy"])(
    "sanitizes %s failure without leaking database errors",
    async stage => {
      const secret = new Error("mysql://password@host SELECT private-fields");
      const connection = fakeConnection(
        ORDER,
        stage === "query" ? { queryError: secret } : { destroyError: secret }
      );
      const error = await createSourceReader(
        config,
        async () => connection as any
      )(ORDER).catch(e => e);
      expect(error).toBeInstanceOf(AuditReadError);
      expect(error).toMatchObject({
        code: "SOURCE_READ_FAILED",
        message: "LEGACY_SLIP_AUDIT_READ_FAILED",
      });
      expect(connection.destroy).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["id", "01"],
    ["id", 0],
    ["id", Number.MAX_SAFE_INTEGER + 1],
    ["evidenceVersion", "2e0"],
    ["slipEvidenceId", "-1"],
    ["extractedEvidenceVersion", "1.5"],
  ])("rejects malformed non-null %s numeric value %#", async (field, value) => {
    const row = { id: ORDER.sourceId, ...source(ORDER), [field]: value };
    const connection = fakeConnection(ORDER, { row });
    await expect(
      createSourceReader(config, async () => connection as any)(ORDER)
    ).rejects.toMatchObject({ code: "SOURCE_READ_FAILED" });
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});

describe("bounded candidate listing classification", () => {
  it("recognizes one exact-prefix candidate and ignores only its zero-byte directory marker", () => {
    const result = classifyCandidateListing(ORDER, {
      $metadata: {},
      IsTruncated: false,
      Contents: [{ Key: prefix(), Size: 0 }, listedObject()],
    });
    expect(result).toEqual({
      listing: {
        candidateCount: 1,
        unexpectedObjectCount: 0,
        truncated: false,
      },
      candidate: candidate(),
    });
  });

  it.each([
    { IsTruncated: true, Contents: [listedObject()] },
    {
      IsTruncated: false,
      Contents: [
        listedObject(),
        { ...listedObject(), Key: `${prefix()}456-def.jpg` },
      ],
    },
    {
      IsTruncated: false,
      Contents: [
        {
          ...listedObject(),
          Key: "payment-slips/legacy/payments/99999999/123-abc.png",
        },
      ],
    },
    {
      IsTruncated: false,
      Contents: [listedObject(), { Key: `${prefix()}sidecar.json`, Size: 12 }],
    },
    { IsTruncated: false, Contents: [{ ...listedObject(), Size: 0 }] },
    {
      IsTruncated: false,
      Contents: Array.from({ length: 21 }, () => ({ Key: prefix(), Size: 0 })),
    },
  ])(
    "returns no downloadable candidate for ambiguous/incomplete/unexpected listing %#",
    result => {
      expect(
        classifyCandidateListing(ORDER, { $metadata: {}, ...result }).candidate
      ).toBeUndefined();
    }
  );

  it.each([
    null,
    {},
    { IsTruncated: "false" },
    { IsTruncated: false, Contents: {} },
    { IsTruncated: false, Contents: 0 },
    { IsTruncated: false, Contents: false },
    { IsTruncated: false, Contents: "" },
    { IsTruncated: false, Contents: null },
    { IsTruncated: false, Contents: [null] },
  ])("rejects malformed listing shape with fixed code %#", result => {
    expect(() => classifyCandidateListing(ORDER, result as any)).toThrow(
      AuditReadError
    );
    try {
      classifyCandidateListing(ORDER, result as any);
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_OBJECT_LISTING" });
    }
  });

  it("retains advertised size so the reader can reject oversize without any GET", () => {
    const size = LEGACY_SLIP_AUDIT_MAX_BYTES + 1;
    const result = classifyCandidateListing(ORDER, {
      $metadata: {},
      IsTruncated: false,
      Contents: [{ ...listedObject(), Size: size }],
    });
    expect(result.candidate?.size).toBe(size);
  });
});

describe("conditional bounded object readers", () => {
  it("lists only the allowlisted prefix with MaxKeys 20 and an abort signal", async () => {
    const s3 = fakeS3({ IsTruncated: false, Contents: [listedObject()] });
    await expect(s3.readers.listCandidate(ORDER)).resolves.toMatchObject({
      candidate: candidate(),
    });
    const [command, options] = s3.send.mock.calls[0];
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    expect(command.input).toEqual({
      Bucket: "preview-only-bucket",
      Prefix: prefix(),
      MaxKeys: 20,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses IfMatch and actual byte signature/hash rather than declared MIME or ETag as a hash", async () => {
    const s3 = fakeS3({
      ETag: ETAG,
      ContentLength: PNG.length,
      ContentType: "application/pdf",
      Body: Readable.from([PNG]),
    });
    await expect(s3.readers.readCandidate(candidate())).resolves.toEqual(bytes);
    expect(s3.send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(s3.send.mock.calls[0][0].input).toEqual({
      Bucket: "preview-only-bucket",
      Key: candidate().key,
      IfMatch: ETAG,
    });
  });

  it.each([undefined, "unquoted", '"first","second"', '"bad\\etag"'])(
    "refuses unavailable/invalid object version %# before GET",
    async etag => {
      const s3 = fakeS3({});
      await expect(
        s3.readers.readCandidate({ ...candidate(), etag })
      ).rejects.toMatchObject({ code: "OBJECT_VERSION_UNAVAILABLE" });
      expect(s3.send).not.toHaveBeenCalled();
    }
  );

  it.each(["etag", "size", "412", "actual-size"])(
    "blocks a changed %s object version and destroys any returned body",
    async change => {
      const body = Readable.from([
        change === "actual-size" ? Buffer.concat([PNG, Buffer.from([4])]) : PNG,
      ]);
      const s3 = fakeS3(() => {
        if (change === "412")
          throw {
            $metadata: { httpStatusCode: 412 },
            message: "secret object URL",
          };
        return {
          ETag: change === "etag" ? '"version-2"' : ETAG,
          ContentLength: change === "size" ? PNG.length + 1 : PNG.length,
          Body: body,
        };
      });
      await expect(s3.readers.readCandidate(candidate())).rejects.toMatchObject(
        { code: "OBJECT_VERSION_CHANGED" }
      );
      if (change !== "412") expect(body.destroyed).toBe(true);
    }
  );

  it("rejects oversized metadata before GET and actual oversized bytes despite small metadata", async () => {
    const noGet = fakeS3({});
    await expect(
      noGet.readers.readCandidate({
        ...candidate(),
        size: LEGACY_SLIP_AUDIT_MAX_BYTES + 1,
      })
    ).rejects.toMatchObject({ code: "OBJECT_TOO_LARGE" });
    expect(noGet.send).not.toHaveBeenCalled();
    const body = Readable.from([
      PNG,
      Buffer.alloc(LEGACY_SLIP_AUDIT_MAX_BYTES),
    ]);
    const s3 = fakeS3({ ETag: ETAG, ContentLength: PNG.length, Body: body });
    await expect(s3.readers.readCandidate(candidate())).rejects.toMatchObject({
      code: "OBJECT_TOO_LARGE",
    });
    expect(body.destroyed).toBe(true);
  });

  it("rejects unsupported actual bytes even when ContentType claims image/png", async () => {
    const body = Buffer.from("<html>not a slip</html>");
    const s3 = fakeS3({
      ETag: ETAG,
      ContentLength: body.length,
      ContentType: "image/png",
      Body: Readable.from([body]),
    });
    await expect(
      s3.readers.readCandidate({ ...candidate(), size: body.length })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
  });

  it.each(["list", "get"])(
    "times out a stalled SDK %s even if it ignores AbortSignal",
    async operation => {
      vi.useFakeTimers();
      const pending = deferred<any>();
      const s3 = fakeS3(() => pending.promise);
      const outcome = (
        operation === "list"
          ? s3.readers.listCandidate(ORDER)
          : s3.readers.readCandidate(candidate())
      ).catch(e => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toMatchObject({ code: "OBJECT_READ_TIMEOUT" });
      expect(vi.getTimerCount()).toBe(0);
      const lateBody = Readable.from([PNG]);
      pending.resolve({
        ETag: ETAG,
        ContentLength: PNG.length,
        Body: lateBody,
      });
      await vi.advanceTimersByTimeAsync(0);
      if (operation === "get") expect(lateBody.destroyed).toBe(true);
    }
  );

  it("times out and destroys a stalled response body after headers have succeeded", async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const s3 = fakeS3({ ETag: ETAG, ContentLength: PNG.length, Body: body });
    const outcome = s3.readers.readCandidate(candidate()).catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toMatchObject({ code: "OBJECT_READ_TIMEOUT" });
    expect(body.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fixed-target sequential Preview dry-run orchestration", () => {
  function readers(overrides: Partial<AuditReaders> = {}): AuditReaders {
    return {
      readSource: vi.fn(async target => source(target)),
      listCandidate: vi.fn(async target => ({
        listing: {
          candidateCount: 1,
          unexpectedObjectCount: 0,
          truncated: false,
        },
        candidate: candidate(target),
      })),
      readCandidate: vi.fn(async () => bytes),
      ...overrides,
    };
  }

  it("audits exactly the ten approved-history targets and never the control or pending payment", async () => {
    const io = readers();
    const emit = vi.fn();
    const results = await auditPreviewLegacySlips(io, emit);
    expect(PREVIEW_AUDIT_TARGETS).toEqual([
      { sourceType: "order_payment", sourceId: 11280001 },
      { sourceType: "order_payment", sourceId: 11310001 },
      { sourceType: "order_payment", sourceId: 11340002 },
      { sourceType: "order_payment", sourceId: 11340004 },
      { sourceType: "order_payment", sourceId: 11370001 },
      { sourceType: "wallet_topup", sourceId: 180001 },
      { sourceType: "wallet_topup", sourceId: 210001 },
      { sourceType: "wallet_topup", sourceId: 240001 },
      { sourceType: "wallet_topup", sourceId: 270001 },
      { sourceType: "wallet_topup", sourceId: 300001 },
    ]);
    expect(
      new Set(PREVIEW_AUDIT_TARGETS.map(t => `${t.sourceType}:${t.sourceId}`))
        .size
    ).toBe(10);
    expect(
      PREVIEW_AUDIT_TARGETS.some(t => [10020002, 82350007].includes(t.sourceId))
    ).toBe(false);
    expect(
      results.map(r => ({ sourceType: r.sourceType, sourceId: r.sourceId }))
    ).toEqual(PREVIEW_AUDIT_TARGETS);
    expect(io.readSource).toHaveBeenCalledTimes(20);
    expect(io.listCandidate).toHaveBeenCalledTimes(10);
    expect(io.readCandidate).toHaveBeenCalledTimes(10);
    expect(emit).toHaveBeenCalledTimes(10);
    expect(
      results.every(
        r =>
          r.action === "REVIEW_REFERENCE_REPAIR" &&
          r.writeAuthorized === false &&
          r.pointInTimeOnly
      )
    ).toBe(true);
  });

  it("uses fresh destroyed connections before object I/O and for the after snapshot", async () => {
    const connections: ReturnType<typeof fakeConnection>[] = [];
    const connect = vi.fn(async () => {
      const c = fakeConnection(ORDER);
      connections.push(c);
      return c as any;
    });
    const read = createSourceReader(config, connect);
    let orderReads = 0;
    const io = readers({
      readSource: async target =>
        target === ORDER ? (orderReads++, read(target)) : null,
      listCandidate: vi.fn(async target => {
        expect(connections).toHaveLength(1);
        expect(connections[0].destroy).toHaveBeenCalledOnce();
        return {
          listing: {
            candidateCount: 1,
            unexpectedObjectCount: 0,
            truncated: false,
          },
          candidate: candidate(target),
        };
      }),
    });
    await auditPreviewLegacySlips(io, () => {});
    expect(orderReads).toBe(2);
    expect(connections).toHaveLength(2);
    expect(connections.every(c => c.destroy.mock.calls.length === 1)).toBe(
      true
    );
  });

  it.each([
    { slipImageUrl: "r2p:already-private" },
    { slipEvidenceClass: "modern_immutable" },
    { status: "pending_review" },
    { slipEvidenceId: 3 },
    { bindings: [{ id: 3 }] },
    { relatedReadTruncated: true },
    { slipImageUrl: null },
    { slipImageUrl: "https://untrusted.example/slip.png" },
  ])(
    "does no object listing or download for a skipped/blocked source %#",
    async change => {
      const io = readers({
        readSource: vi.fn(async target => source(target, change)),
      });
      const results = await auditPreviewLegacySlips(io, () => {});
      expect(io.listCandidate).not.toHaveBeenCalled();
      expect(io.readCandidate).not.toHaveBeenCalled();
      expect(results.every(r => r.action === "NONE")).toBe(true);
    }
  );

  it("uses a fresh after snapshot to catch changes during object inspection", async () => {
    const counts = new Map<number, number>();
    const io = readers({
      readSource: vi.fn(async target => {
        const count = (counts.get(target.sourceId) ?? 0) + 1;
        counts.set(target.sourceId, count);
        return source(target, count === 1 ? {} : { evidenceVersion: 2 });
      }),
    });
    const results = await auditPreviewLegacySlips(io, () => {});
    expect(
      results.every(
        r => r.blockers.includes("SOURCE_CHANGED") && r.action === "NONE"
      )
    ).toBe(true);
  });

  it("rereads after object failure and emits only fixed diagnostic codes", async () => {
    const secret = "https://private-object.invalid/secret-key?password=secret";
    const io = readers({
      listCandidate: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const results = await auditPreviewLegacySlips(io, () => {});
    expect(io.readSource).toHaveBeenCalledTimes(20);
    expect(io.readCandidate).not.toHaveBeenCalled();
    expect(
      results.every(
        r => r.blockers.includes("OPERATION_FAILED") && r.action === "NONE"
      )
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain(secret);
  });

  it("does not download ambiguous candidates and still rereads each source", async () => {
    const io = readers({
      listCandidate: vi.fn(async () => ({
        listing: {
          candidateCount: 2,
          unexpectedObjectCount: 0,
          truncated: false,
        },
      })),
    });
    const results = await auditPreviewLegacySlips(io, () => {});
    expect(io.readCandidate).not.toHaveBeenCalled();
    expect(io.readSource).toHaveBeenCalledTimes(20);
    expect(
      results.every(r => r.blockers.includes("AMBIGUOUS_CANDIDATES"))
    ).toBe(true);
  });

  it("stops new reads once the whole-run budget is exhausted while reporting all targets", async () => {
    let now = 0;
    const io = readers({
      readSource: vi.fn(async target => {
        now = 180_000;
        return source(target);
      }),
    });
    const reports = await auditPreviewLegacySlips(
      io,
      () => {},
      () => now
    );
    expect(reports).toHaveLength(10);
    expect(io.readSource).toHaveBeenCalledTimes(1);
    expect(io.listCandidate).not.toHaveBeenCalled();
    expect(io.readCandidate).not.toHaveBeenCalled();
    expect(
      reports.every(
        r => r.blockers.includes("RUN_DEADLINE_EXCEEDED") && r.action === "NONE"
      )
    ).toBe(true);
  });
});
