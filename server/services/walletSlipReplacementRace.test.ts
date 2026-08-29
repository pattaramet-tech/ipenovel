/**
 * IPE-001: "Bind wallet OCR identifiers to the current slip" (Codex P1,
 * server/services/walletTopupSubmissionService.ts) - wallet parity with the
 * order-side slip-version binding (publishReplacementSlipIfReviewable /
 * lockAndRequireReviewablePayment's expectedSlipVersion /
 * SlipVersionChangedError).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `wallet.uploadTopupSlip` (the deprecated replace-slip endpoint) wrote only
 * `slipImageUrl` via `db.updateWalletTopupSlip`, unconditionally, and never
 * re-ran OCR. `submitWalletTopupSlip`'s own downstream writes
 * (`approveWalletTopupWithOCR`, `applyWalletTopupOcrUpdate`) CAS'd on status
 * alone. A replacement re-opens status to "pending" without changing it
 * further, so a slow OCR run for slip A could still claim/credit/write A's
 * evidence after the customer replaced A with B - the top-up detail then
 * displays B while A's identifiers were consumed, and B is left completely
 * unclaimed and reusable.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * `db.publishWalletTopupReplacementIfReviewable` atomically invalidates the
 * old extraction and seeds the new slip's fileHash in the same write.
 * `submitWalletTopupSlip` captures `expectedSlipVersion` from the row it
 * loaded and threads it through every downstream write
 * (`approveWalletTopupWithOCR`, `applyWalletTopupOcrUpdate`); a mismatch
 * throws `WalletSlipClaimError("TOPUP_SLIP_VERSION_CHANGED")` /  refuses the
 * conditional write, and `buildSupersededResult` reports
 * `TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT`.
 *
 * ── Why this is exercised behaviourally ───────────────────────────────────
 * `db` and `walletTopupSubmissionService` are REAL, driven by an in-memory
 * connection whose `update().where()` actually evaluates the drizzle
 * condition tree - a lost CAS here means the same WHERE clause would match
 * zero rows against real MySQL. `approveWalletTopupWithOCR` has no explicit
 * row lock (unlike the order side's `lockPaymentForUpdate`), so the
 * concurrent replacement is simulated as a side effect of the mocked OCR
 * provider call resolving - standing for a second request's publish landing
 * while this run's provider call was in flight, before its transaction ever
 * opens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ocr-slip-verification-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ocr-slip-verification-v2")>();
  // extractSlipData/verifySlipData are mocked too (not just parseSlipImage):
  // unlike the order side's submitPaymentSlip, submitWalletTopupSlip calls
  // these REAL text-parsing/verification functions directly rather than
  // going through a single pre-verified processSlipVerificationStaging()
  // result, so a raw OCR-text fixture would need to satisfy the real bank-
  // format regexes - controlling the verification outcome directly is more
  // robust and keeps this test about the race, not about parser fixtures.
  return { ...actual, parseSlipImage: vi.fn(), extractSlipData: vi.fn(), verifySlipData: vi.fn() };
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
vi.mock("./discordNotificationService", () => ({
  sendOCRReviewNotification: vi.fn(async () => {}),
}));
vi.mock("./ocrAttemptService", () => ({
  recordOcrAttempt: vi.fn(async () => 1),
}));

import * as dbModule from "../db";
import { parseSlipImage, extractSlipData, verifySlipData } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { submitWalletTopupSlip } from "./walletTopupSubmissionService";
import { hashSlipReference } from "./slipIdentifierService";

const REFERENCE = "wallet-race-ref-001";
const HASH = hashSlipReference(REFERENCE)!;
const A_URL = "r2p:wallet-slips/11/slip-a.png";
const B_URL = "r2p:wallet-slips/11/slip-b.png";
const C_URL = "r2p:wallet-slips/11/slip-c.png";
const T_A = new Date("2026-01-01T00:00:00Z");

function tableName(table: any): string {
  return String(table?.[Symbol.for("drizzle:Name")] ?? "");
}

function boundHashes(cond: any): string[] {
  const found: string[] = [];
  const walk = (n: any, d = 0) => {
    if (!n || d > 12) return;
    if (typeof n === "string" && /^[0-9a-f]{64}$/.test(n)) found.push(n);
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
                then: (resolve: any, reject: any) => Promise.resolve(filtered).then(resolve, reject),
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

function walletRows(status = "pending") {
  return {
    walletTopups: [
      {
        id: 900,
        userId: 11,
        requestedAmount: "300.00",
        bonusAmount: "0.00",
        creditedAmount: null,
        status,
        slipImageUrl: A_URL,
        slipSubmittedAt: T_A,
        extractedData: null,
      },
    ],
    walletAccounts: [] as any[],
    walletTransactions: [] as any[],
    topupLogs: [] as any[],
    paymentSlipClaims: [] as any[],
    payments: [] as any[],
  };
}

function mockAutoApprovingOcrPipeline() {
  (getEffectiveOCRConfig as any).mockResolvedValue({
    enabled: true,
    autoApproveEnabled: true,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
  });
  (computeSlipFileHash as any).mockResolvedValue("f".repeat(64));
  (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
  (parseSlipImage as any).mockResolvedValue({
    text: `reference: ${REFERENCE}`,
    ocrConfidence: 95,
    confidenceKnown: true,
    technicalError: false,
  });
  (extractSlipData as any).mockReturnValue({
    referenceRaw: REFERENCE,
    reference: REFERENCE.toUpperCase(),
    referenceHash: HASH,
    amount: 300,
    confidenceKnown: true,
  });
  (verifySlipData as any).mockReturnValue({
    isAutoApproved: true,
    status: "approved",
    reviewReason: undefined,
    breakdown: { ocrConfidence: 95, amountMatched: true, referencePresent: true },
  });
}

describe("Wallet OCR identifiers are bound to the current slip (IPE-001)", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("F. slip replaced while THIS OCR run's provider call is in flight -> refused, C stays authoritative", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    // The replacement lands as a side effect of the mocked provider call
    // resolving - standing for a second request's publish completing while
    // THIS run's OCR was still in flight, before its own transaction opens.
    (parseSlipImage as any).mockImplementation(async () => {
      harness.store.walletTopups[0].slipImageUrl = C_URL;
      harness.store.walletTopups[0].slipSubmittedAt = new Date("2026-01-02T00:00:00Z");
      harness.store.walletTopups[0].extractedData = JSON.stringify({ fileHash: "c".repeat(64) });
      harness.store.walletTopups[0].status = "pending";
      return {
        text: `reference: ${REFERENCE}`,
        ocrConfidence: 95,
        confidenceKnown: true,
        technicalError: false,
      };
    });

    const result = await submitWalletTopupSlip(11, 900, "300.00", A_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(result.supersededByFinalization).toBe(false);
    // A replacement publish sets status back to "pending" (not
    // "pending_review") - exactly what the simulated concurrent publish set.
    expect(result.status).toBe("pending");

    // C's row is completely untouched by A's (superseded) OCR run.
    expect(harness.store.walletTopups[0].slipImageUrl).toBe(C_URL);
    expect(harness.store.walletTopups[0].status).toBe("pending");
    expect(JSON.parse(harness.store.walletTopups[0].extractedData)).toEqual({
      fileHash: "c".repeat(64),
    });
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
    expect(harness.store.walletTransactions).toHaveLength(0);
  });

  it("C. top-up already finalized -> auto-approval refused, no claim, no credit", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    (parseSlipImage as any).mockImplementation(async () => {
      harness.store.walletTopups[0].status = "approved";
      return {
        text: `reference: ${REFERENCE}`,
        ocrConfidence: 95,
        confidenceKnown: true,
        technicalError: false,
      };
    });

    const result = await submitWalletTopupSlip(11, 900, "300.00", A_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_FINALIZATION");
    expect(result.supersededByFinalization).toBe(true);
    expect(result.status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
  });

  it("G. unchanged slip -> auto-approval claims and credits exactly once", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    const result = await submitWalletTopupSlip(11, 900, "300.00", A_URL);

    expect(result.status).toBe("approved");
    expect(harness.store.walletTopups[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
    expect(harness.store.walletAccounts).toHaveLength(1);
    expect(harness.store.walletTransactions).toHaveLength(1);
  });
});

describe("Wallet slip replacement publish is atomic and version-bound (IPE-001)", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
  });

  it("A/B. publishing B invalidates A's identifiers in the SAME write - a later admin approval can only use B's", async () => {
    const harness = makeDb({
      ...walletRows("pending"),
      walletTopups: [
        {
          id: 900,
          userId: 11,
          requestedAmount: "300.00",
          bonusAmount: "0.00",
          creditedAmount: null,
          status: "pending",
          slipImageUrl: A_URL,
          slipSubmittedAt: T_A,
          extractedData: JSON.stringify({ referenceRaw: REFERENCE, referenceHash: HASH }),
        },
      ],
    });
    dbModule.__setDbForTests(harness.fake);

    const published = await dbModule.publishWalletTopupReplacementIfReviewable(900, {
      slipImageUrl: B_URL,
      slipSubmittedAt: new Date("2026-01-02T00:00:00Z"),
      extractedData: JSON.stringify({ fileHash: "b".repeat(64) }),
    });
    expect(published).toBe(true);

    const afterPublish = JSON.parse(harness.store.walletTopups[0].extractedData);
    expect(afterPublish).toEqual({ fileHash: "b".repeat(64) });
    expect(afterPublish.referenceHash).toBeUndefined();
    expect(harness.store.walletTopups[0].slipImageUrl).toBe(B_URL);
    expect(harness.store.walletTopups[0].status).toBe("pending");

    // IPE-001-C09: manual approval now re-hashes the CURRENT stored bytes
    // before claiming - stand in for B's real bytes hashing to what was just
    // published for B, so this test still exercises the intended "B's
    // identifiers, not A's" scenario rather than failing on an unrelated
    // hash-fetch-unavailable path.
    (computeSlipFileHash as any).mockResolvedValue("b".repeat(64));

    await dbModule.approveWalletTopup(900, 1);

    expect(harness.store.walletTopups[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].fileHash).toBe("b".repeat(64));
    expect(harness.store.paymentSlipClaims[0].referenceHash ?? null).not.toBe(HASH);
  });

  it("C. top-up already finalized -> replacement publish refused, never reopens it", async () => {
    const harness = makeDb(walletRows("approved"));
    dbModule.__setDbForTests(harness.fake);

    const published = await dbModule.publishWalletTopupReplacementIfReviewable(900, {
      slipImageUrl: B_URL,
      slipSubmittedAt: new Date("2026-01-02T00:00:00Z"),
      extractedData: JSON.stringify({ fileHash: "b".repeat(64) }),
    });

    expect(published).toBe(false);
    expect(harness.store.walletTopups[0].slipImageUrl).toBe(A_URL);
    expect(harness.store.walletTopups[0].status).toBe("approved");
  });
});
