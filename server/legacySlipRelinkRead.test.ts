import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import type { Connection } from "mysql2/promise";
import {
  payments,
  walletTopups,
  orders,
  paymentSlipClaims,
  slipEvidenceBindings,
  slipEvidenceUploads,
  paymentSlipLegacyUnknown,
  paymentSlipLegacyCollisions,
} from "../drizzle/schema";
import {
  createRelinkDatabaseReaders,
  RelinkReadError,
} from "../scripts/lib/legacySlipRelinkRead";
import {
  PREVIEW_AUDIT_TARGETS,
  type LegacySlipAuditEnvironment,
} from "../scripts/lib/legacySlipAuditOptions";

const DB_CONFIG: LegacySlipAuditEnvironment["db"] = {
  host: "mock-only",
  user: "fixture",
  password: "private-test-password",
  database: "fixture_test",
  port: 3306,
  connectTimeout: 5000,
  supportBigNumbers: true,
  bigNumberStrings: true,
  multipleStatements: false,
};
const PAYMENT = PREVIEW_AUDIT_TARGETS[0];
const WALLET = PREVIEW_AUDIT_TARGETS[5];
const TIME = "2026-09-05 09:18:15.123456";
const CANONICAL_HASH = "a".repeat(64);
const RAW_HASH = "b".repeat(64);
const KEY = `payment-slips/legacy/payments/${PAYMENT.sourceId}/1786733030322-fixture.jpg`;
const REF = `r2p:${KEY}`;
const CROSS_INPUT = {
  target: PAYMENT,
  canonicalHash: CANONICAL_HASH,
  rawHash: RAW_HASH,
  key: KEY,
};

function paymentRow() {
  return {
    id: String(PAYMENT.sourceId),
    orderId: "82620001",
    slipImageUrl: "https://legacy.invalid/private",
    slipSubmittedAt: TIME,
    evidenceVersion: "0",
    slipEvidenceClass: "legacy_compatibility_required",
    slipEvidenceId: null,
    extractedEvidenceVersion: null,
    status: "approved",
    rejectionReason: null,
    reviewedByUserId: null,
    reviewedAt: null,
    extractedData: '{"amount":"140.00"}',
    reviewReason: null,
    fingerprint: null,
    autoApprovedAt: null,
    linkedOrderId: null,
    linkedPaymentId: null,
    ocrConfidence: 0,
    ocrDecision: "needs_review",
    approvalSource: "legacy",
    approvedByAdminId: null,
    approvedByLabel: null,
    approvedAt: TIME,
    createdAt: TIME,
    updatedAt: TIME,
    ownerUserId: "3001",
  };
}
function orderRow() {
  return {
    id: "82620001",
    orderNumber: "private-order-number",
    userId: "3001",
    subtotal: "140.00",
    discountAmount: "0.00",
    pointsDiscountAmount: "0.00",
    totalAmount: "140.00",
    status: "approved",
    paymentStatus: "approved",
    couponCodeSnapshot: null,
    notes: null,
    createdAt: TIME,
    updatedAt: TIME,
  };
}
function walletRow() {
  return {
    id: String(WALLET.sourceId),
    userId: "3001",
    requestedAmount: "140.00",
    bonusAmount: "0.00",
    creditedAmount: "140.00",
    slipImageUrl: "https://legacy.invalid/private",
    slipSubmittedAt: TIME,
    evidenceVersion: "0",
    slipEvidenceClass: "legacy_compatibility_required",
    slipEvidenceId: null,
    extractedEvidenceVersion: null,
    status: "approved",
    rejectionReason: null,
    reviewedByUserId: null,
    reviewedAt: null,
    approvedAt: TIME,
    approvedByAdminId: null,
    rejectedAt: null,
    extractedData: null,
    ocrConfidence: "72.33",
    visionConfidence: null,
    structuredConfidence: null,
    finalConfidence: null,
    duplicateStatus: null,
    ocrDecision: null,
    reviewReason: null,
    approvalSource: "manual",
    createdAt: TIME,
    updatedAt: TIME,
  };
}
function claimRow(source = PAYMENT, id = 1) {
  return {
    id: String(id),
    sourceType: source.sourceType,
    sourceId: String(source.sourceId),
    userId: "3001",
    referenceHash: null,
    legacyReferenceUpperHash: null,
    fileHash: CANONICAL_HASH,
    qrPayloadHash: null,
    semanticFingerprint: null,
    claimedAt: TIME,
  };
}
function bindingRow(source = PAYMENT, id = 1) {
  return {
    id,
    uploadId: null,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    ownerUserId: "3001",
    evidenceVersion: "1",
    evidenceClass: "legacy_migrated_immutable",
    objectIdentity: KEY,
    fileHash: CANONICAL_HASH,
    objectSize: "123",
    mimeType: "image/jpeg",
    createdAt: TIME,
  };
}
function unknownRow(source = PAYMENT, id = 1) {
  return {
    id,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    reason: "no_slip_image_url",
    recordedAt: TIME,
  };
}
function collisionRow(source = PAYMENT, id = 1) {
  return {
    id,
    kind: "file",
    identifierHash: CANONICAL_HASH,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    recordedAt: TIME,
  };
}
function uploadRow(id = 1) {
  return {
    id,
    objectIdentity: KEY,
    ownerUserId: "3001",
    fileHash: CANONICAL_HASH,
    objectSize: 123,
    mimeType: "image/jpeg",
    createdAt: TIME,
  };
}
function referenceRow(sourceType = "order_payment", id = 99) {
  return {
    id,
    sourceType,
    slipImageUrl: REF,
    status: "approved",
    evidenceVersion: "0",
    slipEvidenceClass: "legacy_compatibility_required",
    slipEvidenceId: null,
  };
}
type QueryArgs = { sql: string; values: unknown[]; timeout: number };
type Resolver = (query: QueryArgs) => unknown;
function sourceResolver(query: QueryArgs) {
  if (query.sql.includes("FROM payments p ")) return [paymentRow()];
  if (query.sql.includes("FROM walletTopups WHERE id =")) return [walletRow()];
  if (query.sql.includes("FROM orders WHERE")) return [orderRow()];
  return [];
}
function harness(
  resolve: Resolver = sourceResolver,
  opts: { connectError?: boolean; destroyError?: boolean } = {}
) {
  const events: string[] = [];
  const connections: Array<{
    query: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const connect = vi.fn(async (_config: unknown) => {
    events.push("connect");
    if (opts.connectError) throw new Error("private host/password from driver");
    const connection = {
      query: vi.fn(async (query: QueryArgs) => {
        events.push("query");
        return [resolve(query), undefined];
      }),
      destroy: vi.fn(() => {
        events.push("destroy");
        if (opts.destroyError) throw new Error("private destroy credentials");
      }),
    };
    connections.push(connection);
    return connection as unknown as Connection;
  });
  return {
    connect,
    connections,
    events,
    readers: createRelinkDatabaseReaders(DB_CONFIG, connect),
  };
}
function allQueries(h: ReturnType<typeof harness>): QueryArgs[] {
  return h.connections.flatMap(c =>
    c.query.mock.calls.map(call => call[0] as QueryArgs)
  );
}
async function expectReadError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(RelinkReadError);
    expect((error as RelinkReadError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    expect(JSON.stringify(error)).not.toMatch(
      /private|password|credentials|host/
    );
    expect((error as Error).cause).toBeUndefined();
  }
}

describe("legacy slip relink SELECT-only source snapshot", () => {
  it("captures all source/order columns with lossless decimal and timestamp strings", async () => {
    const h = harness();
    const snapshot = await h.readers.readSource(PAYMENT);
    expect(snapshot?.record.id).toBe(PAYMENT.sourceId);
    expect(snapshot?.record.evidenceVersion).toBe(0);
    expect(snapshot?.record.createdAt).toBe(TIME);
    expect(snapshot?.record.extractedData).toBe(paymentRow().extractedData);
    expect(snapshot?.order?.totalAmount).toBe("140.00");
    expect(snapshot?.source.ownerUserId).toBe(3001);
    expect(snapshot?.source.slipImageUrl).toBe(snapshot?.record.slipImageUrl);
    expect(snapshot?.source.status).toBe("approved");
    expect(snapshot?.record).not.toHaveProperty("ownerUserId");
    expect(Object.keys(snapshot!.record).sort()).toEqual(
      Object.keys(getTableColumns(payments)).sort()
    );
    expect(Object.keys(snapshot!.order!).sort()).toEqual(
      Object.keys(getTableColumns(orders)).sort()
    );
    expect(snapshot?.truncated).toBe(false);
    expect(h.events.at(-1)).toBe("destroy");
  });

  it("reads wallet ownership, financial amounts and OCR confidence from its same row", async () => {
    const h = harness(q =>
      q.sql.includes("FROM walletTopups WHERE id =")
        ? [{ ...walletRow(), requestedAmount: "9999999999.99" }]
        : []
    );
    const snapshot = await h.readers.readSource(WALLET);
    expect(Object.keys(snapshot!.record).sort()).toEqual(
      Object.keys(getTableColumns(walletTopups)).sort()
    );
    expect(snapshot?.record.requestedAmount).toBe("9999999999.99");
    expect(snapshot?.record.ocrConfidence).toBe("72.33");
    expect(snapshot?.source.ownerUserId).toBe(3001);
    expect(snapshot?.order).toBeNull();
    expect(allQueries(h).some(q => q.sql.includes("FROM orders"))).toBe(false);
  });

  it("uses a fresh connection for every snapshot and forces safe driver options", async () => {
    const h = harness();
    await h.readers.readSource(PAYMENT);
    await h.readers.readSource(PAYMENT);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connect.mock.calls[0][0]).toEqual({
      ...DB_CONFIG,
      dateStrings: true,
      decimalNumbers: false,
    });
    for (const connection of h.connections)
      expect(connection.destroy).toHaveBeenCalledOnce();
    for (const q of allQueries(h)) {
      expect(q.sql).toMatch(/^SELECT /);
      expect(q.sql).not.toMatch(
        /SELECT \*|FOR UPDATE|LOCK IN SHARE|;|START TRANSACTION|\bINSERT\b|\bDELETE\b|\bUPDATE\b/i
      );
      expect(q.sql).toMatch(/LIMIT (1|21)$/);
      expect(q.timeout).toBe(5000);
    }
  });

  it("retains every selected related field and binds exact source parameters", async () => {
    const mapping = {
      paymentSlipClaims: { row: claimRow(), table: paymentSlipClaims },
      slipEvidenceBindings: { row: bindingRow(), table: slipEvidenceBindings },
      paymentSlipLegacyUnknown: {
        row: unknownRow(),
        table: paymentSlipLegacyUnknown,
      },
      paymentSlipLegacyCollisions: {
        row: collisionRow(),
        table: paymentSlipLegacyCollisions,
      },
    };
    const h = harness(q => {
      for (const [table, value] of Object.entries(mapping))
        if (q.sql.includes(`FROM ${table} WHERE`)) return [value.row];
      return sourceResolver(q);
    });
    const snapshot = await h.readers.readSource(PAYMENT);
    const arrays = [
      snapshot!.related.claims,
      snapshot!.related.bindings,
      snapshot!.related.unknowns,
      snapshot!.related.collisions,
    ];
    Object.values(mapping).forEach((value, index) =>
      expect(Object.keys(arrays[index][0]).sort()).toEqual(
        Object.keys(getTableColumns(value.table)).sort()
      )
    );
    expect(snapshot?.source.claims).toEqual([
      { id: 1, userId: 3001, fileHash: CANONICAL_HASH },
    ]);
    expect(snapshot?.source.bindings).toEqual([{ id: 1 }]);
    const relatedQueries = allQueries(h).filter(q =>
      q.sql.includes("WHERE sourceType")
    );
    expect(relatedQueries).toHaveLength(4);
    for (const q of relatedQueries) {
      expect(q.values).toEqual([PAYMENT.sourceType, PAYMENT.sourceId]);
      expect(q.sql).toMatch(/ORDER BY id LIMIT 21$/);
    }
  });

  it.each([
    ["paymentSlipClaims", "claims", claimRow],
    ["slipEvidenceBindings", "bindings", bindingRow],
    ["paymentSlipLegacyUnknown", "unknowns", unknownRow],
    ["paymentSlipLegacyCollisions", "collisions", collisionRow],
  ] as const)(
    "flags a 21st %s row without silently dropping the sentinel",
    async (table, field, makeRow) => {
      const h = harness(q =>
        q.sql.includes(`FROM ${table} WHERE`)
          ? Array.from({ length: 21 }, (_, i) => makeRow(PAYMENT, i + 1))
          : sourceResolver(q)
      );
      const snapshot = await h.readers.readSource(PAYMENT);
      expect(snapshot?.related[field]).toHaveLength(21);
      expect(snapshot?.truncated).toBe(true);
      expect(snapshot?.source.relatedReadTruncated).toBe(true);
    }
  );

  it("returns null only for a missing source, then closes without related reads", async () => {
    const h = harness(() => []);
    expect(await h.readers.readSource(PAYMENT)).toBeNull();
    expect(allQueries(h)).toHaveLength(1);
    expect(h.events.at(-1)).toBe("destroy");
  });

  it("retains owner-unproven orphan order as null rather than inventing a user", async () => {
    const h = harness(q =>
      q.sql.includes("FROM payments p")
        ? [{ ...paymentRow(), ownerUserId: null }]
        : []
    );
    const snapshot = await h.readers.readSource(PAYMENT);
    expect(snapshot?.order).toBeNull();
    expect(snapshot?.source.ownerUserId).toBeNull();
  });

  it.each([
    { sourceType: "order_payment", sourceId: 10020002 },
    { sourceType: "order_payment", sourceId: 82350007 },
    { sourceType: "wallet_topup", sourceId: PAYMENT.sourceId },
    { sourceType: "order_payment", sourceId: String(PAYMENT.sourceId) },
    null,
  ])(
    "rejects an out-of-scope or malformed target before connecting: %j",
    async target => {
      const h = harness();
      await expectReadError(
        h.readers.readSource(target as never),
        "INVALID_TARGET"
      );
      expect(h.connect).not.toHaveBeenCalled();
    }
  );

  it.each([
    { id: "9007199254740993" },
    { id: 0 },
    { id: true },
    { id: PAYMENT.sourceId + 1 },
    { orderId: "1e4" },
    { evidenceVersion: "9007199254740992" },
    { evidenceVersion: -1 },
    { slipEvidenceId: "0" },
    { extractedEvidenceVersion: "01" },
    { ownerUserId: undefined },
    { createdAt: new Date() },
    { createdAt: "not a timestamp" },
    { extractedData: { private: "ocr" } },
    { unexpected: "do not copy unknown columns" },
    { status: null },
  ])(
    "fails closed on malformed payment data without leaking it: %j",
    async patch => {
      const h = harness(q =>
        q.sql.includes("FROM payments p")
          ? [{ ...paymentRow(), ...patch }]
          : sourceResolver(q)
      );
      await expectReadError(
        h.readers.readSource(PAYMENT),
        "SOURCE_READ_FAILED"
      );
      expect(h.events.at(-1)).toBe("destroy");
    }
  );

  it.each([140, Number.NaN, "1e2", "140.00 private", {}, undefined])(
    "never rounds/coerces an invalid DECIMAL: %j",
    async requestedAmount => {
      const h = harness(q =>
        q.sql.includes("FROM walletTopups WHERE id =")
          ? [{ ...walletRow(), requestedAmount }]
          : []
      );
      await expectReadError(h.readers.readSource(WALLET), "SOURCE_READ_FAILED");
    }
  );

  it("does not combine owner snapshots that changed between source and order reads", async () => {
    const h = harness(q =>
      q.sql.includes("FROM orders WHERE")
        ? [{ ...orderRow(), userId: 3002 }]
        : sourceResolver(q)
    );
    await expectReadError(h.readers.readSource(PAYMENT), "SOURCE_READ_FAILED");
  });

  it("does not accept a related record for another source", async () => {
    const h = harness(q =>
      q.sql.includes("FROM paymentSlipClaims")
        ? [{ ...claimRow(), sourceId: 42 }]
        : sourceResolver(q)
    );
    await expectReadError(h.readers.readSource(PAYMENT), "SOURCE_READ_FAILED");
  });

  it.each(["query", "connect", "destroy"])(
    "sanitizes %s failures and does not return a partial snapshot",
    async mode => {
      const h = harness(
        mode === "query"
          ? () => {
              throw { errno: 1142, message: "private host/password/SQL" };
            }
          : sourceResolver,
        { connectError: mode === "connect", destroyError: mode === "destroy" }
      );
      await expectReadError(
        h.readers.readSource(PAYMENT),
        "SOURCE_READ_FAILED"
      );
      if (mode !== "connect") expect(h.events.at(-1)).toBe("destroy");
    }
  );

  it.each([{}, [paymentRow(), paymentRow()]])(
    "rejects non-row or over-limit DB results",
    async rows => {
      const h = harness(() => rows);
      await expectReadError(
        h.readers.readSource(PAYMENT),
        "SOURCE_READ_FAILED"
      );
    }
  );
});

describe("legacy slip relink bounded cross-reference reads", () => {
  it("queries both hash formats, both objectIdentity encodings and both source tables", async () => {
    const h = harness(q => {
      if (q.sql.includes("FROM paymentSlipClaims")) return [claimRow()];
      if (q.sql.includes("FROM paymentSlipLegacyCollisions"))
        return [collisionRow()];
      if (q.sql.includes("FROM slipEvidenceBindings")) return [bindingRow()];
      if (q.sql.includes("FROM slipEvidenceUploads")) return [uploadRow()];
      if (q.sql.includes("FROM payments WHERE")) return [referenceRow()];
      if (q.sql.includes("FROM walletTopups WHERE"))
        return [referenceRow("wallet_topup", 45)];
      throw new Error("Unexpected SQL");
    });
    const result = await h.readers.readCrossReferences(CROSS_INPUT);
    expect(result.truncated).toBe(false);
    expect(result.references.map(r => r.sourceType)).toEqual([
      "order_payment",
      "wallet_topup",
    ]);
    expect(Object.keys(result.uploads[0]).sort()).toEqual(
      Object.keys(getTableColumns(slipEvidenceUploads)).sort()
    );
    expect(allQueries(h)).toHaveLength(6);
    for (const q of allQueries(h)) {
      expect(q.sql).toMatch(/^SELECT /);
      expect(q.sql).toMatch(/ORDER BY id LIMIT 21$/);
      expect(q.timeout).toBe(5000);
      expect(q.sql).not.toContain(CANONICAL_HASH);
      expect(q.sql).not.toContain(KEY);
      if (q.sql.includes("FROM paymentSlipClaims"))
        expect(q.values).toEqual([CANONICAL_HASH, RAW_HASH]);
      if (q.sql.includes("FROM paymentSlipLegacyCollisions")) {
        expect(q.sql).toContain("kind = 'file' AND identifierHash IN (?, ?)");
        expect(q.values).toEqual([CANONICAL_HASH, RAW_HASH]);
      }
      if (q.sql.includes("objectIdentity IN"))
        expect(q.values).toEqual([CANONICAL_HASH, RAW_HASH, KEY, REF]);
      if (q.sql.includes("slipImageUrl = BINARY"))
        expect(q.values).toEqual([REF]);
    }
    expect(h.events.at(-1)).toBe("destroy");
  });

  it("allows the wallet target's exact prefix but never falls back to broad bucket keys", async () => {
    const h = harness(() => []);
    await h.readers.readCrossReferences({
      ...CROSS_INPUT,
      target: WALLET,
      key: `payment-slips/legacy/wallet-topups/${WALLET.sourceId}/1786733030322-fixture.pdf`,
    });
    expect(h.connect).toHaveBeenCalledOnce();
  });

  it.each([
    { canonicalHash: "not a hash" },
    { rawHash: "c".repeat(63) },
    { key: REF },
    { key: KEY.replace(String(PAYMENT.sourceId), "42") },
    { key: `${KEY}/../other.jpg` },
    { key: "payment-slips/new/private.jpg" },
    { key: KEY.replace(".jpg", ".exe") },
  ])("rejects malformed hashes/key before connection: %j", async patch => {
    const h = harness(() => []);
    await expectReadError(
      h.readers.readCrossReferences({ ...CROSS_INPUT, ...patch }),
      "CROSS_REFERENCE_READ_FAILED"
    );
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("rejects non-scope cross-reference targets before connection", async () => {
    const h = harness(() => []);
    await expectReadError(
      h.readers.readCrossReferences({
        ...CROSS_INPUT,
        target: { ...PAYMENT, sourceId: 10020002 },
      }),
      "INVALID_TARGET"
    );
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("rejects coercible hash objects without invoking untrusted toString", async () => {
    const toString = vi.fn(() => CANONICAL_HASH);
    const h = harness(() => []);
    await expectReadError(
      h.readers.readCrossReferences({
        ...CROSS_INPUT,
        canonicalHash: { toString } as never,
      }),
      "CROSS_REFERENCE_READ_FAILED"
    );
    expect(toString).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["paymentSlipClaims", claimRow],
    ["paymentSlipLegacyCollisions", collisionRow],
    ["slipEvidenceBindings", bindingRow],
  ] as const)("flags truncated %s hash matches", async (table, makeRow) => {
    const h = harness(q =>
      q.sql.includes(`FROM ${table} WHERE`)
        ? Array.from({ length: 21 }, (_, i) => makeRow(PAYMENT, i + 1))
        : []
    );
    expect((await h.readers.readCrossReferences(CROSS_INPUT)).truncated).toBe(
      true
    );
  });

  it("bounds both source reference queries independently and retains their sentinels", async () => {
    const h = harness(q => {
      if (q.sql.includes("FROM payments WHERE"))
        return Array.from({ length: 21 }, (_, i) =>
          referenceRow("order_payment", i + 1)
        );
      if (q.sql.includes("FROM walletTopups WHERE"))
        return Array.from({ length: 21 }, (_, i) =>
          referenceRow("wallet_topup", i + 1)
        );
      return [];
    });
    const result = await h.readers.readCrossReferences(CROSS_INPUT);
    expect(result.references).toHaveLength(42);
    expect(result.truncated).toBe(true);
  });

  it("flags upload truncation", async () => {
    const h = harness(q =>
      q.sql.includes("FROM slipEvidenceUploads WHERE")
        ? Array.from({ length: 21 }, (_, i) => uploadRow(i + 1))
        : []
    );
    expect((await h.readers.readCrossReferences(CROSS_INPUT)).truncated).toBe(
      true
    );
  });

  it("does not accept a falsely matching binary reference", async () => {
    const h = harness(q =>
      q.sql.includes("FROM payments WHERE")
        ? [{ ...referenceRow(), slipImageUrl: REF.toUpperCase() }]
        : []
    );
    await expectReadError(
      h.readers.readCrossReferences(CROSS_INPUT),
      "CROSS_REFERENCE_READ_FAILED"
    );
  });

  it.each(["query", "connect", "destroy"])(
    "sanitizes cross-reference %s errors",
    async mode => {
      const h = harness(
        mode === "query"
          ? () => {
              throw new Error("private connection string SQL password");
            }
          : () => [],
        { connectError: mode === "connect", destroyError: mode === "destroy" }
      );
      await expectReadError(
        h.readers.readCrossReferences(CROSS_INPUT),
        "CROSS_REFERENCE_READ_FAILED"
      );
    }
  );
});
