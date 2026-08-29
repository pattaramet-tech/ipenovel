/**
 * IPE-001 P2: "Prevent approval after an in-place slip mutation"
 * (Codex, server/services/ocrRecheckService.ts).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * When a Recheck hashes the SAME stored slip URL twice and gets two
 * different hashes (the object's bytes changed in place, not a genuine
 * replacement), it reported `SLIP_FILE_HASH_CHANGED_DURING_RECHECK` in its
 * own transient response - but never persisted that finding. A later normal
 * Admin Approve read `payment.extractedData` fresh (correctly reloaded
 * under its lock) and found the FIRST hash (HASH_A) still sitting there,
 * unaware the URL now actually serves different bytes (HASH_B) - so it
 * could claim HASH_A while the slip displayed HASH_B.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * The mismatch is now durably persisted to `payments.reviewReason`
 * (`SLIP_INTEGRITY_BLOCK_REASON`, exported from orderService.ts), guarded by
 * the same `slipVersionAtStart` binding as every other Recheck write.
 * `orderService.lockAndRequireReviewablePayment` - the ONE shared
 * lock+reload+require-reviewable primitive used by BOTH manual admin
 * approval and OCR auto-approval - now refuses with a new
 * `SlipIntegrityBlockedError` when it finds that reason still set. A later
 * STABLE Recheck (two matching hashes) naturally clears it: its own final
 * write unconditionally overwrites `reviewReason` with that run's own fresh
 * value.
 *
 * ── Why this is exercised behaviourally ───────────────────────────────────
 * `db`, `orderService`, and `ocrRecheckService` are REAL, driven by an
 * in-memory connection whose `update().where()` actually evaluates the
 * drizzle condition tree, and whose `execute()` (the `FOR UPDATE` lock
 * primitive) is exercised by the real `approvePaymentInTx` /
 * `lockAndRequireReviewablePayment` call chain. Only the OCR provider
 * pipeline (parseSlipImage, image prep, effective config, file hash) is
 * mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ocr-slip-verification-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ocr-slip-verification-v2")>();
  return { ...actual, parseSlipImage: vi.fn() };
});
vi.mock("./ocrImageInputService", () => ({
  prepareSlipImageForOcr: vi.fn(),
}));
vi.mock("../_core/ocr-effective-config", () => ({
  getEffectiveOCRConfig: vi.fn(),
}));
vi.mock("./slipFileHashService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slipFileHashService")>();
  return { ...actual, computeSlipFileHash: vi.fn() };
});
vi.mock("./slipBackfillStateService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slipBackfillStateService")>();
  return { ...actual, isLegacyScanRequired: vi.fn(async () => false) };
});

import * as dbModule from "../db";
import * as orderService from "./orderService";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { recheckOrderPaymentOcr } from "./ocrRecheckService";

const A_URL = "r2p:payment-slips/11/slip.png";
const T_A = new Date("2026-01-01T00:00:00Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function tableName(table: any): string {
  return String(table?.[Symbol.for("drizzle:Name")] ?? "");
}

function collectEqLeaves(node: any, out: { column: string; value: unknown }[], depth = 0) {
  if (!node || depth > 20) return;
  if (Array.isArray(node)) {
    for (const n of node) collectEqLeaves(n, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const chunks = node.queryChunks;
  if (Array.isArray(chunks) && chunks.length === 5) {
    const col = chunks[1];
    const op = chunks[2];
    const param = chunks[3];
    if (
      col &&
      typeof col.name === "string" &&
      op?.value?.[0] === " = " &&
      param &&
      typeof param === "object" &&
      "value" in param
    ) {
      out.push({ column: col.name, value: (param as any).value });
      return;
    }
  }
  if (chunks) collectEqLeaves(chunks, out, depth + 1);
}

function matchesWhere(cond: any, row: Record<string, any>): boolean {
  const leaves: { column: string; value: unknown }[] = [];
  collectEqLeaves(cond, leaves);
  const groups = new Map<string, unknown[]>();
  for (const { column, value } of leaves) {
    if (!groups.has(column)) groups.set(column, []);
    groups.get(column)!.push(value);
  }
  for (const [column, values] of groups) {
    const rowVal = row[column];
    const normalizedRowVal = rowVal instanceof Date ? rowVal.getTime() : rowVal;
    const matched = values.some((v) => (v instanceof Date ? v.getTime() : v) === normalizedRowVal);
    if (!matched) return false;
  }
  return true;
}

function makeDb(rows: Record<string, any[]>) {
  const store: Record<string, any[]> = structuredClone(rows);
  let snapshot: Record<string, any[]> = structuredClone(store);

  const executor = (): any => ({
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) return [[]];
      snapshot = structuredClone(store);
      return [[{ id: 1 }]];
    },
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          const all = store[name] ?? [];
          return {
            where() {
              return {
                orderBy: () => ({
                  limit: async (n?: number) => (n ? all.slice(0, n) : all),
                  then: (resolve: any, reject: any) => Promise.resolve(all).then(resolve, reject),
                }),
                limit: async (n: number) => all.slice(0, n),
                then: (resolve: any, reject: any) => Promise.resolve(all).then(resolve, reject),
              };
            },
          };
        },
      };
    },
    update(table: any) {
      const name = tableName(table);
      return {
        set(values: any) {
          return {
            where(cond: any) {
              const all = store[name] ?? [];
              const matching = all.filter((row) => matchesWhere(cond, row));
              for (const row of matching) Object.assign(row, values);
              return [{ affectedRows: matching.length }];
            },
          };
        },
      };
    },
    insert(table: any) {
      const name = tableName(table);
      return {
        values: async (v: any) => {
          const all = (store[name] ??= []);
          all.push({ id: all.length + 1, ...v });
          return [{ insertId: all.length }];
        },
      };
    },
  });

  const base = executor();
  const fake: any = {
    ...base,
    transaction: async (fn: any) => {
      snapshot = structuredClone(store);
      try {
        return await fn(executor());
      } catch (error) {
        for (const k of Object.keys(store)) delete store[k];
        for (const [k, v] of Object.entries(snapshot)) store[k] = v as any[];
        throw error;
      }
    },
  };
  return { fake, store };
}

function orderRows() {
  return {
    payments: [
      {
        id: 700,
        orderId: 90,
        userId: 11,
        status: "pending",
        slipImageUrl: A_URL,
        slipSubmittedAt: T_A,
        createdAt: T_A,
        extractedData: JSON.stringify({ fileHash: HASH_A }),
      },
    ],
    orders: [
      {
        id: 90,
        userId: 11,
        status: "pending",
        paymentStatus: "pending",
        totalAmount: "300.00",
        pointsRedeemed: 0,
        couponId: null,
        createdAt: T_A,
      },
    ],
    paymentSlipClaims: [] as any[],
    ocrVerificationAttempts: [] as any[],
    orderHistory: [] as any[],
    purchases: [] as any[],
    pointsTransactions: [] as any[],
    orderItems: [] as any[],
    coupons: [] as any[],
    users: [{ id: 11, pointsBalance: "0" }],
  };
}

function mockOcrConfig() {
  (getEffectiveOCRConfig as any).mockResolvedValue({
    enabled: true,
    autoApproveEnabled: true,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
  });
}

describe("A same-URL slip mutation durably blocks approval until integrity is re-established (IPE-001 P2)", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("H. mismatch detected -> durably blocked, not ready for approval, nothing claimed", async () => {
    mockOcrConfig();
    const harness = makeDb(orderRows());
    dbModule.__setDbForTests(harness.fake);

    // preOcrFileHash (1st call) = A, recomputedFileHash (2nd call, after
    // OCR) = B: the SAME URL yielded two different hashes mid-recheck.
    (computeSlipFileHash as any)
      .mockResolvedValueOnce(HASH_A)
      .mockResolvedValueOnce(HASH_B);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
    (parseSlipImage as any).mockResolvedValue({
      text: "Amount: 300.00\nRef: INTEGRITY-TEST-001\nBank: Test Bank",
      ocrConfidence: 90,
      confidenceKnown: true,
      technicalError: false,
    });

    const result = await recheckOrderPaymentOcr({ paymentId: 700, adminUserId: 1 });

    expect(result.reviewReason).toBe("SLIP_FILE_HASH_CHANGED_DURING_RECHECK");
    expect(result.readyForAdminApproval).toBe(false);
    expect(result.verificationPassed).toBe(false);

    // Durably persisted - not just returned in this response.
    expect(harness.store.payments[0].reviewReason).toBe("SLIP_FILE_HASH_CHANGED_DURING_RECHECK");
    // The pre-mismatch extraction (HASH_A) is preserved, not overwritten.
    expect(JSON.parse(harness.store.payments[0].extractedData).fileHash).toBe(HASH_A);
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
  });

  it("I. normal Approve after the block -> refused server-side, zero claim/purchase/points/finalization", async () => {
    mockOcrConfig();
    const rows = orderRows();
    rows.payments[0].reviewReason = "SLIP_FILE_HASH_CHANGED_DURING_RECHECK";
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    await expect(orderService.approvePayment(700, "1", "Admin")).rejects.toThrow(
      /SLIP_INTEGRITY_BLOCKED/
    );

    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
    expect(harness.store.orders[0].status).toBe("pending");
  });

  it("J. a later STABLE Recheck (two matching hashes) persists fresh extraction and clears the block", async () => {
    mockOcrConfig();
    const rows = orderRows();
    rows.payments[0].reviewReason = "SLIP_FILE_HASH_CHANGED_DURING_RECHECK";
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    // Both hashes now agree - the object is stable again.
    (computeSlipFileHash as any).mockResolvedValue(HASH_B);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
    (parseSlipImage as any).mockResolvedValue({
      text: "Amount: 300.00\nRef: INTEGRITY-TEST-001\nBank: Test Bank",
      ocrConfidence: 90,
      confidenceKnown: true,
      technicalError: false,
    });

    const result = await recheckOrderPaymentOcr({ paymentId: 700, adminUserId: 1 });

    expect(result.reviewReason).not.toBe("SLIP_FILE_HASH_CHANGED_DURING_RECHECK");
    // The block is cleared - the row's reviewReason now reflects THIS run.
    expect(harness.store.payments[0].reviewReason).not.toBe("SLIP_FILE_HASH_CHANGED_DURING_RECHECK");
    expect(JSON.parse(harness.store.payments[0].extractedData).fileHash).toBe(HASH_B);

    // Approval can now proceed - the block no longer applies.
    await orderService.approvePayment(700, "1", "Admin");
    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
  });
});
