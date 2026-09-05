/**
 * IPE-001 P1-A: "Recheck payment state inside auto-approval transaction".
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * submitPaymentSlip's automatic OCR approval read the payment's status once,
 * OUTSIDE any transaction, then opened its OWN financial transaction that
 * could claim the slip, call ApprovalService.approvePaymentWithSource, and
 * finalizeOrderCompletion - all WITHOUT locking the payment row or
 * re-asserting reviewability under that lock. The status guard added to
 * manual approval (approvePaymentInTx) protected only that ONE caller; OCR
 * automatic approval grew its own transaction and inherited nothing.
 *
 * Concretely: OCR reads `pending` -> an admin rejects -> OCR's transaction
 * starts, claims the slip, flips the payment back to `approved`, and
 * finalizes the order - creating purchases and points for a payment a human
 * had just refused.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * The lock+reload+reviewability check is now ONE shared primitive,
 * `orderService.lockAndRequireReviewablePayment`, called first inside the
 * transaction by BOTH approvePaymentInTx (manual/legacy-resolution approval)
 * and submitPaymentSlip's OCR auto-approval transaction. Losing the race
 * throws `PaymentNotReviewableError`, rolling the transaction back - no
 * claim, no approval, no order update, no finalization - and the catch site
 * reports the authoritative persisted state through the SAME
 * `supersededByFinalization` terminal outcome the pre-transaction guard uses,
 * so an automatic run leaves exactly one attempt row either way.
 *
 * ── Why this is exercised behaviourally ───────────────────────────────────
 * A previous round's structural assertions passed against code that could
 * not actually complete its flow at runtime (see round 10's confirmed_duplicate
 * regression). Here `orderService` and `db` are REAL, driven by an in-memory
 * transaction harness whose lock hook can inject a concurrently committed
 * admin decision into the exact window the finding describes - only the OCR
 * provider pipeline (parseSlipImage, staging verification, image prep, file
 * hash, effective config) is mocked, since it is not what this defect is
 * about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../ocr-slip-verification-v2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ocr-slip-verification-v2")>();
  return { ...actual, parseSlipImage: vi.fn() };
});
vi.mock("../ocr-slip-integration-staging", () => ({
  processSlipVerificationStaging: vi.fn(),
}));
vi.mock("../_core/ocr-effective-config", () => ({
  getEffectiveOCRConfig: vi.fn(),
}));
vi.mock("./ocrImageInputService", () => ({
  prepareSlipImageForOcr: vi.fn(),
}));
vi.mock("./slipFileHashService", () => ({
  computeSlipFileHash: vi.fn(),
}));
vi.mock("./discordNotificationService", () => ({
  sendOCRReviewNotification: vi.fn(async () => {}),
}));

import * as dbModule from "../db";
import * as orderService from "./orderService";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { processSlipVerificationStaging } from "../ocr-slip-integration-staging";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { computeSlipFileHash } from "./slipFileHashService";
import { submitPaymentSlip } from "./slipSubmissionService";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const REFERENCE = "auto123approval456";
const HASH = hashSlipReference(REFERENCE)!;
const FILE_HASH = "f".repeat(64);

// ── The same in-memory transaction harness pattern used for the manual
// approval race in server/services/lockedStatusAndDetailClassifier.test.ts. ──

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

/** Fires when the payment row is locked - stands for a CONCURRENT, already
 * committed admin decision landing in the exact race window. */
function makeDb(rows: Record<string, any[]>, onLock?: (store: Record<string, any[]>) => void) {
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(rows));
  let snapshot: Record<string, any[]> = JSON.parse(JSON.stringify(store));
  const lockQueries: string[] = [];
  let minimalPaymentLockCount = 0;

  const executor = (): any => ({
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) return [[]];
      if (queryText.includes("FROM users")) return [[{ id: 1 }]];
      if (queryText.includes("FROM payments") && queryText.includes("FOR UPDATE")) {
        lockQueries.push(queryText);
      }
      // Publication first takes the Account Merge wrapper's minimal subject
      // lock, then a rich current-row lock. Approval later takes its own
      // minimal subject lock in a separate transaction. The injected admin
      // decision belongs only in that second minimal (approval) window.
      if (queryText.includes("SELECT id FROM payments") && queryText.includes("FOR UPDATE")) {
        minimalPaymentLockCount += 1;
        if (minimalPaymentLockCount === 2) {
          onLock?.(store);
          snapshot = JSON.parse(JSON.stringify(store));
        }
      }
      if (queryText.includes("SELECT id,status,slipImageUrl,evidenceVersion,slipEvidenceId")) {
        return [[store.payments[0]]];
      }
      return [[{ id: 1 }]];
    },
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          return {
            where(cond: any) {
              const all = store[name] ?? [];
              const filtered =
                name === "paymentSlipClaims"
                  ? (() => {
                      const wanted = boundHashes(cond);
                      const cols = targetedColumns(cond);
                      return wanted.length
                        ? all.filter((r) => cols.some((c) => r[c] && wanted.includes(r[c])))
                        : [];
                    })()
                  : all;
              return {
                for: async (lockMode: string) => {
                  expect(lockMode).toBe("update");
                  expect(name).toBe("payments");
                  const chunks = cond.queryChunks;
                  expect(chunks[1].name).toBe("id");
                  expect(chunks[2].value).toEqual([" = "]);
                  return (store[name] ?? []).filter((row) => row.id === chunks[3].value);
                },
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
            where() {
              const all = store[name] ?? [];
              for (const row of all) Object.assign(row, values);
              return [{ affectedRows: all.length }];
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
  return { fake, store, lockQueries };
}

function orderRows(paymentStatus = "pending") {
  return {
    payments: [
      {
        id: 700,
        orderId: 90,
        userId: 11,
        status: paymentStatus,
        slipImageUrl: "r2p:payment-slips/11/slip.png",
        evidenceVersion: 0,
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
    pointsAccounts: [{ userId: 11, balance: "0.00", version: 0 }],
    pointsTransactions: [] as any[],
    orderItems: [] as any[],
    coupons: [] as any[],
    users: [{ id: 11, pointsBalance: "0" }],
  };
}

/** Wires the OCR pipeline mocks so submitPaymentSlip reaches shouldApprove=true. */
function mockAutoApprovingOcrPipeline() {
  (getEffectiveOCRConfig as any).mockResolvedValue({
    enabled: true,
    autoApproveEnabled: true,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
  });
  (computeSlipFileHash as any).mockResolvedValue(FILE_HASH);
  (prepareSlipImageForOcr as any).mockResolvedValue("https://signed.example/slip.png");
  (parseSlipImage as any).mockResolvedValue({
    technicalError: false,
    ocrText: "reference: " + REFERENCE,
    confidence: 95,
  });
  (processSlipVerificationStaging as any).mockResolvedValue({
    isAutoApproved: true,
    isShadowMode: false,
    extractedData: {
      referenceRaw: REFERENCE,
      referenceHash: HASH,
      amount: 300,
      confidenceKnown: true,
    },
    ocrConfidence: 95,
    ocrDecision: "auto_approved",
    breakdown: { amountMatched: true, recipientVerified: true },
    duplicateStatus: { isDuplicateReference: false, isDuplicateFingerprint: false },
  });
}

describe("automatic OCR approval cannot resurrect a finalized payment", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("A. Admin REJECTS at lock time -> superseded, zero claim/purchase/points/finalization", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(orderRows("pending"), (store) => {
      // Simulates a concurrently COMMITTED admin rejection landing exactly
      // when the OCR transaction acquires the payment row lock.
      store.payments[0].status = "rejected";
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    // A STATE outcome, not a provider fault, not a duplicate.
    expect(result.reviewReason).toBe("OCR_SUPERSEDED_BY_FINALIZATION");
    expect(result.isAutoApproved).toBe(false);
    expect((result as any).supersededByFinalization).toBe(true);
    expect(result.status).toBe("rejected");
    expect(harness.lockQueries).toHaveLength(3);
    expect(harness.lockQueries[0]).toContain("SELECT id FROM payments");
    expect(harness.lockQueries[1]).toContain("SELECT id,status,slipImageUrl,evidenceVersion,slipEvidenceId");
    expect(harness.lockQueries[2]).toContain("SELECT id FROM payments");

    // The human decision stands, untouched.
    expect(harness.store.payments[0].status).toBe("rejected");
    expect(harness.store.orders[0].status).toBe("pending");
    // Nothing financial committed from the losing automatic path.
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
  });

  it("B. Admin already APPROVED at lock time -> no second finalization, no duplicate value", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(orderRows("pending"), (store) => {
      store.payments[0].status = "approved";
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    expect(result.reviewReason).toBe("OCR_SUPERSEDED_BY_FINALIZATION");
    expect(result.status).toBe("approved");
    expect(harness.lockQueries).toHaveLength(3);
    expect(harness.lockQueries[0]).toContain("SELECT id FROM payments");
    expect(harness.lockQueries[1]).toContain("SELECT id,status,slipImageUrl,evidenceVersion,slipEvidenceId");
    expect(harness.lockQueries[2]).toContain("SELECT id FROM payments");

    expect(harness.store.payments[0].status).toBe("approved");
    // No second claim, no duplicate purchase, no duplicate points row.
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
  });

  it("C. still reviewable under the lock -> exactly one claim, one approval, one finalization", async () => {
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(orderRows("pending"));
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    expect(result.isAutoApproved).toBe(true);
    expect(result.status).toBe("approved");
    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.orders[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
    expect(harness.store.orderHistory).toHaveLength(1);
    expect(harness.store.orderHistory[0].action).toBe("payment_auto_approved");
  });

  it("D. an exact strong duplicate blocks auto-approval -> no financial value, routes to review", async () => {
    mockAutoApprovingOcrPipeline();
    const rows = orderRows("pending");
    rows.paymentSlipClaims = [
      {
        sourceType: "order_payment",
        sourceId: 999,
        referenceHash: HASH,
        legacyReferenceUpperHash: null,
        fileHash: null,
        qrPayloadHash: null,
      },
    ];
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    expect(result.isAutoApproved).toBe(false);
    expect(result.status).toBe("pending_review");
    // Still only the pre-existing foreign claim - the losing auto-approval
    // attempt inserted nothing.
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].sourceId).toBe(999);
    expect(harness.store.purchases).toHaveLength(0);
  });

  it("E. a legacy case ambiguity -> NEEDS_REVIEW-equivalent, no claim, no value", async () => {
    mockAutoApprovingOcrPipeline();
    const alias = hashSlipReference(REFERENCE.toUpperCase())!;
    const rows = orderRows("pending");
    rows.paymentSlipClaims = [
      {
        sourceType: "order_payment",
        sourceId: 999,
        referenceHash: null,
        legacyReferenceUpperHash: alias,
        fileHash: null,
        qrPayloadHash: null,
      },
    ];
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    expect(result.isAutoApproved).toBe(false);
    expect(result.status).toBe("pending_review");
    expect(result.reviewReason).toBe("LEGACY_REFERENCE_CASE_AMBIGUITY");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.purchases).toHaveLength(0);
  });

  it("F. slip replaced while THIS OCR run's lock is being acquired -> refused, never overwrites the newer slip (IPE-001 P1-B/C)", async () => {
    // Customer uploads slip B -> submitPaymentSlip publishes B and starts
    // processing it. Before its auto-approval transaction acquires the row
    // lock, a THIRD upload (C) lands and commits (a second, faster
    // submitPaymentSlip call for the same payment). B's identifiers must
    // never be claimed/approved onto a row that now shows C.
    mockAutoApprovingOcrPipeline();
    const C_URL = "r2p:payment-slips/11/slip-C.png";
    const harness = makeDb(orderRows("pending"), (store) => {
      // Fires when B's transaction locks the row - stands for C's
      // replacement having already committed by then.
      store.payments[0].slipImageUrl = C_URL;
      store.payments[0].slipSubmittedAt = new Date("2026-06-01T00:00:00Z");
      store.payments[0].evidenceVersion += 1;
      store.payments[0].extractedData = JSON.stringify({ fileHash: "c".repeat(64) });
      // status stays "pending" - a replacement re-opens it, never changes it.
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png", // "B"
      userId: 11,
    });

    expect(result.reviewReason).toBe("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(result.isAutoApproved).toBe(false);
    expect((result as any).supersededByFinalization).toBe(false);
    // Reports C - the CURRENT slip - not B, which this run processed.
    expect(result.slipImageUrl).toBe(C_URL);

    // C's row stands completely untouched by B's (superseded) processing.
    expect(harness.store.payments[0].slipImageUrl).toBe(C_URL);
    expect(harness.store.payments[0].status).toBe("pending");
    expect(JSON.parse(harness.store.payments[0].extractedData)).toEqual({
      fileHash: "c".repeat(64),
    });
    // B's identifiers (REFERENCE/HASH from mockAutoApprovingOcrPipeline)
    // were never claimed, and nothing was approved or finalized for it.
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
    expect(harness.store.orders[0].status).toBe("pending");
  });

  it("G. evidenceVersion-only replacement while processing is refused and reports slip superseded", async () => {
    // The slip was replaced in a way that rekeys evidenceVersion without changing
    // the visible URL. Without an evidenceVersion CAS in sendToReview, this old
    // OCR run can write stale extraction metadata into the newer row. The new
    // write must be rejected and the previous extractedData retained.
    mockAutoApprovingOcrPipeline();
    const harness = makeDb(orderRows("pending"), (store) => {
      store.payments[0].evidenceVersion += 1;
      store.payments[0].extractedData = JSON.stringify({ fileHash: "v2".repeat(32) });
      store.payments[0].extractedEvidenceVersion = 2;
    });
    dbModule.__setDbForTests(harness.fake);

    const result = await submitPaymentSlip({
      orderId: 90,
      slipImageUrl: "r2p:payment-slips/11/slip.png",
      userId: 11,
    });

    expect(result.reviewReason).toBe("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT");
    expect(result.isAutoApproved).toBe(false);
    expect(harness.store.payments[0].status).toBe("pending");
    expect(harness.store.payments[0].evidenceVersion).toBe(2);
    expect(JSON.parse(harness.store.payments[0].extractedData)).toEqual({
      fileHash: "v2".repeat(32),
    });
    expect(harness.store.payments[0].extractedEvidenceVersion).toBe(2);
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
  });

  it("the classification helper is the STATE one, not a provider fault", async () => {
    // Covered functionally by test A/B (reviewReason assertions); this test
    // pins the classification vocabulary itself is the STATE one, not a
    // technical/duplicate one, directly against the source.
    //
    // IPE-001 P1-B/C: the helper is now `superseded(reason)`, taking either
    // OCR_SUPERSEDED_BY_FINALIZATION or OCR_SUPERSEDED_BY_SLIP_REPLACEMENT -
    // an admin finalizing mid-OCR and a customer replacing the slip mid-OCR
    // share this one terminal outcome, distinguished by which reason the
    // caller passes rather than by two separate hardcoded functions.
    const code = readCode("server/services/slipSubmissionService.ts");
    const start = code.indexOf("const superseded = async (");
    const endIdx = code.indexOf("\n  };", start);
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, endIdx);
    expect(body).toMatch(/reviewCategory: "STATE"/);
    expect(body).toMatch(/reviewReason: reason/);
    expect(body).toMatch(/"OCR_SUPERSEDED_BY_FINALIZATION" \| "OCR_SUPERSEDED_BY_SLIP_REPLACEMENT"/);
    expect(body).not.toMatch(/TECHNICAL|DUPLICATE_/);
  });
});

describe("the auto-approval race handler never lets a claim survive without value", () => {
  it("PaymentNotReviewableError is caught and routed through the shared terminal outcome, not swallowed", () => {
    const code = readCode("server/services/slipSubmissionService.ts");
    const catchIdx = code.indexOf("} catch (claimError) {");
    const body = code.slice(catchIdx, catchIdx + 900);
    expect(body).toMatch(/claimError instanceof orderService\.PaymentNotReviewableError/);
    expect(body).toMatch(/return await superseded\("OCR_SUPERSEDED_BY_FINALIZATION"\)/);
    // IPE-001 P1-B: a slip replaced mid-flight is a DIFFERENT typed error
    // from a finalized payment (the row is still reviewable), and it must be
    // caught FIRST - both are handled here, neither swallowed by the other.
    expect(body).toMatch(/claimError instanceof orderService\.SlipVersionChangedError/);
    expect(body).toMatch(/return await superseded\("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT"\)/);
    const versionIdx = body.indexOf("SlipVersionChangedError");
    const reviewableIdx = body.indexOf("PaymentNotReviewableError");
    expect(versionIdx).toBeGreaterThan(-1);
    expect(reviewableIdx).toBeGreaterThan(versionIdx);
  });

  it("the guard runs INSIDE the transaction, before claimSlip, so a lost race rolls back", () => {
    const code = readCode("server/services/slipSubmissionService.ts");
    const txIdx = code.indexOf("await dbConnection.transaction(async (tx: any) => {");
    const guardIdx = code.indexOf("await orderService.lockAndRequireReviewablePayment(", txIdx);
    const claimIdx = code.indexOf("const claim = await claimSlip(", txIdx);
    expect(guardIdx).toBeGreaterThan(txIdx);
    expect(claimIdx).toBeGreaterThan(guardIdx);
  });
});
