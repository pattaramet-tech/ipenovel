/**
 * IPE-001 P1: "Guard the wallet approval write with the slip version"
 * (server/db.ts `approveWalletTopupWithOCR`).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * `approveWalletTopupWithOCR` read the top-up row WITHOUT locking it, then
 * compared `expectedSlipVersion` against that unlocked read. The version
 * comparison itself was correct - the defect was atomicity. A customer could
 * publish a replacement slip B in the window AFTER that unlocked read but
 * BEFORE the claim/final-approval write. A replacement re-opens status to
 * "pending" without touching it further, so the later status-only CAS
 * (`WHERE id = ? AND status = 'pending'`) would still match - claiming and
 * crediting slip A's evidence onto a row whose CURRENT slip is B, leaving B
 * completely unclaimed and reusable.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * `approveWalletTopupWithOCR` now calls `lockWalletTopupForUpdate(topupId,
 * tx)` as Step 0, BEFORE reading the row the version check validates against
 * - serializing this transaction against the replacement publisher, which
 * takes the same lock. As defense-in-depth, the final approval UPDATE's
 * WHERE clause also re-binds the expected slip version, so this write never
 * depends solely on a pre-lock read remaining correct.
 *
 * ── Why this is exercised behaviourally, and how it differs from the
 * existing "F. slip replaced ... in flight" race test ──────────────────────
 * That existing test (walletSlipReplacementRace.test.ts) mutates the slip
 * BEFORE the transaction ever opens (during the mocked `parseSlipImage`
 * call) - a window the unlocked version check already closed correctly. THIS
 * file targets the window the previous fix DIDN'T close: the mutation lands
 * AFTER the transaction has already read and validated the row, but BEFORE
 * the financial approval write would commit - simulated as a side effect of
 * `claimSlip`'s own insert (which the real transaction does perform between
 * the version check and the final CAS), standing for a second transaction's
 * publish committing independently in that exact gap.
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

const REFERENCE = "atomic-gate-ref-001";
const HASH = hashSlipReference(REFERENCE)!;
const A_URL = "r2p:wallet-slips/13/slip-a.png";
const B_URL = "r2p:wallet-slips/13/slip-b.png";
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

/** Column-name-only match (ignores value), for detecting an `isNull(...)` leaf. */
function collectIsNullColumns(node: any, out: Set<string>, depth = 0) {
  if (!node || depth > 20) return;
  if (Array.isArray(node)) {
    for (const n of node) collectIsNullColumns(n, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const chunks = node.queryChunks;
  if (Array.isArray(chunks)) {
    const sqlText = chunks
      .map((c: any) => (typeof c?.value?.[0] === "string" ? c.value[0] : ""))
      .join("");
    if (/is null/i.test(sqlText)) {
      for (const c of chunks) {
        if (c && typeof c === "object" && typeof c.name === "string") out.add(c.name);
      }
    }
  }
  if (chunks) collectIsNullColumns(chunks, out, depth + 1);
}

function matchesWhere(cond: any, row: Record<string, any>): boolean {
  const leaves: { column: string; value: unknown }[] = [];
  collectEqLeaves(cond, leaves);
  const isNullCols = new Set<string>();
  collectIsNullColumns(cond, isNullCols);

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
  for (const column of isNullCols) {
    if (row[column] !== null && row[column] !== undefined) return false;
  }
  return true;
}

function makeDb(
  rows: Record<string, any[]>,
  hooks: { onLock?: () => void; onClaimInsert?: () => void } = {}
) {
  const store: Record<string, any[]> = structuredClone(rows);
  let snapshot: Record<string, any[]> = structuredClone(store);

  const executor = (): any => ({
    execute: async () => {
      // Stands for `SELECT ... FOR UPDATE` - Step 0 of the fix.
      hooks.onLock?.();
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
          if (name === "paymentSlipClaims") hooks.onClaimInsert?.();
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
        id: 1300,
        userId: 13,
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

describe("Wallet OCR auto-approval is atomic against a mid-transaction replacement (IPE-001 P1)", () => {
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("the exact NEW window: replacement lands AFTER the version check, BEFORE the final approval write -> refused, no stale claim, no stale credit", async () => {
    mockAutoApprovingOcrPipeline();
    let replaced = false;
    const harness = makeDb(walletRows("pending"), {
      onClaimInsert: () => {
        // Stands for a second transaction's publishWalletTopupReplacementIfReviewable
        // committing independently, in the gap between this transaction's
        // version check (already passed, using slip A) and its final
        // approval write - which this test proves must NOT then commit A's
        // claim/credit onto a row whose current slip is B.
        replaced = true;
        harness.store.walletTopups[0].slipImageUrl = B_URL;
        harness.store.walletTopups[0].slipSubmittedAt = new Date("2026-01-02T00:00:00Z");
        harness.store.walletTopups[0].status = "pending";
      },
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitWalletTopupSlip(13, 1300, "300.00", A_URL);

    expect(replaced).toBe(true);
    // The financial invariant: never slip=B with A's claim/credit landed.
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
    expect(harness.store.walletTransactions).toHaveLength(0);
    // The approval write must not have landed for A either.
    expect(result.status).not.toBe("approved");
  });

  it("Case A: replacement commits BEFORE the lock is acquired -> TOPUP_SLIP_VERSION_CHANGED, current slip (B) untouched", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"), {
      onLock: () => {
        harness.store.walletTopups[0].slipImageUrl = B_URL;
        harness.store.walletTopups[0].slipSubmittedAt = new Date("2026-01-02T00:00:00Z");
        harness.store.walletTopups[0].status = "pending";
      },
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitWalletTopupSlip(13, 1300, "300.00", A_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
    expect(harness.store.walletTopups[0].slipImageUrl).toBe(B_URL);
  });

  it("Case C: the top-up was finalized before the lock is acquired -> refused, not reopened", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"), {
      onLock: () => {
        harness.store.walletTopups[0].status = "approved";
      },
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitWalletTopupSlip(13, 1300, "300.00", A_URL);

    expect(result.reviewReason).toBe("TOPUP_SUPERSEDED_BY_FINALIZATION");
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.walletAccounts).toHaveLength(0);
  });

  it("the row is locked BEFORE the version-defining read (Step 0 precedes Step 1)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const code = fs
      .readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const start = code.indexOf("export async function approveWalletTopupWithOCR(");
    const end = code.indexOf("\nexport async function ", start + 10);
    const body = code.slice(start, end);
    const lockIdx = body.indexOf("await lockWalletTopupForUpdate(topupId, tx)");
    const readIdx = body.indexOf(
      "const topupResult = await tx.select().from(walletTopups).where(eq(walletTopups.id, topupId)).limit(1);"
    );
    expect(lockIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(lockIdx);
  });

  it("the final approval write re-binds the expected slip version as defense-in-depth", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const code = fs
      .readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const start = code.indexOf("export async function approveWalletTopupWithOCR(");
    const end = code.indexOf("\nexport async function ", start + 10);
    const body = code.slice(start, end);
    const conditionsIdx = body.indexOf("const approveConditions = [");
    expect(conditionsIdx).toBeGreaterThan(-1);
    const block = body.slice(conditionsIdx, conditionsIdx + 700);
    expect(block).toMatch(/expectedSlipVersion\.slipImageUrl/);
    expect(block).toMatch(/expectedSlipVersion\.slipSubmittedAt/);
    expect(body).toMatch(/\.where\(and\(\.\.\.approveConditions\)\)/);
  });

  it("a genuinely unchanged slip still auto-approves and credits exactly once", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(walletRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    const result = await submitWalletTopupSlip(13, 1300, "300.00", A_URL);

    expect(result.status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
    expect(harness.store.walletAccounts).toHaveLength(1);
    expect(harness.store.walletTransactions).toHaveLength(1);
  });
});
