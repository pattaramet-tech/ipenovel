import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as dbModule from "../db";
import { claimSlip } from "./slipClaimService";
import { hashSlipReference } from "./slipIdentifierService";
import { resolveLegacyCaseAmbiguity } from "./legacyCaseResolutionService";
import * as backfillState from "./slipBackfillStateService";

/**
 * Round 10. Three findings on 87b2607:
 *
 *  1. the adjudicated evidence identified the historical FOLD but not the
 *     thing being approved - `abc123` and `AbC123` share an alias and a
 *     matched source, so a casing-only Recheck could still slip a reference
 *     no human reviewed past the waiver
 *  2. confirmed_duplicate revalidated AFTER the rejection, and the guard
 *     requires a reviewable status - so it always threw and rolled back
 *  3. an automatic OCR run that lost the finalization race returned before
 *     recordOcrAttempt, erasing itself from history
 *
 * (2) had passed a set of purely structural assertions while being broken at
 * runtime, so it is covered here by executing the real resolver end to end
 * against an in-memory database.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const LOWER = "abc123def456";
const MIXED = "AbC123def456";
const UPPER = LOWER.toUpperCase();
const HASH_LOWER = hashSlipReference(LOWER)!;
const HASH_MIXED = hashSlipReference(MIXED)!;
const ALIAS = hashSlipReference(UPPER)!;
const FILE_A = "a".repeat(64);

// Both casings must genuinely fold together, or the test proves nothing.
if (HASH_LOWER === HASH_MIXED) throw new Error("fixture: casings must differ");
if (hashSlipReference(MIXED.toUpperCase()) !== ALIAS) {
  throw new Error("fixture: casings must share one alias");
}

// ════════════════════════════════════════════════════════════════════════
// A generic in-memory stand-in, good enough for the real production bodies
// ════════════════════════════════════════════════════════════════════════

function tableName(table: any): string {
  return String(table?.[Symbol.for("drizzle:Name")] ?? "");
}

/** Hashes bound into a WHERE, used to filter the claim registry. */
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

/** Statuses a conditional UPDATE is allowed to move a row out of. */
const REVIEWABLE = new Set(["pending", "pending_review"]);

interface FakeOptions {
  rows: Record<string, any[]>;
  /** Rewrites a row mid-transaction, simulating a concurrent Recheck. */
  onLock?: (store: Record<string, any[]>) => void;
  /** Throws from one table's INSERT, to test rollback. */
  failInsertOn?: string;
}

function makeDb(options: FakeOptions) {
  // Deep copy so each test starts clean and rollback can restore.
  const store: Record<string, any[]> = JSON.parse(JSON.stringify(options.rows));
  const committed = () => JSON.parse(JSON.stringify(store));
  let locks = 0;

  const executor = (): any => ({
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) return [[]];
      if (queryText.includes("FROM users")) return [[{ id: 1 }]];
      locks += 1;
      options.onLock?.(store);
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
              const rows = store[name] ?? [];
              const filtered =
                name === "paymentSlipClaims"
                  ? wanted.length
                    ? rows.filter((r) => cols.some((c) => r[c] && wanted.includes(r[c])))
                    : []
                  : rows;
              return {
                orderBy: () => ({ limit: async () => filtered }),
                limit: async (n: number) => filtered.slice(0, n),
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
              const rows = store[name] ?? [];
              // A conditional status transition only wins from a reviewable
              // row; everything else is an unconditional id-scoped update.
              const conditional = typeof values.status === "string";
              let affected = 0;
              for (const row of rows) {
                if (conditional && !REVIEWABLE.has(row.status)) continue;
                Object.assign(row, values);
                affected += 1;
              }
              return [{ affectedRows: affected }];
            },
          };
        },
      };
    },
    insert(table: any) {
      const name = tableName(table);
      return {
        values: async (v: any) => {
          if (options.failInsertOn === name) throw new Error("simulated insert failure");
          const rows = (store[name] ??= []);
          if (name === "paymentSlipReviewResolutions") {
            const clash = rows.some(
              (r) => r.subjectType === v.subjectType && r.subjectId === v.subjectId
            );
            if (clash) {
              const err: any = new Error("Duplicate entry");
              err.code = "ER_DUP_ENTRY";
              err.errno = 1062;
              throw err;
            }
          }
          rows.push({ id: rows.length + 1, ...v });
          return [{ insertId: rows.length }];
        },
      };
    },
  });

  const base = executor();

  const fake: any = {
    ...base,
    transaction: async (fn: any) => {
      const snapshot = committed();
      try {
        return await fn(executor());
      } catch (error) {
        // ROLLBACK: restore every table to its pre-transaction contents.
        for (const key of Object.keys(store)) delete store[key];
        for (const [k, v] of Object.entries(snapshot)) store[k] = v as any[];
        throw error;
      }
    },
  };

  return { fake, store, get lockCount() { return locks; } };
}

// ════════════════════════════════════════════════════════════════════════
// 1. THE WAIVER IS BOUND TO THE EXACT CASE-PRESERVING REFERENCE
// ════════════════════════════════════════════════════════════════════════

function claimRegistry(claims: any[]) {
  const inserted: any[] = [];
  return {
    inserted,
    tx: {
      select() {
        return {
          from(table: any) {
            const name = tableName(table);
            return {
              where(cond: any) {
                const wanted = boundHashes(cond);
                const cols = targetedColumns(cond);
                return {
                  orderBy: () => ({ limit: async () => [] }),
                  limit: async (n: number) =>
                    name === "paymentSlipClaims" && wanted.length
                      ? claims.filter((c) => cols.some((k) => c[k] && wanted.includes(c[k]))).slice(0, n)
                      : [],
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          values: async (v: any) => {
            inserted.push(v);
            return [{ insertId: inserted.length }];
          },
        };
      },
    },
  };
}

const LEGACY_ROW = {
  sourceType: "order_payment",
  sourceId: 42,
  referenceHash: null,
  legacyReferenceUpperHash: ALIAS,
  fileHash: null,
  qrPayloadHash: null,
};

/** What the admin reviewed: the LOWERCASE reference, folding against #42. */
const ADJUDICATED = {
  expectedLegacyAliasHash: ALIAS,
  expectedMatchedSourceType: "order_payment" as const,
  expectedMatchedSourceId: 42,
  expectedIncomingReferenceHash: HASH_LOWER,
};

function claimFor(referenceRaw: string, sourceType: "order_payment" | "wallet_topup") {
  return {
    sourceType,
    sourceId: 900,
    userId: 3,
    identifiers: { referenceHash: hashSlipReference(referenceRaw)! },
    referenceRawForLegacyLookup: referenceRaw,
  };
}

describe.each(["order_payment", "wallet_topup"] as const)(
  "F. the waiver names the exact reference reviewed (%s)",
  (sourceType) => {
    beforeEach(() => {
      vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    });
    afterEach(() => vi.restoreAllMocks());

    it("A/E. the transaction still sees the reviewed reference -> waives and claims it", async () => {
      const registry = claimRegistry([LEGACY_ROW]);

      const outcome = await claimSlip(
        { ...claimFor(LOWER, sourceType), legacyCaseAmbiguityResolution: ADJUDICATED },
        registry.tx
      );

      expect(outcome.claimed).toBe(true);
      expect(registry.inserted).toHaveLength(1);
      expect(registry.inserted[0].referenceHash).toBe(HASH_LOWER);
      expect(registry.inserted[0].legacyReferenceUpperHash).toBeNull();
    });

    it("B. a CASING-ONLY change keeps the same alias and source -> still REFUSED", async () => {
      // THE REGRESSION. Recheck rewrote abc123 -> AbC123. Same alias, same
      // matched row - only the case-preserving hash moved.
      const registry = claimRegistry([LEGACY_ROW]);

      const outcome = await claimSlip(
        { ...claimFor(MIXED, sourceType), legacyCaseAmbiguityResolution: ADJUDICATED },
        registry.tx
      );

      expect(outcome.claimed).toBe(false);
      if (!outcome.claimed) expect(outcome.reason).toBe("legacy_case_ambiguity_changed");
      // No claim, so no value can follow.
      expect(registry.inserted).toHaveLength(0);
    });

    it("C. same reference but a different matched source -> refused", async () => {
      const registry = claimRegistry([
        { ...LEGACY_ROW, sourceType: "wallet_topup", sourceId: 77 },
      ]);

      const outcome = await claimSlip(
        { ...claimFor(LOWER, sourceType), legacyCaseAmbiguityResolution: ADJUDICATED },
        registry.tx
      );

      expect(outcome.claimed).toBe(false);
      if (!outcome.claimed) expect(outcome.reason).toBe("legacy_case_ambiguity_changed");
      expect(registry.inserted).toHaveLength(0);
    });

    it("D. current evidence became an exact strong duplicate -> blocked", async () => {
      const registry = claimRegistry([
        LEGACY_ROW,
        { ...LEGACY_ROW, sourceId: 55, referenceHash: HASH_LOWER, legacyReferenceUpperHash: null },
      ]);

      const outcome = await claimSlip(
        { ...claimFor(LOWER, sourceType), legacyCaseAmbiguityResolution: ADJUDICATED },
        registry.tx
      );

      expect(outcome.claimed).toBe(false);
      if (!outcome.claimed) expect(outcome.reason).toBe("already_claimed");
      expect(registry.inserted).toHaveLength(0);
    });

    it("an exact FILE duplicate is not waived either", async () => {
      const registry = claimRegistry([
        LEGACY_ROW,
        { ...LEGACY_ROW, sourceId: 56, legacyReferenceUpperHash: null, fileHash: FILE_A },
      ]);

      const outcome = await claimSlip(
        {
          ...claimFor(LOWER, sourceType),
          identifiers: { referenceHash: HASH_LOWER, fileHash: FILE_A },
          legacyCaseAmbiguityResolution: ADJUDICATED,
        },
        registry.tx
      );

      expect(outcome.claimed).toBe(false);
      if (!outcome.claimed) expect(outcome.reason).toBe("already_claimed");
    });
  }
);

// ════════════════════════════════════════════════════════════════════════
// 2. confirmed_duplicate, EXECUTED
// ════════════════════════════════════════════════════════════════════════

const REASON = "Confirmed the same transfer as the older approved record.";

function orderRows(overrides: any = {}) {
  return {
    payments: [
      {
        id: 500,
        orderId: 700,
        status: "pending_review",
        extractedData: JSON.stringify({ referenceRaw: LOWER }),
        ...overrides,
      },
    ],
    orders: [{ id: 700, userId: 9, status: "pending", paymentStatus: "pending" }],
    paymentSlipClaims: [LEGACY_ROW],
    paymentSlipReviewResolutions: [],
    orderHistory: [],
  };
}

function walletRows(overrides: any = {}) {
  return {
    walletTopups: [
      {
        id: 600,
        userId: 9,
        status: "pending_review",
        requestedAmount: "250.00",
        creditedAmount: "260.00",
        bonusAmount: "10.00",
        extractedData: JSON.stringify({ referenceRaw: LOWER }),
        ...overrides,
      },
    ],
    paymentSlipClaims: [LEGACY_ROW],
    paymentSlipReviewResolutions: [],
    topupLogs: [],
    walletTransactions: [],
    walletAccounts: [{ userId: 9, balance: "0.00" }],
  };
}

const SUBJECTS = [
  { label: "order", subjectType: "order_payment" as const, subjectId: 500, rows: orderRows, table: "payments" },
  { label: "wallet", subjectType: "wallet_topup" as const, subjectId: 600, rows: walletRows, table: "walletTopups" },
];

describe.each(SUBJECTS)("confirmed_duplicate actually completes ($label)", (subject) => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("rejects the subject AND commits exactly one resolution audit", async () => {
    const harness = makeDb({ rows: subject.rows() });
    dbModule.__setDbForTests(harness.fake);

    const result = await resolveLegacyCaseAmbiguity({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      adminUserId: 4,
      decision: "confirmed_duplicate",
      reason: REASON,
    });

    expect(result.resolved).toBe(true);
    expect(result.approved).toBe(false);

    // Final status is rejected - the transaction COMMITTED.
    expect(harness.store[subject.table][0].status).toBe("rejected");

    // Exactly one successful resolution audit, naming the adjudicated
    // case-preserving reference rather than only the lossy fold.
    const audits = harness.store.paymentSlipReviewResolutions;
    expect(audits).toHaveLength(1);
    expect(audits[0].resolutionType).toBe("legacy_case_confirmed_duplicate");
    expect(audits[0].subjectId).toBe(subject.subjectId);
    expect(audits[0].legacyAliasHash).toBe(ALIAS);
    expect(audits[0].adjudicatedReferenceHash).toBe(HASH_LOWER);

    // A rejection creates no value: no claim was inserted.
    expect(harness.store.paymentSlipClaims).toHaveLength(1);

    // The subject row was locked for the critical section.
    expect(harness.lockCount).toBeGreaterThan(0);
  });

  it("A. evidence changed before the locked revalidation -> no rejection, no audit", async () => {
    // A Recheck rewrites the extraction to a casing-only variant the moment
    // the row is locked. Same alias, same matched source.
    const harness = makeDb({
      rows: subject.rows(),
      onLock: (store) => {
        const row = store[subject.table][0];
        row.extractedData = JSON.stringify({ referenceRaw: MIXED });
      },
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 4,
        decision: "confirmed_duplicate",
        reason: REASON,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(harness.store[subject.table][0].status).toBe("pending_review");
    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(0);
  });

  it("B. the subject was finalized concurrently -> no stale resolution committed", async () => {
    const harness = makeDb({ rows: subject.rows({ status: "approved" }) });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 4,
        decision: "confirmed_duplicate",
        reason: REASON,
      })
    ).rejects.toThrow();

    expect(harness.store[subject.table][0].status).toBe("approved");
    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(0);
  });

  it("C. a rejection side-effect failure rolls BOTH back", async () => {
    // The audit insert itself fails, standing in for any late failure in the
    // same transaction.
    const harness = makeDb({
      rows: subject.rows(),
      failInsertOn: "paymentSlipReviewResolutions",
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 4,
        decision: "confirmed_duplicate",
        reason: REASON,
      })
    ).rejects.toThrow();

    // Rolled back together: still reviewable, still no audit row.
    expect(harness.store[subject.table][0].status).toBe("pending_review");
    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(0);
  });

  it("D. a retry after a transient failure succeeds", async () => {
    const failing = makeDb({ rows: subject.rows(), failInsertOn: "paymentSlipReviewResolutions" });
    dbModule.__setDbForTests(failing.fake);
    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 4,
        decision: "confirmed_duplicate",
        reason: REASON,
      })
    ).rejects.toThrow();

    // The subject slot was never consumed, so the same call now works.
    const retry = makeDb({ rows: failing.store as any });
    dbModule.__setDbForTests(retry.fake);

    const result = await resolveLegacyCaseAmbiguity({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      adminUserId: 4,
      decision: "confirmed_duplicate",
      reason: REASON,
    });

    expect(result.resolved).toBe(true);
    expect(retry.store.paymentSlipReviewResolutions).toHaveLength(1);
    expect(retry.store[subject.table][0].status).toBe("rejected");
  });

  it("E. a second admin resolving the same subject cannot commit a second resolution", async () => {
    const harness = makeDb({ rows: subject.rows() });
    dbModule.__setDbForTests(harness.fake);

    await resolveLegacyCaseAmbiguity({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      adminUserId: 4,
      decision: "confirmed_duplicate",
      reason: REASON,
    });

    // The subject is now rejected, so the second attempt stops before it can
    // create a parallel decision.
    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 5,
        decision: "confirmed_duplicate",
        reason: REASON,
      })
    ).rejects.toThrow();

    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(1);
    expect(harness.store.paymentSlipReviewResolutions[0].adminUserId).toBe(4);
  });

  it("a reason shorter than the minimum is refused before anything is touched", async () => {
    const harness = makeDb({ rows: subject.rows() });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      resolveLegacyCaseAmbiguity({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        adminUserId: 4,
        decision: "confirmed_duplicate",
        reason: "too short",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(harness.store[subject.table][0].status).toBe("pending_review");
    expect(harness.store.paymentSlipReviewResolutions).toHaveLength(0);
  });
});

describe("the duplicate flow revalidates before it mutates", () => {
  const svc = readCode("server/services/legacyCaseResolutionService.ts");
  const dbCode = readCode("server/db.ts");

  it("the order adapter revalidates before the conditional rejection", () => {
    const start = svc.indexOf("async rejectWithResolution({ adminUserId, reason, revalidate, auditResolution })");
    expect(start).toBeGreaterThan(-1);
    const body = svc.slice(start, start + 2600);
    const revalidateIdx = body.indexOf("await revalidate(tx)");
    const rejectIdx = body.indexOf("db.rejectPaymentIfReviewable");
    const auditIdx = body.indexOf("await auditResolution(tx)");
    expect(revalidateIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(revalidateIdx);
    expect(auditIdx).toBeGreaterThan(rejectIdx);
  });

  it("the wallet rejection revalidates before its conditional update", () => {
    const start = dbCode.indexOf("export async function rejectWalletTopup(");
    const end = dbCode.indexOf("export async function repairWalletTopupCredit(");
    const body = dbCode.slice(start, end);
    const revalidateIdx = body.indexOf("await options.revalidate(tx)");
    const updateIdx = body.indexOf('status: "rejected" as any');
    const auditIdx = body.indexOf("await options.auditResolution(tx)");
    expect(revalidateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(revalidateIdx);
    expect(auditIdx).toBeGreaterThan(updateIdx);
  });

  it("the resolution passes revalidation as its own callback, not inside the audit", () => {
    const start = svc.indexOf('if (input.decision === "confirmed_duplicate")');
    const body = svc.slice(start, start + 1800);
    expect(body).toMatch(/revalidate: async \(tx: any\) => \{/);
    const revalIdx = body.indexOf("requireUnchangedAmbiguityInTx");
    const auditIdx = body.indexOf("auditResolution: async");
    expect(revalIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(revalIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. AN AUTOMATIC RUN ALWAYS LEAVES EXACTLY ONE ATTEMPT
// ════════════════════════════════════════════════════════════════════════

describe("the finalization race still produces attempt history", () => {
  const code = readCode("server/services/slipSubmissionService.ts");

  // IPE-001 P1-A refactor: the pre-transaction preflight and the in-
  // transaction locked check are now BOTH races for the SAME terminal
  // outcome, so the single recording call moved into one shared helper.
  //
  // IPE-001 P1-B/C refactor: that helper is now `superseded(reason)`, not
  // `supersededByFinalization(currentStatus)` - a slip replaced mid-flight
  // (OCR_SUPERSEDED_BY_SLIP_REPLACEMENT) shares the exact same terminal
  // shape as a finalization race (OCR_SUPERSEDED_BY_FINALIZATION), so a
  // THIRD and FOURTH race site (the slip-version preflight check, and the
  // SlipVersionChangedError catch branch) now also route through it. See
  // server/services/orderAutoApprovalStateRace.test.ts and
  // server/services/slipReplacementPublishRace.test.ts for the behavioural
  // proof that all four race sites actually reach it.

  it("superseded() records an attempt before its own return", () => {
    const start = code.indexOf("const superseded = async (");
    expect(start).toBeGreaterThan(-1);
    const returnIdx = code.indexOf("return {", start);
    const recordIdx = code.indexOf("await recordOcrAttempt({", start);
    expect(recordIdx).toBeGreaterThan(start);
    expect(returnIdx).toBeGreaterThan(recordIdx);
  });

  it("it is classified STATE, not technical and not a duplicate, for either reason", () => {
    const start = code.indexOf("const superseded = async (");
    // Up to the return, not through it - the same precise boundary used
    // throughout this describe block.
    const body = code.slice(start, code.indexOf("return {", start));
    expect(body).toMatch(/reviewReason: reason/);
    expect(body).toMatch(/"OCR_SUPERSEDED_BY_FINALIZATION" \| "OCR_SUPERSEDED_BY_SLIP_REPLACEMENT"/);
    expect(body).toMatch(/reviewCategory: "STATE"/);
    expect(body).toMatch(/trigger: "automatic"/);
    expect(body).not.toMatch(/technical_failure|DUPLICATE_/);
  });

  it("it preserves sanitized provider diagnostics and no raw response", () => {
    const start = code.indexOf("const superseded = async (");
    // Only the recordOcrAttempt() call, NOT the terminal `return { ... }`
    // object below it - that return legitimately echoes back the current
    // slipImageUrl for the API response shape, which is not the raw
    // diagnostic leak this assertion guards against.
    const recordCallEnd = code.indexOf("return {", start);
    const body = code.slice(start, recordCallEnd);
    expect(body).toMatch(/providerMode: providerDiagnostic\?\.providerMode/);
    expect(body).toMatch(/providerHttpStatus: providerDiagnostic\?\.providerHttpStatus/);
    expect(body).toMatch(/providerAttemptCount/);
    // Never the raw OCR text or the thrown message leaking into diagnostics.
    expect(body).not.toMatch(/ocrText|rawText|apiKey/);
  });

  it("exactly one attempt per automatic run: every race site calls the SAME single recorder", () => {
    // ONE recordOcrAttempt call for every superseded outcome (shared), plus
    // ONE terminal call for a completed automatic run (auto_approved /
    // needs_review / technical_failure / config_blocked) - never two for the
    // same invocation, because every race site routes through the same
    // helper rather than each recording independently.
    const occurrences = code.split("await recordOcrAttempt({").length - 1;
    expect(occurrences).toBe(2);

    const preflightGuardIdx = code.indexOf(
      'if (currentPayment?.status === "approved" || currentPayment?.status === "rejected")'
    );
    const preflightFinalizedReturnIdx = code.indexOf(
      'return await superseded("OCR_SUPERSEDED_BY_FINALIZATION")',
      preflightGuardIdx
    );
    expect(preflightFinalizedReturnIdx).toBeGreaterThan(preflightGuardIdx);

    // The slip-version preflight guard - the new third race site.
    const preflightSlipReturnIdx = code.indexOf(
      'return await superseded("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT")',
      preflightFinalizedReturnIdx
    );
    expect(preflightSlipReturnIdx).toBeGreaterThan(preflightFinalizedReturnIdx);

    const catchGuardIdx = code.indexOf("} catch (claimError) {");
    // The SlipVersionChangedError branch is checked FIRST in the catch.
    const catchSlipReturnIdx = code.indexOf(
      'return await superseded("OCR_SUPERSEDED_BY_SLIP_REPLACEMENT")',
      catchGuardIdx
    );
    expect(catchSlipReturnIdx).toBeGreaterThan(catchGuardIdx);
    const catchFinalizedReturnIdx = code.indexOf(
      'return await superseded("OCR_SUPERSEDED_BY_FINALIZATION")',
      catchSlipReturnIdx
    );
    expect(catchFinalizedReturnIdx).toBeGreaterThan(catchSlipReturnIdx);

    // None of these race sites has its own recordOcrAttempt call - all
    // delegate to the shared helper.
    const preflightBody = code.slice(preflightGuardIdx, preflightSlipReturnIdx);
    expect(preflightBody).not.toMatch(/await recordOcrAttempt/);
    const catchBody = code.slice(catchGuardIdx, catchFinalizedReturnIdx);
    expect(catchBody).not.toMatch(/await recordOcrAttempt/);
  });

  it("the shared superseded outcome mutates nothing", () => {
    const start = code.indexOf("const superseded = async (");
    const body = code.slice(start, code.indexOf("return {", start));
    expect(body).not.toMatch(/updatePayment|approvePayment|claimSlip|finalizeOrderCompletion/);
  });

  it("the terminal recording still covers the normal, review and failure paths", () => {
    const terminal = code.slice(code.lastIndexOf("await recordOcrAttempt({"));
    expect(terminal).toMatch(/config_blocked/);
    expect(terminal).toMatch(/technical_failure/);
    expect(terminal).toMatch(/auto_approved/);
    expect(terminal).toMatch(/needs_review/);
  });

  it("attempt recording cannot break money correctness", () => {
    const attemptService = readCode("server/services/ocrAttemptService.ts");
    // recordOcrAttempt swallows its own errors by construction.
    expect(attemptService).toMatch(/catch/);
  });
});

describe("wallet parity: no automatic path loses its attempt", () => {
  const wallet = readCode("server/services/walletTopupSubmissionService.ts");

  it("the wallet state race already records before returning", () => {
    const raceIdx = wallet.indexOf('claimCode === "TOPUP_STATE_RACE"');
    expect(raceIdx).toBeGreaterThan(-1);
    const body = wallet.slice(raceIdx, wallet.indexOf("if (claimCode) {"));
    const recordIdx = body.indexOf("await recordWalletAttempt(");
    const returnIdx = body.indexOf("return await buildSupersededResult");
    expect(recordIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(returnIdx);
    expect(body).toMatch(/"TOPUP_SUPERSEDED_BY_FINALIZATION"/);
    expect(body).toMatch(/"STATE"/);
  });

  it("the superseded builder is only reached after an attempt was recorded", () => {
    // Each handler that can return it is itself entered only after its
    // caller recorded one, so no automatic run goes unrecorded.
    for (const handler of ["handlePendingReview", "handleDuplicate", "handleOCRError"]) {
      const start = wallet.indexOf(`async function ${handler}(`);
      expect(start, handler).toBeGreaterThan(-1);
      const body = wallet.slice(start, start + 4200);
      expect(body, handler).toMatch(/buildSupersededResult/);
      expect(body, handler).not.toMatch(/recordWalletAttempt/);
    }
  });
});
