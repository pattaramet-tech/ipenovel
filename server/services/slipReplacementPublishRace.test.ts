/**
 * IPE-001 P1-B: "Slip replacement must invalidate old authority".
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * submitPaymentSlip published a replacement slip (slipImageUrl, slipSubmittedAt,
 * status) with an unconditional db.updatePayment call that never touched
 * extractedData. A payment could sit with slipImageUrl = B (the new slip) and
 * extractedData still describing A (the old one) for the entire duration of
 * B's OCR run - and Admin Approve, which claims whatever identifiers are on
 * the reloaded row, would have claimed A's identifiers while B is what the
 * admin panel displays.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * `db.publishReplacementSlipIfReviewable` does the whole publish in ONE
 * conditional UPDATE: it sets the new slipImageUrl/slipSubmittedAt AND
 * invalidates extractedData (seeding the new slip's own server-derived
 * fileHash when available) in the same statement, and only while the payment
 * is still reviewable - a finalized payment can never be reopened by a
 * replacement upload.
 *
 * ── Why this is exercised behaviourally ───────────────────────────────────
 * `db` and `orderService` are REAL. The fake connection's update().where()
 * actually evaluates the drizzle condition tree (id/status), so "the publish
 * was refused" here means the same WHERE clause would match zero rows
 * against a real MySQL table - not just that a flag was set in this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IPE-001-C09: orderService.approvePayment now re-hashes the CURRENT stored
// bytes before claiming, immediately before claimSlip. The real
// implementation fetches a signed URL and downloads the object - unavailable
// against this test's fake "r2p:" URLs - so it is mocked exactly like
// walletSlipReplacementRace.test.ts already mocks it for the wallet side,
// and each test that reaches the new checkpoint sets its own return value.
vi.mock("./slipFileHashService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slipFileHashService")>();
  return { ...actual, computeSlipFileHash: vi.fn() };
});

import * as dbModule from "../db";
import * as orderService from "./orderService";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";
import { computeSlipFileHash } from "./slipFileHashService";

const REFERENCE_A = "original-slip-a-ref";
const HASH_A = hashSlipReference(REFERENCE_A)!;
const A_URL = "r2p:payment-slips/11/slip-a.png";
const B_URL = "r2p:payment-slips/11/slip-b.png";
const T_A = new Date("2026-01-01T00:00:00Z");
const T_B = new Date("2026-01-02T00:00:00Z");
const B_FILE_HASH = "b".repeat(64);

function tableName(table: any): string {
  return String(table?.[Symbol.for("drizzle:Name")] ?? "");
}

function boundHashes(cond: any): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (n: any, d = 0) => {
    if (!n || d > 12) return;
    if (typeof n === "string" && /^[0-9a-f]{64}$/.test(n)) found.push(n);
    if (typeof n === "object") {
      if (seen.has(n)) return;
      seen.add(n);
    }
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    if (typeof n === "object") for (const k of Object.keys(n)) walk((n as any)[k], d + 1);
  };
  walk(cond);
  return found;
}

function targetedColumns(cond: any): string[] {
  const known = ["referenceHash", "legacyReferenceUpperHash", "fileHash", "qrPayloadHash"];
  const names = new Set<string>();
  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    for (const chunk of node.queryChunks ?? []) {
      if (chunk && typeof chunk === "object") {
        if (typeof chunk.name === "string" && known.includes(chunk.name)) names.add(chunk.name);
        visit(chunk, depth + 1);
      }
    }
  };
  visit(cond);
  return names.size ? [...names] : known;
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

/** A column repeated (an or() group) means "one of"; once means "exactly". */
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

/** WHERE-aware update() (proves the CAS itself, not just a JS-level flag),
 * combined with the hash-lookup select() the claim registry needs. */
function makeDb(rows: Record<string, any[]>) {
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(rows));
  let snapshot: Record<string, any[]> = JSON.parse(JSON.stringify(store));

  const executor = (): any => ({
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) return [[]];
      snapshot = JSON.parse(JSON.stringify(store));
      return [[{ id: 1 }]];
    },
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          return {
            // findAnyLegacyFileIdentityUnknown (IPE-004-C03) calls
            // select().from(...).limit(1) directly, with no .where() at all -
            // the only such shape here. This fixture never seeds
            // paymentSlipLegacyUnknown, so it is always empty.
            limit: async () => (name === "paymentSlipLegacyUnknown" ? [] : store[name] ?? []),
            where(cond: any) {
              const wanted = boundHashes(cond);
              const cols = targetedColumns(cond);
              const all = store[name] ?? [];
              const filtered =
                name === "paymentSlipClaims"
                  ? wanted.length
                    ? all.filter((r) => cols.some((c) => r[c] && wanted.includes(r[c])))
                    : []
                  : all;
              return {
                orderBy: () => ({ limit: async () => filtered }),
                limit: async (n: number) => filtered.slice(0, n),
                then: (resolve: any, reject: any) =>
                  Promise.resolve(filtered).then(resolve, reject),
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
      snapshot = JSON.parse(JSON.stringify(store));
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

function orderRows(paymentStatus = "pending") {
  return {
    payments: [
      {
        id: 700,
        orderId: 90,
        status: paymentStatus,
        slipImageUrl: A_URL,
        slipSubmittedAt: T_A,
        evidenceVersion: 0,
        extractedData: JSON.stringify({ referenceRaw: REFERENCE_A, referenceHash: HASH_A }),
      },
    ],
    orders: [
      {
        id: 90,
        userId: 11,
        status: paymentStatus === "approved" ? "approved" : "pending",
        paymentStatus: paymentStatus === "approved" ? "approved" : "pending",
        totalAmount: "300.00",
        pointsRedeemed: 0,
        couponId: null,
      },
    ],
    paymentSlipClaims: [] as any[],
    orderHistory: [] as any[],
    purchases: [] as any[],
    pointsTransactions: [] as any[],
    pointsAccounts: [{ userId: 11, balance: "0.00", version: 0 }],
    orderItems: [] as any[],
    coupons: [] as any[],
    users: [{ id: 11, pointsBalance: "0" }],
  };
}

describe("Slip replacement publish is atomic and version-bound (IPE-001 P1-B)", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("A/B. publishing B invalidates A's identifiers in the SAME write, so a later Admin Approve can only claim B's", async () => {
    const harness = makeDb(orderRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    // Customer replaces A with B. OCR for B has not run yet (this call
    // mirrors exactly what submitPaymentSlip does before it starts OCR).
    const published = await dbModule.publishReplacementSlipIfReviewable(700, {
      slipImageUrl: B_URL,
      slipSubmittedAt: T_B,
      extractedData: JSON.stringify({ fileHash: B_FILE_HASH }),
    });
    expect(published).toBe(true);

    // A's reference is GONE from the row - not left alongside B's slip.
    const afterPublish = JSON.parse(harness.store.payments[0].extractedData);
    expect(afterPublish).toEqual({ fileHash: B_FILE_HASH });
    expect(afterPublish.referenceHash).toBeUndefined();
    expect(harness.store.payments[0].slipImageUrl).toBe(B_URL);
    expect(harness.store.payments[0].status).toBe("pending");

    // Admin approves what is now on the row. It can only see B's fileHash -
    // A's referenceHash was never a candidate. Stand in for B's real bytes
    // hashing to what was just published for B (IPE-001-C09's rehash).
    (computeSlipFileHash as any).mockResolvedValue(B_FILE_HASH);
    await orderService.approvePayment(700, "admin-1", "Admin");

    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(B_FILE_HASH);
    expect(harness.store.paymentSlipClaims[0].referenceHash ?? null).not.toBe(HASH_A);
  });

  it("C. Admin already finalized A -> B's replacement publish is refused, never reopens the payment", async () => {
    const harness = makeDb(orderRows("approved"));
    dbModule.__setDbForTests(harness.fake);

    const published = await dbModule.publishReplacementSlipIfReviewable(700, {
      slipImageUrl: B_URL,
      slipSubmittedAt: T_B,
      extractedData: JSON.stringify({ fileHash: B_FILE_HASH }),
    });

    expect(published).toBe(false);
    // Nothing about the finalized row changed - not the slip, not the
    // evidence, not the status.
    expect(harness.store.payments[0].slipImageUrl).toBe(A_URL);
    expect(harness.store.payments[0].status).toBe("approved");
    expect(JSON.parse(harness.store.payments[0].extractedData)).toEqual({
      referenceRaw: REFERENCE_A,
      referenceHash: HASH_A,
    });
  });
});
