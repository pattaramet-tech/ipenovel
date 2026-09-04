/**
 * IPE-001-C10: behavioral evidence for the C09 current-byte integrity gate.
 *
 * C09 added a re-hash-before-claim checkpoint to orderService.ts's
 * approvePaymentInTx and db.ts's approveWalletTopup (see
 * manualApprovalCurrentByteIntegrity.test.ts for the structural pins). That
 * file only proves the SOURCE has the checkpoint in the right place; it does
 * not prove the checkpoint actually blocks a real approval or actually binds
 * a real claim. This file drives the REAL production functions - `db` and
 * `orderService` are genuine, not mocked - through the same in-memory
 * transaction harness pattern already established by
 * slipReplacementPublishRace.test.ts and walletSlipReplacementRace.test.ts,
 * and asserts on the resulting side effects (or their absence): claims,
 * purchases, points, wallet credit, order/topup finalization.
 *
 * `computeSlipFileHash` is mocked because it fetches a signed URL and
 * downloads the object - unavailable against this test's fake "r2p:" URLs -
 * exactly as the two files above already do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./services/slipFileHashService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/slipFileHashService")>();
  return { ...actual, computeSlipFileHash: vi.fn(), computeTrustedLegacySlipFileHash: vi.fn() };
});

import * as dbModule from "./db";
import * as orderService from "./services/orderService";
import { hashSlipReference } from "./services/slipIdentifierService";
import * as backfillState from "./services/slipBackfillStateService";
import { computeSlipFileHash, computeTrustedLegacySlipFileHash } from "./services/slipFileHashService";

const REFERENCE = "manual-approval-c10-ref";
const HASH = hashSlipReference(REFERENCE)!;
const SLIP_URL = "r2p:manual-approval-c10/slip.png";
const CURRENT_HASH = "c".repeat(64);
const STALE_HASH = "a".repeat(64);
const SUBMITTED_AT = new Date("2026-01-01T00:00:00Z");

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

/** Same fake-connection shape used by slipReplacementPublishRace.test.ts /
 * walletSlipReplacementRace.test.ts: update().where() actually evaluates the
 * drizzle condition tree, and select() supports the hash-lookup the claim
 * registry needs. */
function makeDb(rows: Record<string, any[]>) {
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(rows));
  let snapshot: Record<string, any[]> = JSON.parse(JSON.stringify(store));

  const executor = (): any => ({
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) return [[]];
      if (queryText.includes("FROM users")) return [[{ id: 1 }]];
      snapshot = JSON.parse(JSON.stringify(store));
      return [[{ id: 1 }]];
    },
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          return {
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
                orderBy: () => ({
                  limit: async (n?: number) => (n ? filtered.slice(0, n) : filtered),
                  then: (resolve: any, reject: any) => Promise.resolve(filtered).then(resolve, reject),
                }),
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

function orderRows(overrides: { extractedData: string | null }) {
  return {
    payments: [
      {
        id: 700,
        orderId: 90,
        status: "pending",
        slipImageUrl: SLIP_URL,
        slipSubmittedAt: SUBMITTED_AT,
        evidenceVersion: 0,
        extractedData: overrides.extractedData,
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

function walletRows(overrides: { extractedData: string | null }) {
  return {
    walletTopups: [
      {
        id: 900,
        userId: 11,
        requestedAmount: "300.00",
        bonusAmount: "0.00",
        creditedAmount: "300.00",
        status: "pending",
        slipImageUrl: SLIP_URL,
        slipSubmittedAt: SUBMITTED_AT,
        evidenceVersion: 0,
        extractedData: overrides.extractedData,
      },
    ],
    walletAccounts: [] as any[],
    walletTransactions: [] as any[],
    topupLogs: [] as any[],
    paymentSlipClaims: [] as any[],
    payments: [] as any[],
  };
}

describe("Order approvePayment: current-byte integrity is REAL, IPE-001-C10", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("A. persisted fileHash A + current bytes B -> rejected, zero claim/purchase/points/history, payment stays pending", async () => {
    const harness = makeDb(
      orderRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await expect(orderService.approvePayment(700, "admin-1", "Admin")).rejects.toThrow(
      /SLIP_INTEGRITY_MISMATCH_AT_APPROVAL/
    );

    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
    expect(harness.store.orders[0].status).toBe("pending");
  });

  it("B. current bytes unavailable -> rejected before any claim/value", async () => {
    const harness = makeDb(
      orderRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(undefined);

    await expect(orderService.approvePayment(700, "admin-1", "Admin")).rejects.toThrow(
      /SLIP_CURRENT_BYTES_UNAVAILABLE/
    );

    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
  });

  it("C. trusted legacy CDN URL approves only after current bytes verify and still claims the fresh hash", async () => {
    const rows = orderRows({
      extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: CURRENT_HASH }),
    });
    rows.payments[0].slipImageUrl = "https://d2xsxph8kpxj0f.cloudfront.net/slips/700.png";
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);
    (computeTrustedLegacySlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await orderService.approvePayment(700, "admin-1", "Admin");

    expect(computeSlipFileHash).not.toHaveBeenCalled();
    expect(computeTrustedLegacySlipFileHash).toHaveBeenCalledWith(rows.payments[0].slipImageUrl, {
      timeoutMs: 3_000,
    });
    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(CURRENT_HASH);
  });

  it("C2. changed trusted legacy CDN bytes fail closed before claim/value", async () => {
    const rows = orderRows({
      extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }),
    });
    rows.payments[0].slipImageUrl = "https://d2xsxph8kpxj0f.cloudfront.net/slips/700.png";
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);
    (computeTrustedLegacySlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await expect(orderService.approvePayment(700, "admin-1", "Admin")).rejects.toThrow(
      /SLIP_INTEGRITY_MISMATCH_AT_APPROVAL/
    );
    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
  });

  it("C3. untrusted legacy URL cannot become an SSRF bypass and fails closed", async () => {
    const rows = orderRows({
      extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: CURRENT_HASH }),
    });
    rows.payments[0].slipImageUrl = "https://legacy-storage.example/slips/700.png";
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);
    (computeTrustedLegacySlipFileHash as any).mockResolvedValue(undefined);

    await expect(orderService.approvePayment(700, "admin-1", "Admin")).rejects.toThrow(
      /SLIP_CURRENT_BYTES_UNAVAILABLE/
    );
    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
  });

  it("D. stable A -> A: approves exactly once, claimed fileHash equals the fresh current hash", async () => {
    const harness = makeDb(
      orderRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: CURRENT_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await orderService.approvePayment(700, "admin-1", "Admin");

    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(CURRENT_HASH);
  });

  it("D. reference-only persisted extraction + current file hash -> enriches and claims the fresh file hash", async () => {
    const harness = makeDb(
      orderRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await orderService.approvePayment(700, "admin-1", "Admin");

    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
    // The persisted extraction NEVER carried a fileHash - this was bound
    // fresh, atomically, by the C09 checkpoint.
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(CURRENT_HASH);
  });

  it("E. confirmed-distinct legacy-case resolution cannot bypass a same-URL mismatch", async () => {
    const harness = makeDb(
      orderRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await expect(
      orderService.approvePayment(700, "admin-1", "Admin", undefined, {
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: "d".repeat(64),
          expectedMatchedSourceType: "order_payment",
          expectedMatchedSourceId: 1,
          expectedIncomingReferenceHash: HASH,
        },
      })
    ).rejects.toThrow(/SLIP_INTEGRITY_MISMATCH_AT_APPROVAL/);

    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
  });
});

describe("Wallet approveWalletTopup: current-byte integrity is REAL, IPE-001-C10", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("A. persisted fileHash A + current bytes B -> rejected, zero claim/credit/finalization, top-up stays pending", async () => {
    const harness = makeDb(
      walletRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    // WalletSlipClaimError carries the code as a property, not in .message.
    await expect(dbModule.approveWalletTopup(900, 1)).rejects.toMatchObject({
      code: "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL",
    });

    expect(harness.store.walletTopups[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletTransactions).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
  });

  it("B. current bytes unavailable -> rejected before any claim/credit", async () => {
    const harness = makeDb(
      walletRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(undefined);

    await expect(dbModule.approveWalletTopup(900, 1)).rejects.toMatchObject({
      code: "SLIP_CURRENT_BYTES_UNAVAILABLE",
    });

    expect(harness.store.walletTopups[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletTransactions).toHaveLength(0);
  });

  it("C. stable A -> A: approves exactly once, claimed fileHash equals the fresh current hash, credited once", async () => {
    const harness = makeDb(
      walletRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: CURRENT_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await dbModule.approveWalletTopup(900, 1);

    expect(harness.store.walletTopups[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(CURRENT_HASH);
    expect(harness.store.walletTransactions).toHaveLength(1);
  });

  it("D. reference-only persisted extraction + current file hash -> enriches and claims the fresh file hash", async () => {
    const harness = makeDb(
      walletRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await dbModule.approveWalletTopup(900, 1);

    expect(harness.store.walletTopups[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe(CURRENT_HASH);
  });

  it("E. confirmed-distinct legacy-case resolution cannot bypass a same-URL mismatch", async () => {
    const harness = makeDb(
      walletRows({ extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH, fileHash: STALE_HASH }) })
    );
    dbModule.__setDbForTests(harness.fake);
    (computeSlipFileHash as any).mockResolvedValue(CURRENT_HASH);

    await expect(
      dbModule.approveWalletTopup(900, 1, {
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: "d".repeat(64),
          expectedMatchedSourceType: "wallet_topup",
          expectedMatchedSourceId: 1,
          expectedIncomingReferenceHash: HASH,
        },
      })
    ).rejects.toMatchObject({ code: "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL" });

    expect(harness.store.walletTopups[0].status).toBe("pending");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletTransactions).toHaveLength(0);
  });
});
