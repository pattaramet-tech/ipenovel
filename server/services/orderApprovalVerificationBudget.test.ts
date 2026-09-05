import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrderApprovalVerificationBudget,
  OrderApprovalVerificationTimeoutError,
} from "../helpers/orderApprovalExecution";
import { findLegacyApprovedDuplicate } from "./legacySlipCompatibilityService";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import { claimSlip } from "./slipClaimService";
import { hashSlipReference } from "./slipIdentifierService";
import * as fileHashes from "./slipFileHashService";

const INCOMING_HASH = "a".repeat(64);
const HISTORICAL_HASH = "b".repeat(64);
const SELF = { sourceType: "order_payment" as const, sourceId: 9_999 };
type HistoricalRow = { id: number; status: string; extractedData: string | null; slipImageUrl: string | null };
type PageRead = { table: string; kind: "duplicate" | "alias"; cursor: number };

function boundComparison(node: any, column: string, operator: string): unknown {
  const chunks = node?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  if (chunks[1]?.name === column && chunks[2]?.value?.[0] === operator) return chunks[3]?.value;
  for (const child of chunks) {
    const found = boundComparison(child, column, operator);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Executes real scanner/evaluator/claim logic; only storage transport is fake. */
function makeTx(options: {
  payments?: HistoricalRow[];
  walletTopups?: HistoricalRow[];
  complete?: boolean;
  pageTransform?: (read: PageRead, page: HistoricalRow[]) => HistoricalRow[];
  onIndexedRead?: (table: string) => void;
} = {}) {
  const pages: PageRead[] = [];
  const inserted: unknown[] = [];
  const tx = {
    execute: vi.fn(async () => [[{ value: JSON.stringify({ complete: options.complete ?? false }) }]]),
    insert: vi.fn(() => ({ values: async (value: unknown) => {
      inserted.push(value);
      return [{ insertId: inserted.length }];
    } })),
    select(projection?: Record<string, unknown>) {
      return { from(table: any) {
        const tableName = String(table[Symbol.for("drizzle:Name")]);
        const rows = tableName === "payments" ? options.payments ?? []
          : tableName === "walletTopups" ? options.walletTopups ?? [] : [];
        const indexed = async () => {
          options.onIndexedRead?.(tableName);
          return [];
        };
        return {
          limit: indexed,
          where(condition: any) {
            return {
              limit: indexed,
              orderBy() {
                return { limit: async (count: number) => {
                  const cursor = Number(boundComparison(condition, "id", " > "));
                  expect(Number.isFinite(cursor)).toBe(true);
                  expect(boundComparison(condition, "status", " = ")).toBe("approved");
                  const read: PageRead = {
                    table: tableName,
                    kind: projection && "slipImageUrl" in projection ? "duplicate" : "alias",
                    cursor,
                  };
                  pages.push(read);
                  const page = rows.filter((row) => row.status === "approved" && row.id > cursor)
                    .sort((a, b) => a.id - b.id).slice(0, count);
                  return options.pageTransform?.(read, page) ?? page;
                } };
              },
            };
          },
        };
      } };
    },
  };
  return { tx, pages, inserted };
}

function historicalRows(count: number): HistoricalRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    status: "approved",
    extractedData: null,
    slipImageUrl: `r2p:payment-slips/history/${index + 1}.png`,
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("one cooperative verification budget across the real legacy pipeline", () => {
  it("many individually fast hash reads exhaust the same budget before later rows are fetched", async () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    const hash = vi.spyOn(fileHashes, "computeSlipFileHash").mockImplementation(async () => {
      now += 1_000;
      return HISTORICAL_HASH;
    });
    const harness = makeTx({ payments: historicalRows(30) });

    await expect(findLegacyApprovedDuplicate({ fileHash: INCOMING_HASH }, SELF, harness.tx, budget))
      .rejects.toBeInstanceOf(OrderApprovalVerificationTimeoutError);

    expect(hash).toHaveBeenCalledTimes(15);
    expect(hash.mock.calls.map((call) => call[0])).toEqual(
      Array.from({ length: 15 }, (_, index) => `r2p:payment-slips/history/${index + 1}.png`)
    );
    expect(hash.mock.calls.every((call, index) =>
      call[1]?.timeoutMs === Math.min(fileHashes.SLIP_HASH_FETCH_TIMEOUT_MS, 15_000 - index * 1_000)
    )).toBe(true);
    expect(harness.pages).toEqual([{ table: "payments", kind: "duplicate", cursor: 0 }]);
    expect(harness.tx.insert).not.toHaveBeenCalled();
  });

  it("a hash returning undefined at expiry is a timeout, not an unresolved row followed by more scanning", async () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    const hash = vi.spyOn(fileHashes, "computeSlipFileHash").mockImplementation(async () => {
      now = 15_000;
      return undefined;
    });
    const harness = makeTx({ payments: historicalRows(3) });

    await expect(findLegacyApprovedDuplicate({ fileHash: INCOMING_HASH }, SELF, harness.tx, budget))
      .rejects.toBeInstanceOf(OrderApprovalVerificationTimeoutError);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(harness.pages).toHaveLength(1);
  });

  it("an ordinary undefined hash before expiry still preserves the existing unresolved protection", async () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    vi.spyOn(fileHashes, "computeSlipFileHash").mockImplementation(async () => {
      now = 100;
      return undefined;
    });
    const harness = makeTx({ payments: historicalRows(1) });

    await expect(findLegacyApprovedDuplicate({ fileHash: INCOMING_HASH }, SELF, harness.tx, budget))
      .resolves.toMatchObject({ sourceId: 1, sourceType: "order_payment", matchedBy: "unresolved" });
  });

  it("the evaluator passes the same deadline to its second alias scan and stops between pages", async () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    const rows = historicalRows(501).map((row) => ({
      ...row,
      extractedData: JSON.stringify({ referenceRaw: `DifferentReference${row.id}` }),
    }));
    const harness = makeTx({
      payments: rows,
      pageTransform(read, page) {
        if (read.kind !== "alias" || read.table !== "payments" || read.cursor !== 0) return page;
        return page.map((row) => row.id !== 500 ? row : {
          ...row,
          // Consume the remainder while processing the final row of page 1.
          // The alias scanner must check again before requesting page 2.
          get extractedData() { now = 15_000; return row.extractedData; },
        });
      },
    });
    const rawReference = "CurrentReference";

    await expect(evaluateSlipConflict({
      identifiers: { referenceHash: hashSlipReference(rawReference)! },
      rawReference,
      ...SELF,
      verificationBudget: budget,
    }, harness.tx)).rejects.toBeInstanceOf(OrderApprovalVerificationTimeoutError);

    expect(harness.pages.filter((read) => read.kind === "duplicate")).toEqual([
      { table: "payments", kind: "duplicate", cursor: 0 },
      { table: "payments", kind: "duplicate", cursor: 500 },
      { table: "walletTopups", kind: "duplicate", cursor: 0 },
    ]);
    expect(harness.pages.filter((read) => read.kind === "alias")).toEqual([
      { table: "payments", kind: "alias", cursor: 0 },
    ]);
    expect(harness.tx.insert).not.toHaveBeenCalled();
  });

  it("claimSlip never inserts when the real evaluator's final lookup consumes the remaining budget", async () => {
    let now = 0;
    const budget = createOrderApprovalVerificationBudget({ now: () => now });
    const harness = makeTx({
      complete: true,
      onIndexedRead(table) {
        if (table === "paymentSlipLegacyUnknown") now = 15_000;
      },
    });

    await expect(claimSlip({
      ...SELF,
      userId: 1,
      identifiers: { fileHash: INCOMING_HASH },
      verificationBudget: budget,
    }, harness.tx)).rejects.toBeInstanceOf(OrderApprovalVerificationTimeoutError);

    expect(now).toBe(15_000);
    expect(harness.tx.execute).toHaveBeenCalledTimes(1);
    expect(harness.tx.insert).not.toHaveBeenCalled();
    expect(harness.inserted).toEqual([]);
  });
});
