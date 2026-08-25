/**
 * IPE-001 P2: "Record wallet outcomes after the version-guarded write"
 * (server/services/walletTopupSubmissionService.ts).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * Every non-auto-approve branch recorded its intended attempt-history outcome
 * (LOW_CONFIDENCE, AMOUNT_MISMATCH, MISSING_FIELDS, WEAK_DUPLICATE_RISK, a
 * technical failure, a config block, ...) BEFORE calling the handler that
 * performs the slip-version-guarded write (`db.applyWalletTopupOcrUpdate`).
 * If the customer replaced the slip mid-run, that guarded write is refused
 * and the function correctly reports `TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT` -
 * but the stale DATA/CONFIG/TECHNICAL row, describing findings about the OLD
 * slip, had already committed to attempt history.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Every such call site now passes the recorder AND its intended
 * (result, reason, category, confidence) into
 * handlePendingReview/handleDuplicate/handleOCRError, which record it
 * themselves - the intended DATA/CONFIG/TECHNICAL result if the guarded
 * write actually landed, or exactly one STATE result
 * (`TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT` / `..._BY_FINALIZATION`) if it was
 * refused. `buildSupersededResult` is the single place that performs this
 * STATE recording, reused by every handler.
 *
 * ── Why exercised behaviourally ───────────────────────────────────────────
 * Reuses the harness from walletSlipReplacementRace.test.ts: `db` is real,
 * driven by an in-memory store whose `update().where()` evaluates the actual
 * drizzle condition tree, so a lost CAS here means the same WHERE clause
 * would match zero rows against real MySQL. The concurrent replacement is
 * simulated as a side effect of the mocked `parseSlipImage` call resolving -
 * standing for a second request's publish landing while this run's OCR/
 * verification was still in flight, before the guarded write executes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ocr-slip-verification-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ocr-slip-verification-v2")>();
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

const recordedAttempts: Array<{
  result: string;
  reviewReason: string | null;
  reviewCategory: string | null;
  confidence: number | null;
}> = [];

vi.mock("./ocrAttemptService", () => ({
  recordOcrAttempt: vi.fn(async (input: any) => {
    recordedAttempts.push({
      result: input.result,
      reviewReason: input.reviewReason ?? null,
      reviewCategory: input.reviewCategory ?? null,
      confidence: input.confidence ?? null,
    });
    return recordedAttempts.length;
  }),
}));

import * as dbModule from "../db";
import { parseSlipImage, extractSlipData, verifySlipData } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { submitWalletTopupSlip } from "./walletTopupSubmissionService";
import { hashSlipReference } from "./slipIdentifierService";

const REFERENCE = "attempt-race-ref-001";
const HASH = hashSlipReference(REFERENCE)!;
const B_URL = "r2p:wallet-slips/12/slip-b.png";
const C_URL = "r2p:wallet-slips/12/slip-c.png";
const T_B = new Date("2026-01-01T00:00:00Z");

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
    execute: async () => {
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
        id: 901,
        userId: 12,
        requestedAmount: "300.00",
        bonusAmount: "0.00",
        creditedAmount: null,
        status,
        slipImageUrl: B_URL,
        slipSubmittedAt: T_B,
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

/** Mutates the store to look like a replacement (B -> C) already landed. */
function simulateReplacement(harness: ReturnType<typeof makeDb>) {
  harness.store.walletTopups[0].slipImageUrl = C_URL;
  harness.store.walletTopups[0].slipSubmittedAt = new Date("2026-01-02T00:00:00Z");
  harness.store.walletTopups[0].status = "pending";
}

/** Mutates the store to look like an admin finalized the top-up already. */
function simulateFinalization(harness: ReturnType<typeof makeDb>, status: "approved" | "rejected") {
  harness.store.walletTopups[0].status = status;
}

function baseOcrConfig(overrides: Partial<Record<string, unknown>> = {}) {
  (getEffectiveOCRConfig as any).mockResolvedValue({
    enabled: true,
    autoApproveEnabled: true,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
    ...overrides,
  });
}

function mockParseSuccess(mutate?: () => void) {
  (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
  (parseSlipImage as any).mockImplementation(async () => {
    mutate?.();
    return {
      text: `reference: ${REFERENCE}`,
      ocrConfidence: 95,
      confidenceKnown: true,
      technicalError: false,
    };
  });
  (computeSlipFileHash as any).mockResolvedValue("f".repeat(64));
}

describe("Wallet attempt history reflects the version that actually landed (IPE-001 P2)", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    recordedAttempts.length = 0;
  });

  it("A. LOW_CONFIDENCE on B, replaced with C before the guarded write -> ONE superseded attempt, no LOW_CONFIDENCE", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 40, amountMatched: true, referencePresent: true },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts[0].reviewCategory).toBe("STATE");
    expect(recordedAttempts.some((a) => a.reviewReason === "LOW_CONFIDENCE")).toBe(false);
  });

  it("B. AMOUNT_MISMATCH on B, replaced with C -> ONE superseded attempt, no AMOUNT_MISMATCH", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 999,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 95, amountMatched: false, referencePresent: true },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts.some((a) => a.reviewReason === "AMOUNT_MISMATCH")).toBe(false);
  });

  it("C. MISSING_FIELDS on B, replaced with C -> ONE superseded attempt, no MISSING_FIELDS", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
    (extractSlipData as any).mockReturnValue({
      reference: undefined,
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 95, amountMatched: true, referencePresent: false },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts.some((a) => a.reviewReason === "MISSING_FIELDS")).toBe(false);
  });

  it("D. duplicate risk on B, replaced with C -> ONE superseded attempt, no WEAK_DUPLICATE_RISK", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: "DUPLICATE_REFERENCE",
      breakdown: { ocrConfidence: 95, amountMatched: true, referencePresent: true },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts.some((a) => a.reviewReason === "WEAK_DUPLICATE_RISK")).toBe(false);
  });

  it("E. technical error on B, replaced with C before the technical-review write -> STATE, not TECHNICAL attributed to C", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
    (parseSlipImage as any).mockImplementation(async () => {
      simulateReplacement(harness);
      return {
        text: "",
        technicalError: true,
        technicalErrorCode: "OCR_PROVIDER_TIMEOUT",
        providerDiagnostic: { code: "OCR_PROVIDER_TIMEOUT", providerMode: "generic" },
      };
    });
    (computeSlipFileHash as any).mockResolvedValue("f".repeat(64));

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].result).toBe("needs_review");
    expect(recordedAttempts[0].reviewCategory).toBe("STATE");
    expect(recordedAttempts.some((a) => a.result === "technical_failure")).toBe(false);
  });

  it("F. shadow-mode run on B performs a guarded write, replaced with C -> STATE superseded", async () => {
    baseOcrConfig({ shadowModeEnabled: true });
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].reviewCategory).toBe("STATE");
    expect(recordedAttempts.some((a) => a.reviewReason === "SHADOW_MODE")).toBe(false);
  });

  it("G. unchanged slip + LOW_CONFIDENCE -> exactly one LOW_CONFIDENCE attempt", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess();
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 40, amountMatched: true, referencePresent: true },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("LOW_CONFIDENCE");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].result).toBe("needs_review");
    expect(recordedAttempts[0].reviewReason).toBe("LOW_CONFIDENCE");
    expect(recordedAttempts[0].reviewCategory).toBe("DATA");
  });

  it("H. unchanged slip + provider failure -> exactly one TECHNICAL attempt with sanitized metadata", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
    (parseSlipImage as any).mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:443"), { code: "ECONNREFUSED" })
    );
    (computeSlipFileHash as any).mockResolvedValue("f".repeat(64));

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.status).toBe("pending_review");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].result).toBe("technical_failure");
    expect(recordedAttempts[0].reviewCategory).toBe("TECHNICAL");
    // The raw error message (which could carry an IP/endpoint) never reaches
    // the sanitized reviewReason recorded to history.
    expect(recordedAttempts[0].reviewReason).not.toMatch(/10\.0\.0\.5/);
  });

  it("I. successful auto-approval records auto_approved exactly once, after the credit commits", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess();
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

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.status).toBe("approved");
    expect(harness.store.walletAccounts).toHaveLength(1);
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].result).toBe("auto_approved");
  });

  it("J. auto-approval slip-version race -> ONE superseded attempt, no auto_approved, no claim, no credit", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
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

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].reviewCategory).toBe("STATE");
    expect(recordedAttempts.some((a) => a.result === "auto_approved")).toBe(false);
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
  });

  it("K. finalization race (LOW_CONFIDENCE branch) -> STATE/finalization, no stale DATA attempt", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateFinalization(harness, "approved"));
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 40, amountMatched: true, referencePresent: true },
    });

    const result = await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_FINALIZATION");
    expect(recordedAttempts).toHaveLength(1);
    expect(recordedAttempts[0].reviewReason).toBe("TOPUP_SUPERSEDED_BY_FINALIZATION");
    expect(recordedAttempts[0].reviewCategory).toBe("STATE");
    expect(recordedAttempts.some((a) => a.reviewReason === "LOW_CONFIDENCE")).toBe(false);
  });
});

describe("exactly-once attempt semantics: never a stale DATA/TECHNICAL row alongside STATE", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    recordedAttempts.length = 0;
  });

  it("a superseded run never produces two attempt rows for one invocation", async () => {
    baseOcrConfig();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);
    mockParseSuccess(() => simulateReplacement(harness));
    (extractSlipData as any).mockReturnValue({
      referenceRaw: REFERENCE,
      reference: REFERENCE.toUpperCase(),
      amount: 300,
      confidenceKnown: true,
    });
    (verifySlipData as any).mockReturnValue({
      isAutoApproved: false,
      status: "pending",
      reviewReason: undefined,
      breakdown: { ocrConfidence: 40, amountMatched: true, referencePresent: true },
    });

    await submitWalletTopupSlip(12, 901, "300.00", B_URL);

    expect(recordedAttempts).toHaveLength(1);
    const kinds = new Set(recordedAttempts.map((a) => a.reviewCategory));
    expect(kinds).toEqual(new Set(["STATE"]));
  });
});
