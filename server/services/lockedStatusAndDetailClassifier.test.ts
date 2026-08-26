import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as dbModule from "../db";
import * as orderService from "./orderService";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import { claimSlip } from "./slipClaimService";
import { hashSlipReference } from "./slipIdentifierService";
import { resolveMatchedSourceNavigation } from "./matchedSourceNavigationService";
import * as backfillState from "./slipBackfillStateService";

/**
 * Round 11. Three findings on c67b091, two of them incomplete propagation of
 * changes I had already made:
 *
 *  1. the row lock I added for evidence stability had no STATUS check behind
 *     it, so a payment rejected in the window was claimed, flipped back to
 *     approved, and finalized - creating purchases and points after a human
 *     had refused it
 *  2. the shared conflict classifier reached the claim path and Recheck but
 *     never the admin order-detail query, so an ambiguity that no claim
 *     attempt had recorded was invisible and its resolution controls stayed
 *     hidden
 *  3. matched-source links pointed at list pages that ignore the parameters
 *
 * (1) is the financial one and is EXECUTED against an in-memory database.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const REFERENCE = "abc123def456";
const UPPER = REFERENCE.toUpperCase();
const HASH = hashSlipReference(REFERENCE)!;
const ALIAS = hashSlipReference(UPPER)!;
const FILE_A = "a".repeat(64);

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

/**
 * In-memory database. `onLock` fires when a row is locked, so another admin's
 * decision can be injected into exactly the window this round is about.
 */
function makeDb(rows: Record<string, any[]>, onLock?: (store: Record<string, any[]>) => void) {
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(rows));
  // The pre-transaction snapshot our rollback restores. `onLock` stands for
  // ANOTHER admin's already-committed transaction, so it refreshes this -
  // otherwise our rollback would silently undo their decision, which is the
  // opposite of what the code under test must guarantee.
  let snapshot: Record<string, any[]> = JSON.parse(JSON.stringify(store));

  const executor = (): any => ({
    execute: async () => {
      onLock?.(store);
      snapshot = JSON.parse(JSON.stringify(store));
      return [[{ id: 1 }]];
    },
    select(projection?: any) {
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
                orderBy: () => ({ limit: async () => filtered }),
                limit: async (n: number) => filtered.slice(0, n),
                // Some callers await the builder directly, with no limit.
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
  return { fake, store };
}

function orderRows(paymentStatus = "pending_review") {
  return {
    payments: [
      {
        id: 500,
        orderId: 77,
        status: paymentStatus,
        extractedData: JSON.stringify({ referenceRaw: REFERENCE, fileHash: FILE_A }),
      },
    ],
    orders: [
      {
        id: 77,
        userId: 9,
        status: "pending",
        paymentStatus: "pending",
        totalAmount: "100.00",
        pointsRedeemed: 0,
        couponId: null,
      },
    ],
    paymentSlipClaims: [],
    orderHistory: [],
    purchases: [],
    pointsTransactions: [],
    paymentSlipReviewResolutions: [],
    orderItems: [],
    coupons: [],
    users: [{ id: 9, pointsBalance: "0" }],
  };
}

// ════════════════════════════════════════════════════════════════════════
// 1. THE LOCKED STATUS IS THE ARBITER
// ════════════════════════════════════════════════════════════════════════

describe("a finalized payment can never be resurrected by an approval", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("A/C. another admin REJECTS in the lock window -> approval refused, nothing created", async () => {
    // The pre-transaction view is reviewable; the rejection lands as the
    // approval acquires its lock.
    const harness = makeDb(orderRows(), (store) => {
      store.payments[0].status = "rejected";
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(orderService.approvePayment(500, "4")).rejects.toThrow(
      /PAYMENT_NOT_REVIEWABLE/
    );

    // The human decision stands.
    expect(harness.store.payments[0].status).toBe("rejected");
    expect(harness.store.orders[0].status).toBe("pending");
    // No claim, no purchases, no points, no history.
    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.pointsTransactions).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
  });

  it("B. already APPROVED under the lock -> no second finalization", async () => {
    const harness = makeDb(orderRows(), (store) => {
      store.payments[0].status = "approved";
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(orderService.approvePayment(500, "4")).rejects.toThrow(
      /PAYMENT_NOT_REVIEWABLE/
    );

    expect(harness.store.paymentSlipClaims).toHaveLength(0);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.orderHistory).toHaveLength(0);
  });

  it("A. the same guard blocks the confirmed-distinct resolution path", async () => {
    const harness = makeDb(
      {
        ...orderRows(),
        paymentSlipClaims: [
          {
            sourceType: "order_payment",
            sourceId: 42,
            referenceHash: null,
            legacyReferenceUpperHash: ALIAS,
            fileHash: null,
            qrPayloadHash: null,
          },
        ],
      },
      (store) => {
        store.payments[0].status = "rejected";
      }
    );
    dbModule.__setDbForTests(harness.fake);

    // The resolution's own pre-check passes, then the rejection lands.
    const { resolveLegacyCaseAmbiguity } = await import("./legacyCaseResolutionService");
    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: "order_payment",
        subjectId: 500,
        adminUserId: 4,
        decision: "confirmed_distinct",
        reason: "Reviewed the older record; this is a different transfer.",
      })
    ).rejects.toThrow();

    expect(harness.store.payments[0].status).toBe("rejected");
    // Only the pre-existing legacy row; no new claim was inserted.
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.purchases).toHaveLength(0);
    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(0);
  });

  it("D. the status stays reviewable under the lock -> approval proceeds", async () => {
    const harness = makeDb(orderRows());
    dbModule.__setDbForTests(harness.fake);

    await orderService.approvePayment(500, "4");

    expect(harness.store.payments[0].status).toBe("approved");
    expect(harness.store.paymentSlipClaims).toHaveLength(1);
    expect(harness.store.paymentSlipClaims[0].referenceHash).toBe(HASH);
  });

  it("E. a strong duplicate under the lock still blocks normally", async () => {
    const rows = orderRows();
    rows.paymentSlipClaims = [
      {
        sourceType: "order_payment",
        sourceId: 55,
        referenceHash: HASH,
        legacyReferenceUpperHash: null,
        fileHash: null,
        qrPayloadHash: null,
      },
    ];
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    await expect(orderService.approvePayment(500, "4")).rejects.toThrow(/SLIP_ALREADY_CLAIMED/);
    expect(harness.store.payments[0].status).toBe("pending_review");
    expect(harness.store.purchases).toHaveLength(0);
  });

  it("F. an unresolved legacy ambiguity under the lock still blocks normal Approve", async () => {
    const rows = orderRows();
    rows.paymentSlipClaims = [
      {
        sourceType: "order_payment",
        sourceId: 42,
        referenceHash: null,
        legacyReferenceUpperHash: ALIAS,
        fileHash: null,
        qrPayloadHash: null,
      },
    ];
    const harness = makeDb(rows);
    dbModule.__setDbForTests(harness.fake);

    await expect(orderService.approvePayment(500, "4")).rejects.toThrow(
      /LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION/
    );
    expect(harness.store.payments[0].status).toBe("pending_review");
  });
});

describe("the guard is ONE shared primitive, not per-caller", () => {
  const orderCode = readCode("server/services/orderService.ts");
  const slipCode = readCode("server/services/slipSubmissionService.ts");

  // IPE-001 P1-A: approvePaymentInTx originally reimplemented lock+reload+
  // guard inline, and that inline copy was the ONLY implementation - so when
  // OCR auto-approval grew its own transaction in slipSubmissionService.ts,
  // it inherited nothing. The fix extracts ONE exported primitive,
  // lockAndRequireReviewablePayment, and requires every approval transaction
  // to call it - never to reimplement it.

  it("lockAndRequireReviewablePayment is the single implementation: lock, reload, require reviewable", () => {
    const start = orderCode.indexOf("export async function lockAndRequireReviewablePayment(");
    expect(start).toBeGreaterThan(-1);
    const body = orderCode.slice(start, start + 700);
    const lockIdx = body.indexOf("await db.lockPaymentForUpdate(paymentId, tx)");
    const reloadIdx = body.indexOf("await db.getPaymentById(paymentId, tx)");
    const guardIdx = body.indexOf("isReviewablePaymentStatus(payment.status as string)");
    const throwIdx = body.indexOf("throw new PaymentNotReviewableError(paymentId, String(payment.status))");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(reloadIdx).toBeGreaterThan(lockIdx);
    expect(guardIdx).toBeGreaterThan(reloadIdx);
    expect(throwIdx).toBeGreaterThan(guardIdx);
  });

  it("approvePaymentInTx calls the shared primitive rather than reimplementing it", () => {
    const start = orderCode.indexOf("async function approvePaymentInTx(");
    const body = orderCode.slice(start, start + 3000);
    expect(body).toMatch(/await lockAndRequireReviewablePayment\(paymentId, tx\)/);
    // It must NOT contain its own copy of the guard - only ONE call site.
    expect(body).not.toMatch(/isReviewablePaymentStatus\(payment\.status as string\)/);
  });

  it("the OCR automatic approval transaction ALSO calls the shared primitive - this is the P1-A fix", () => {
    const txIdx = slipCode.indexOf("await dbConnection.transaction(async (tx: any) => {");
    expect(txIdx).toBeGreaterThan(-1);
    const body = slipCode.slice(txIdx, txIdx + 700);
    expect(body).toMatch(/await orderService\.lockAndRequireReviewablePayment\(payment\.id, tx, publishedSlipVersion\)/);
  });

  it("in BOTH callers, the guard runs before any claim, approval mutation or finalization", () => {
    // Manual/legacy-resolution approval.
    const orderStart = orderCode.indexOf("async function approvePaymentInTx(");
    const orderBody = orderCode.slice(orderStart, orderStart + 4800);
    const orderGuardIdx = orderBody.indexOf("await lockAndRequireReviewablePayment(paymentId, tx)");
    const orderClaimIdx = orderBody.indexOf("const claim = await claimSlip(");
    const orderApproveIdx = orderBody.indexOf("ApprovalService.approvePaymentWithSource");
    const orderFinalizeIdx = orderBody.indexOf("await finalizeOrderCompletion(");
    expect(orderClaimIdx).toBeGreaterThan(orderGuardIdx);
    expect(orderApproveIdx).toBeGreaterThan(orderGuardIdx);
    expect(orderFinalizeIdx).toBeGreaterThan(orderGuardIdx);

    // OCR automatic approval.
    const txIdx = slipCode.indexOf("await dbConnection.transaction(async (tx: any) => {");
    const slipGuardIdx = slipCode.indexOf(
      "await orderService.lockAndRequireReviewablePayment(payment.id, tx, publishedSlipVersion)",
      txIdx
    );
    const slipClaimIdx = slipCode.indexOf("const claim = await claimSlip(", txIdx);
    const slipApproveIdx = slipCode.indexOf("ApprovalService.approvePaymentWithSource", txIdx);
    const slipFinalizeIdx = slipCode.indexOf("await orderService.finalizeOrderCompletion(", txIdx);
    expect(slipClaimIdx).toBeGreaterThan(slipGuardIdx);
    expect(slipApproveIdx).toBeGreaterThan(slipGuardIdx);
    expect(slipFinalizeIdx).toBeGreaterThan(slipGuardIdx);
  });

  it("a lost race is a typed error a caller can distinguish from a provider fault or a duplicate", () => {
    expect(orderCode).toMatch(/export class PaymentNotReviewableError extends Error/);
    expect(orderCode).toMatch(/readonly code = "PAYMENT_NOT_REVIEWABLE"/);
    expect(orderCode).toMatch(/readonly currentStatus: string/);
  });

  it("the reviewable set contains no final status", () => {
    expect(orderCode).toMatch(
      /const REVIEWABLE_PAYMENT_STATUSES = \["pending", "pending_review"\] as const/
    );
    const start = orderCode.indexOf("const REVIEWABLE_PAYMENT_STATUSES");
    const line = orderCode.slice(start, orderCode.indexOf("\n", start));
    expect(line).not.toMatch(/approved|rejected|cancelled/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. ORDER DETAIL USES THE SHARED CLASSIFIER
// ════════════════════════════════════════════════════════════════════════

/** The exact inputs the detail query now feeds the shared evaluator. */
async function classifyLikeDetail(
  extractedData: string,
  claims: any[],
  paymentId = 500
) {
  const { deriveStrongIdentifiersFromExtractedData, getRawReferenceForLegacyLookup } =
    await import("./slipIdentifierService");
  const { identifiers } = deriveStrongIdentifiersFromExtractedData(extractedData);
  const harness = makeDb({ paymentSlipClaims: claims, payments: [], walletTopups: [] });
  return await evaluateSlipConflict(
    {
      identifiers,
      rawReference: getRawReferenceForLegacyLookup(extractedData),
      sourceType: "order_payment",
      sourceId: paymentId,
    },
    harness.fake
  );
}

const LEGACY_CLAIM = {
  sourceType: "order_payment",
  sourceId: 42,
  referenceHash: null,
  legacyReferenceUpperHash: ALIAS,
  fileHash: null,
  qrPayloadHash: null,
};

describe("order detail classifies with the same evaluator as the claim path", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("A/G. a mixed-case fold is discovered even though no claim attempt ran", async () => {
    // Auto-approval disabled / shadowed: nothing ever recorded the ambiguity.
    const extracted = JSON.stringify({ referenceRaw: REFERENCE });
    const conflict = await classifyLikeDetail(extracted, [LEGACY_CLAIM]);

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") {
      expect(conflict.advisory).toBe(true);
      expect(conflict.requiresAdminResolution).toBe(true);
      expect(conflict.matchedSourceId).toBe(42);
    }

    // And the claim path agrees, which is the parity that matters: the panel
    // must not disagree with what Approve will do.
    const harness = makeDb({ paymentSlipClaims: [LEGACY_CLAIM] });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 500,
        userId: 3,
        identifiers: { referenceHash: HASH },
        referenceRawForLegacyLookup: REFERENCE,
      },
      harness.fake
    );
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_case_ambiguity");
  });

  it("B. an exact reference duplicate classifies STRONG", async () => {
    const conflict = await classifyLikeDetail(
      JSON.stringify({ referenceRaw: REFERENCE }),
      [{ ...LEGACY_CLAIM, sourceId: 55, referenceHash: HASH, legacyReferenceUpperHash: null }]
    );
    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedKind).toBe("reference");
  });

  it("C. an exact file duplicate classifies STRONG", async () => {
    const conflict = await classifyLikeDetail(
      JSON.stringify({ referenceRaw: REFERENCE, fileHash: FILE_A }),
      [{ ...LEGACY_CLAIM, sourceId: 56, legacyReferenceUpperHash: null, fileHash: FILE_A }]
    );
    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedKind).toBe("file");
  });

  it("D. no conflict classifies none", async () => {
    const conflict = await classifyLikeDetail(JSON.stringify({ referenceRaw: REFERENCE }), []);
    expect(conflict.kind).toBe("none");
  });

  it("H. the detail evaluator excludes the payment itself", async () => {
    const own = { ...LEGACY_CLAIM, sourceId: 500, referenceHash: HASH, legacyReferenceUpperHash: null };
    const conflict = await classifyLikeDetail(JSON.stringify({ referenceRaw: REFERENCE }), [own], 500);
    expect(conflict.kind).toBe("none");
  });

  it("E/F. pre- and post-backfill produce the same detail verdict", async () => {
    const extracted = JSON.stringify({ referenceRaw: REFERENCE });

    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const post = await classifyLikeDetail(extracted, [LEGACY_CLAIM]);

    vi.restoreAllMocks();
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const { deriveStrongIdentifiersFromExtractedData } = await import("./slipIdentifierService");
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(extracted);
    // Pre-backfill the verdict comes from the historical scan instead.
    const scanHarness = makeDb({
      paymentSlipClaims: [],
      payments: [{ id: 42, status: "approved", extractedData: JSON.stringify({ reference: UPPER }) }],
      walletTopups: [],
    });
    const pre = await evaluateSlipConflict(
      { identifiers, rawReference: REFERENCE, sourceType: "order_payment", sourceId: 500 },
      scanHarness.fake
    );

    expect(pre.kind).toBe("legacy_case_ambiguity");
    expect(post.kind).toBe(pre.kind);
  });
});

describe("the detail query no longer reimplements the decision", () => {
  const code = readCode("server/routers.ts");

  it("it calls evaluateSlipConflict and passes the raw reference", () => {
    expect(code).toMatch(/const conflict = await evaluateSlipConflict\(/);
    expect(code).toMatch(/rawReference: getRawReferenceForLegacyLookup\(/);
  });

  it("the old exact-only lookup is gone", () => {
    expect(code).not.toMatch(/findExistingClaim/);
    expect(code).not.toMatch(/findLegacyApprovedDuplicate/);
  });

  it("an ambiguity is reported as advisory, never as a confirmed duplicate", () => {
    const idx = code.indexOf('conflict.kind === "legacy_case_ambiguity"');
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 700);
    expect(body).toMatch(/strength: "legacy_case_ambiguity"/);
    expect(body).toMatch(/advisory: true/);
    expect(body).toMatch(/requiresAdminResolution: true/);
    expect(body).not.toMatch(/strength: "strong"/);
  });

  it("the detail surfaces the reason so the panel can show resolution controls", () => {
    expect(code).toMatch(/reviewReasonOverride = "LEGACY_REFERENCE_CASE_AMBIGUITY"/);
    expect(code).toMatch(/reviewReason: reviewReasonOverride \?\?/);
  });
});

describe("a failed Approve is no longer silent", () => {
  const page = readCode("client/src/pages/AdminOrderDetailPage.tsx");

  it("the error is captured and rendered", () => {
    expect(page).toMatch(/setApproveError\(error\?\.message \|\| "Approval failed\."\)/);
    expect(page).toMatch(/\{approveError && \(/);
  });

  it("it refetches so newly reported controls appear", () => {
    const idx = page.indexOf("onError: (error: any) => {");
    const body = page.slice(idx, idx + 500);
    expect(body).toMatch(/void refetchOrder\(\)/);
  });

  it("no stack trace is rendered", () => {
    expect(page).not.toMatch(/error\?\.stack|error\.stack/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. LINKS POINT AT REAL ROUTES
// ════════════════════════════════════════════════════════════════════════

describe("matched-source navigation resolves server-side", () => {
  it("A. an order payment resolves to its ORDER id", async () => {
    const harness = makeDb({ payments: [{ id: 123, orderId: 77 }] });
    const nav = await resolveMatchedSourceNavigation("order_payment", 123, harness.fake);
    expect(nav.orderId).toBe(77);
  });

  it("B. a wallet top-up needs no resolution", async () => {
    const harness = makeDb({ payments: [] });
    const nav = await resolveMatchedSourceNavigation("wallet_topup", 456, harness.fake);
    expect(nav.orderId).toBeUndefined();
  });

  it("C. an unresolvable payment yields no order id, so no link is possible", async () => {
    const harness = makeDb({ payments: [] });
    const nav = await resolveMatchedSourceNavigation("order_payment", 999, harness.fake);
    expect(nav.orderId).toBeUndefined();
  });

  it("a lookup failure never breaks the query that carries the verdict", async () => {
    const exploding: any = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => { throw new Error("boom"); } }) }),
      }),
    };
    await expect(
      resolveMatchedSourceNavigation("order_payment", 123, exploding)
    ).resolves.toEqual({});
  });
});

describe("the app's real routes are what gets linked", () => {
  const app = fs.readFileSync(path.resolve(process.cwd(), "client/src/App.tsx"), "utf-8");

  it("F. the routes this fix targets are the ones actually registered", () => {
    expect(app).toMatch(/path="\/admin\/orders\/:orderId"/);
    expect(app).toMatch(/path=\{"\/admin\/wallet-topups\/:topupId"\}/);
  });

  it("G. the old query-parameter links are gone", () => {
    const model = readCode("client/src/components/ocrVerdictModel.ts");
    expect(model).not.toMatch(/admin\/orders\?paymentId=/);
    expect(model).not.toMatch(/admin\/topup-logs\?topupId=/);
  });

  it("navigation is built in exactly ONE place", () => {
    const model = readCode("client/src/components/ocrVerdictModel.ts");
    const occurrences = model.split("/admin/orders/").length - 1;
    expect(occurrences).toBe(1);
    expect(model).toMatch(/export function matchedSourceNavigation\(/);
  });
});
