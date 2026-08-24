/**
 * IPE-001 P1-C: "Recheck must be version-bound".
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * ocrRecheckService.ts's conditional writes (`db.updatePaymentIfNotFinalized`)
 * were CAS'd on payment id + status only. Replacing a slip (submitPaymentSlip)
 * does NOT change status - it sets status back to "pending" - so a Recheck
 * started against slip A, still running when the customer replaces A with B,
 * could write A's pre-OCR fileHash or A's full OCR extraction onto a row that
 * now displays B. The claim/approval side already re-derives identifiers
 * fresh from the reloaded row (see orderAutoApprovalStateRace.test.ts for
 * that half of this finding), but Recheck's writes had no equivalent guard.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Recheck captures `slipVersionAtStart = {slipImageUrl, slipSubmittedAt}`
 * once, at the top of recheckOrderPaymentOcr. Both conditional writes now
 * pass it to `db.updatePaymentIfNotFinalized`, which requires the row's
 * CURRENT slip identity to still match it, not just requiring the row to be
 * non-finalized. Losing that race returns `RECHECK_SUPERSEDED_BY_SLIP_
 * REPLACEMENT` (buildSupersededResult distinguishes it from finalization by
 * comparing the reloaded row's slip identity against the captured one) and
 * writes nothing.
 *
 * ── Why this is exercised behaviourally ───────────────────────────────────
 * `db`, `orderService`, and `ocrRecheckService` are REAL, driven by an
 * in-memory transaction harness whose fake `update().where()` actually
 * evaluates the drizzle condition tree (id/status/slip-version), so a lost
 * CAS in this test means the SAME WHERE clause would have matched zero rows
 * against a real MySQL table - not just that a JS-level flag was set. Only
 * the OCR provider pipeline (parseSlipImage, image prep, effective config,
 * file hash) is mocked; the concurrent slip replacement is simulated as a
 * side effect of those mocked calls resolving, standing for a second request
 * that completed its own publish while this recheck's async work was still
 * in flight.
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

import * as dbModule from "../db";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { recheckOrderPaymentOcr } from "./ocrRecheckService";

const A_URL = "r2p:payment-slips/11/slip-a.png";
const B_URL = "r2p:payment-slips/11/slip-b.png";
const T_A = new Date("2026-01-01T00:00:00Z");
const T_B = new Date("2026-01-02T00:00:00Z");
const A_HASH = "a".repeat(64);
const B_HASH = "b".repeat(64);

function tableName(table: any): string {
  return String(table?.[Symbol.for("drizzle:Name")] ?? "");
}

/** Flattens a drizzle and()/or()/eq() condition tree into {column,value} leaves. */
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

/**
 * A column appearing once means "must equal this"; appearing more than once
 * (an or() group, as the reviewable-status check produces) means "must equal
 * one of these". Every WHERE clause built by db.ts's conditional payment
 * writers is a flat AND of such groups - this matches that shape exactly.
 */
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

/**
 * Same shape as orderAutoApprovalStateRace.test.ts's harness, but with a
 * WHERE-aware update() - Recheck's writes are single conditional UPDATE
 * statements (no explicit lock), so the CAS proof has to live in whether the
 * condition actually matches, not in a lock-acquisition hook.
 */
function makeDb(rows: Record<string, any[]>) {
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(rows));

  const fake: any = {
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          const all = store[name] ?? [];
          return {
            where() {
              return {
                orderBy: () => ({ limit: async (n: number) => all.slice(0, n) }),
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
  };
  return { fake, store };
}

function recheckRows() {
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
        extractedData: null,
      },
    ],
    orders: [
      {
        id: 90,
        userId: 11,
        status: "pending",
        paymentStatus: "pending",
        totalAmount: "300.00",
        createdAt: T_A,
      },
    ],
    paymentSlipClaims: [] as any[],
    ocrVerificationAttempts: [] as any[],
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

/** Replaces the slip A -> B in the store, as a concurrent publish would. */
function applyReplacement(store: Record<string, any[]>) {
  store.payments[0].slipImageUrl = B_URL;
  store.payments[0].slipSubmittedAt = T_B;
  store.payments[0].status = "pending"; // a replacement re-opens status, never changes it here
  store.payments[0].extractedData = JSON.stringify({ fileHash: B_HASH });
}

describe("Recheck writes are bound to the slip version it started against", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("D. slip replaced before the pre-OCR write -> refused, A's hash never lands on B, no provider call", async () => {
    mockOcrConfig();
    const harness = makeDb(recheckRows());
    dbModule.__setDbForTests(harness.fake);

    // The replacement lands as a side effect of the pre-OCR fileHash
    // computation resolving - standing for a second request's publish
    // completing while this async call was in flight.
    (computeSlipFileHash as any).mockImplementation(async () => {
      applyReplacement(harness.store);
      return A_HASH;
    });

    const result = await recheckOrderPaymentOcr({ paymentId: 700, adminUserId: 1 });

    expect(result.reviewReason).toBe("RECHECK_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect((result as any).supersededByFinalization).toBe(false);
    expect(result.paymentStatus).toBe("pending");

    // A's hash never landed on the row - B's own extractedData (set by the
    // simulated concurrent publish) stands untouched.
    expect(harness.store.payments[0].slipImageUrl).toBe(B_URL);
    expect(JSON.parse(harness.store.payments[0].extractedData)).toEqual({ fileHash: B_HASH });

    // Stops BEFORE any provider call - the pre-OCR write is deliberately
    // above the OCR-enabled/provider path.
    expect(parseSlipImage).not.toHaveBeenCalled();
    expect(prepareSlipImageForOcr).not.toHaveBeenCalled();
  });

  it("E. slip replaced during the provider call -> final extraction refused, B remains authoritative", async () => {
    mockOcrConfig();
    const harness = makeDb(recheckRows());
    dbModule.__setDbForTests(harness.fake);

    // Pre-OCR call: slip is still A, so this write lands normally.
    (computeSlipFileHash as any).mockResolvedValue(A_HASH);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip-a.png");

    // The replacement lands while the provider call is "in flight".
    (parseSlipImage as any).mockImplementation(async () => {
      applyReplacement(harness.store);
      return {
        text: "Amount: 300.00\nRef: RECHECK-RACE-001\nBank: Test Bank",
        ocrConfidence: 90,
        confidenceKnown: true,
        technicalError: false,
      };
    });

    const result = await recheckOrderPaymentOcr({ paymentId: 700, adminUserId: 1 });

    expect(result.reviewReason).toBe("RECHECK_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect((result as any).supersededByFinalization).toBe(false);

    // B's row (set by the simulated concurrent publish) was never
    // overwritten by A's stale, now-superseded OCR result.
    expect(harness.store.payments[0].slipImageUrl).toBe(B_URL);
    expect(JSON.parse(harness.store.payments[0].extractedData)).toEqual({ fileHash: B_HASH });
    expect(harness.store.payments[0].ocrDecision).not.toBe("needs_review");
  });

  it("G. unchanged slip -> Recheck completes normally and writes the fresh extraction", async () => {
    mockOcrConfig();
    const harness = makeDb(recheckRows());
    dbModule.__setDbForTests(harness.fake);

    (computeSlipFileHash as any).mockResolvedValue(A_HASH);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip-a.png");
    (parseSlipImage as any).mockResolvedValue({
      text: "Amount: 300.00\nRef: RECHECK-HAPPY-001\nBank: Test Bank",
      ocrConfidence: 90,
      confidenceKnown: true,
      technicalError: false,
    });

    const result = await recheckOrderPaymentOcr({ paymentId: 700, adminUserId: 1 });

    expect(result.reviewReason).not.toBe("RECHECK_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(result.reviewReason).not.toBe("RECHECK_SUPERSEDED_BY_FINALIZATION");
    expect((result as any).supersededByFinalization).not.toBe(true);

    // The row still describes A, and now carries the fresh OCR extraction -
    // not just the pre-OCR fileHash seed.
    expect(harness.store.payments[0].slipImageUrl).toBe(A_URL);
    const written = JSON.parse(harness.store.payments[0].extractedData);
    expect(written.fileHash).toBe(A_HASH);
    expect(written.reference ?? written.referenceRaw).toBeTruthy();
    expect(harness.store.payments[0].status).toBe("pending"); // Recheck never moves status.
  });
});
