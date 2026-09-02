import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as dbModule from "../db";
import { findLegacyApprovedDuplicate } from "./legacySlipCompatibilityService";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";
import { hashSlipBytes } from "./slipFileHashService";

/**
 * Round 8. Four findings, all of them ways a hardening step was applied to
 * one path and not to the path that actually runs:
 *
 *  1. the wallet resolver never forwarded its ambiguity override into
 *     claimSlip, so "confirmed distinct" rolled its own approval back
 *  2. a lost TOPUP_STATE_RACE was funnelled into handlePendingReview, which
 *     reopened a finalized - possibly already credited - top-up
 *  3. the legacy scan discarded its lossy fallback at a terminal empty page,
 *     so an exact multiple of SCAN_PAGE_SIZE rows made an ambiguity vanish
 *  4. confirmed_duplicate committed its resolution record before rejecting
 *
 * (1) and (3) are exercised behaviourally against fakes; the transaction
 * ORDERING properties in (2) and (4) need a live MySQL transaction, which
 * this sandbox does not have, so those are asserted structurally.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SCAN_PAGE_SIZE = 500;

const MIXED = "202608225ApOyxElgdOo7YVwv";
const UPPER = MIXED.toUpperCase();
const MIXED_HASH = hashSlipReference(MIXED)!;
const UPPER_HASH = hashSlipReference(UPPER)!;
const FILE_A = "a".repeat(64);
const FILE_B = "b".repeat(64);

// ════════════════════════════════════════════════════════════════════════
// 1. WALLET CONFIRMED-DISTINCT, END TO END
// ════════════════════════════════════════════════════════════════════════

/**
 * In-memory drizzle stand-in wired in through `__setDbForTests`, so
 * approveWalletTopup's REAL body runs - including the real claimSlip and the
 * real shared conflict evaluator - without a database.
 */
function makeFakeDb(options: {
  topup: any;
  claims: any[];
  balance?: string;
  failAfterCredit?: boolean;
  legacyUnknownRows?: Array<{
    sourceType: "order_payment" | "wallet_topup";
    sourceId: number;
  }>;
  legacyCollisions?: Array<{
    kind: "reference" | "file" | "qr";
    identifierHash: string;
    sourceType: "order_payment" | "wallet_topup";
    sourceId: number;
  }>;
  accountMergeCase?: { id: number; status: string };
  approvalAffectedRows?: number;
}) {
  const inserted: Record<string, any[]> = {};
  const updates: Array<{ table: string; values: any }> = [];
  const locks: string[] = [];
  let topupStatus = options.topup.status;

  const record = (table: string, values: any) => {
    (inserted[table] ??= []).push(values);
  };

  const tableName = (table: any) => String(table?.[Symbol.for("drizzle:Name")] ?? "");

  const tx: any = {
    // The subject row lock issued before any evidence is read.
    execute: async (query: any) => {
      const queryText = (query?.queryChunks ?? [])
        .map((chunk: any) => (Array.isArray(chunk?.value) ? chunk.value.join("") : String(chunk?.value ?? "")))
        .join("");
      if (queryText.includes("accountMergeCases")) {
        return [options.accountMergeCase ? [{ ...options.accountMergeCase }] : []];
      }
      locks.push(queryText || "lock");
      return [[{ id: options.topup.id }]];
    },
    select() {
      return {
        from(table: any) {
          const name = tableName(table);
          return {
            // The global legacy file-axis coverage check is an unfiltered
            // bounded read: there is intentionally no identifier predicate.
            limit: async (n: number) =>
              name === "paymentSlipLegacyUnknown"
                ? (options.legacyUnknownRows ?? []).slice(0, n)
                : [],
            where(cond: any) {
              const wanted = boundHashes(cond);
              const cols = targetedColumns(cond);
              return {
                orderBy() {
                  return { limit: async () => [] };
                },
                limit: async (n: number) => {
                  if (name === "walletTopups") {
                    return [{ ...options.topup, status: topupStatus }];
                  }
                  if (name === "walletAccounts") {
                    return [{ userId: options.topup.userId, balance: options.balance ?? "0.00" }];
                  }
                  if (name === "paymentSlipLegacyCollisions") {
                    if (!wanted.length) return [];
                    return (options.legacyCollisions ?? [])
                      .filter((c) => wanted.includes(c.identifierHash))
                      .map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId }))
                      .slice(0, n);
                  }
                  if (name === "paymentSlipClaims") {
                    if (!wanted.length) return [];
                    return options.claims
                      .filter((c) => cols.some((col) => c[col] && wanted.includes(c[col])))
                      .slice(0, n);
                  }
                  return [];
                },
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
              updates.push({ table: name, values });
              const affectedRows =
                name === "walletTopups" && values.status === "approved"
                  ? (options.approvalAffectedRows ?? 1)
                  : 1;
              if (name === "walletTopups" && values.status && affectedRows > 0) {
                topupStatus = values.status;
              }
              return [{ affectedRows }];
            },
          };
        },
      };
    },
    insert(table: any) {
      const name = tableName(table);
      return {
        values: async (values: any) => {
          if (name === "paymentSlipClaims" && options.claims.some((c) => c.fileHash && c.fileHash === values.fileHash)) {
            // A UNIQUE index would refuse this; the preflight already did.
            const err: any = new Error("Duplicate entry");
            err.code = "ER_DUP_ENTRY";
            err.errno = 1062;
            throw err;
          }
          record(name, values);
          return [{ insertId: 1 }];
        },
      };
    },
  };

  const fake: any = {
    ...tx,
    transaction: async (fn: any) => await fn(tx),
  };

  return { fake, inserted, updates, locks, get status() { return topupStatus; } };
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

const pendingTopup = {
  id: 4242,
  userId: 77,
  status: "pending_review",
  requestedAmount: "250.00",
  bonusAmount: "10.00",
  creditedAmount: "260.00",
  extractedData: JSON.stringify({
    referenceRaw: MIXED,
    reference: UPPER,
    fileHash: FILE_A,
    amount: 250,
    detectedBank: "KBANK",
  }),
};

describe("wallet confirmed-distinct actually completes", () => {
  beforeEach(() => {
    // Post-backfill: the alias is looked up in the indexed registry.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });

  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.restoreAllMocks();
  });

  it("credits the wallet exactly once and commits the audit when the override is set", async () => {
    // A historical legacy row shares only the UPPERCASE FOLD - lossy
    // evidence, and the top-up's own reference is a legitimate different
    // case-sensitive value with a real strong file hash.
    const harness = makeFakeDb({
      topup: pendingTopup,
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 11,
          referenceHash: null,
          legacyReferenceUpperHash: UPPER_HASH,
          fileHash: null,
        },
      ],
    });
    dbModule.__setDbForTests(harness.fake);

    const audited: string[] = [];

    await dbModule.approveWalletTopup(pendingTopup.id, 5, {
      legacyCaseAmbiguityResolution: {
        // Bound to the EXACT fold adjudicated - a bare boolean let a Recheck
        // landing in between redirect the waiver at different evidence.
        expectedLegacyAliasHash: UPPER_HASH,
        expectedMatchedSourceType: "order_payment" as const,
        expectedMatchedSourceId: 11,
        expectedIncomingReferenceHash: MIXED_HASH,
      },
      auditResolution: async () => {
        audited.push("legacy_case_confirmed_distinct");
      },
    });

    // The advisory alias was skipped...
    expect(harness.status).toBe("approved");
    // ...but the EXACT claim still executed.
    expect(harness.inserted.paymentSlipClaims).toHaveLength(1);
    expect(harness.inserted.paymentSlipClaims[0].referenceHash).toBe(MIXED_HASH);
    expect(harness.inserted.paymentSlipClaims[0].fileHash).toBe(FILE_A);
    // A modern claim never writes the lossy alias.
    expect(harness.inserted.paymentSlipClaims[0].legacyReferenceUpperHash).toBeNull();
    // Credited exactly once.
    expect(harness.inserted.walletTransactions).toHaveLength(1);
    expect(harness.inserted.walletTransactions[0].amount).toBe("260.00");
    const balanceUpdate = harness.updates.filter((u) => u.table === "walletAccounts");
    expect(balanceUpdate).toHaveLength(1);
    expect(balanceUpdate[0].values.balance).toBe("260.00");
    // And the resolution audit ran inside the same transaction.
    expect(audited).toEqual(["legacy_case_confirmed_distinct"]);
    // The subject row was locked before any of it, so a concurrent Recheck
    // cannot rewrite the evidence this approval rests on.
    expect(harness.locks.length).toBeGreaterThan(0);
  });

  it("without the override the same top-up still stops at the ambiguity", async () => {
    const harness = makeFakeDb({
      topup: pendingTopup,
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 11,
          legacyReferenceUpperHash: UPPER_HASH,
        },
      ],
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(dbModule.approveWalletTopup(pendingTopup.id, 5)).rejects.toMatchObject({
      code: "LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION",
    });
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("the override bypasses the ALIAS ONLY - an exact file duplicate still blocks", async () => {
    const harness = makeFakeDb({
      topup: pendingTopup,
      claims: [
        // Same slip FILE as an approved order payment: strong, exact, final.
        { sourceType: "order_payment", sourceId: 12, fileHash: FILE_A },
      ],
    });
    dbModule.__setDbForTests(harness.fake);

    const audited: string[] = [];

    await expect(
      dbModule.approveWalletTopup(pendingTopup.id, 5, {
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: UPPER_HASH,
          expectedMatchedSourceType: "order_payment" as const,
          expectedMatchedSourceId: 12,
          expectedIncomingReferenceHash: MIXED_HASH,
        },
        auditResolution: async () => {
          audited.push("should-never-run");
        },
      })
    ).rejects.toMatchObject({ code: "SLIP_ALREADY_CLAIMED" });

    // No credit, no claim, no successful resolution audit.
    expect(harness.inserted.walletTransactions).toBeUndefined();
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(audited).toEqual([]);
  });

  it("the override never bypasses NO_STRONG_IDENTIFIER", async () => {
    const harness = makeFakeDb({
      topup: { ...pendingTopup, extractedData: JSON.stringify({ amount: 250 }) },
      claims: [],
    });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      dbModule.approveWalletTopup(pendingTopup.id, 5, {
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: UPPER_HASH,
          expectedMatchedSourceType: "order_payment" as const,
          expectedMatchedSourceId: 11,
          expectedIncomingReferenceHash: MIXED_HASH,
        },
      })
    ).rejects.toMatchObject({ code: "NO_STRONG_IDENTIFIER" });
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });
});

describe("wallet manual approval legacy-byte parity and break-glass boundaries", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });

  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers a trusted legacy CDN fileHash before NO_STRONG_IDENTIFIER and credits exactly once", async () => {
    const bytes = Buffer.from("ipe016-legacy-wallet-current-bytes");
    const currentHash = hashSlipBytes(bytes);
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
      reviewReason: "NO_STRONG_IDENTIFIER",
      duplicateStatus: null,
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dbModule.approveWalletTopup(legacyTopup.id, 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.inserted.paymentSlipClaims).toHaveLength(1);
    expect(harness.inserted.paymentSlipClaims[0].fileHash).toBe(currentHash);
    expect(harness.inserted.walletTransactions).toHaveLength(1);
    expect(harness.inserted.walletTransactions[0].amount).toBe("260.00");
    expect(harness.status).toBe("approved");
  });

  it("fails closed when trusted legacy current bytes disagree with a persisted file hash", async () => {
    const bytes = Buffer.from("ipe016-changed-wallet-bytes");
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250, fileHash: FILE_A }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(dbModule.approveWalletTopup(legacyTopup.id, 5)).rejects.toMatchObject({
      code: "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL",
    });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
    expect(harness.status).toBe("pending_review");
  });

  it("surfaces NO_STRONG_IDENTIFIER when trusted legacy bytes are unavailable and no other identifier exists", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    await expect(dbModule.approveWalletTopup(legacyTopup.id, 5)).rejects.toMatchObject({
      code: "NO_STRONG_IDENTIFIER",
    });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("keeps SLIP_CURRENT_BYTES_UNAVAILABLE when a reference exists but trusted legacy bytes cannot be re-read", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ referenceRaw: MIXED, reference: UPPER, amount: 250 }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    await expect(dbModule.approveWalletTopup(legacyTopup.id, 5)).rejects.toMatchObject({
      code: "SLIP_CURRENT_BYTES_UNAVAILABLE",
    });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("never fetches an untrusted absolute legacy URL during normal approval", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: "https://attacker.example/slips/4242.png",
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(dbModule.approveWalletTopup(legacyTopup.id, 5)).rejects.toMatchObject({
      code: "SLIP_CURRENT_BYTES_UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses break-glass for an arbitrary absolute URL that is not the trusted historical CDN", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: "https://attacker.example/slips/4242.png",
      reviewReason: "NO_STRONG_IDENTIFIER",
      duplicateStatus: null,
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dbModule.approveWalletTopup(legacyTopup.id, 5, {
        legacyUnprotectedApproval: { reason: "Attempted legacy override for unknown URL" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_BREAK_GLASS_NOT_ELIGIBLE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("allows a separate audited break-glass only when the legacy row remains truly unprotectable", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: null,
      reviewReason: "NO_STRONG_IDENTIFIER",
      duplicateStatus: null,
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);

    await dbModule.approveWalletTopup(legacyTopup.id, 5, {
      legacyUnprotectedApproval: { reason: "Verified old bank statement manually" },
    });

    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toHaveLength(1);
    expect(harness.inserted.walletTransactions[0].note).toMatch(/HIGH-RISK LEGACY BREAK-GLASS/);
    expect(harness.inserted.topupLogs).toHaveLength(1);
    expect(harness.inserted.topupLogs[0].note).toMatch(/Verified old bank statement manually/);
    expect(harness.inserted.topupLogs[0].createdBy).toBe(5);
    expect(harness.status).toBe("approved");
  });

  it("refuses break-glass when any strong identifier is already available", async () => {
    const harness = makeFakeDb({ topup: pendingTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      dbModule.approveWalletTopup(pendingTopup.id, 5, {
        legacyUnprotectedApproval: { reason: "Attempted high-risk manual override" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_BREAK_GLASS_NOT_ELIGIBLE" });
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses break-glass when durable duplicate evidence is already known", async () => {
    const legacyTopup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250 }),
      slipImageUrl: null,
      reviewReason: "NO_STRONG_IDENTIFIER",
      duplicateStatus: JSON.stringify({ isDuplicate: true, type: "file" }),
    };
    const harness = makeFakeDb({ topup: legacyTopup, claims: [] });
    dbModule.__setDbForTests(harness.fake);

    await expect(
      dbModule.approveWalletTopup(legacyTopup.id, 5, {
        legacyUnprotectedApproval: { reason: "Manually checked but duplicate flag remains" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_BREAK_GLASS_CONFLICT" });
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });
});

describe("wallet legacy file-axis risk override", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });

  afterEach(() => {
    dbModule.__setDbForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fileOnlyLegacyTopup(bytes: Buffer, overrides: Record<string, unknown> = {}) {
    const currentHash = hashSlipBytes(bytes);
    return {
      currentHash,
      topup: {
        ...pendingTopup,
        extractedData: JSON.stringify({ amount: 250, fileHash: currentHash }),
        slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
        reviewReason: "LEGACY_APPROVED_SLIP_UNRESOLVED",
        duplicateStatus: null,
        ...overrides,
      },
    };
  }

  it("reproduces the false blocker: normal Approve stays fail-closed on a global representative unknown row with no exact match", async () => {
    const bytes = Buffer.from("ipe017-global-file-axis-normal-block");
    const { topup } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(dbModule.approveWalletTopup(topup.id, 5)).rejects.toMatchObject({
      code: "LEGACY_APPROVED_SLIP_UNRESOLVED",
      message: expect.stringContaining("representative example"),
    });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
    expect(harness.status).toBe("pending_review");
  });

  it("accepts only the global file-axis risk, claims the freshly verified exact fileHash, credits once, and persists admin/reason audit context", async () => {
    const bytes = Buffer.from("ipe017-global-file-axis-override-success");
    const { topup, currentHash } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await dbModule.approveWalletTopup(topup.id, 5, {
      legacyFileAxisRiskApproval: {
        reason: "Verified current slip and accept residual legacy file coverage risk",
      },
    });

    // One fresh current-byte read; the exact hash produced from those bytes is
    // still claimed through the ordinary atomic claim path before value.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.inserted.paymentSlipClaims).toHaveLength(1);
    expect(harness.inserted.paymentSlipClaims[0].fileHash).toBe(currentHash);
    expect(harness.inserted.paymentSlipClaims[0].referenceHash).toBeNull();
    expect(harness.inserted.paymentSlipClaims[0].qrPayloadHash).toBeNull();
    expect(harness.inserted.walletTransactions).toHaveLength(1);
    expect(harness.inserted.walletTransactions[0].amount).toBe("260.00");
    expect(harness.inserted.walletTransactions[0].note).toContain(
      "HIGH-RISK LEGACY FILE-AXIS RISK OVERRIDE approval by admin 5"
    );
    expect(harness.inserted.walletTransactions[0].note).toContain(
      "Verified current slip and accept residual legacy file coverage risk"
    );
    expect(harness.inserted.topupLogs).toHaveLength(1);
    expect(harness.inserted.topupLogs[0].createdBy).toBe(5);
    expect(harness.inserted.topupLogs[0].note).toContain(
      "HIGH-RISK LEGACY FILE-AXIS RISK OVERRIDE"
    );
    expect(harness.status).toBe("approved");
  });

  it("refuses the file-axis override when a reference identifier is available", async () => {
    const bytes = Buffer.from("ipe017-file-axis-reference-ineligible");
    const currentHash = hashSlipBytes(bytes);
    const topup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ referenceRaw: MIXED, fileHash: currentHash, amount: 250 }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
    };
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Attempted risk override despite reference evidence" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_FILE_AXIS_RISK_NOT_ELIGIBLE" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses the file-axis override when a QR identifier is available", async () => {
    const bytes = Buffer.from("ipe017-file-axis-qr-ineligible");
    const currentHash = hashSlipBytes(bytes);
    const topup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ qrPayloadHash: "c".repeat(64), fileHash: currentHash, amount: 250 }),
      slipImageUrl: "https://d2xsxph8kpxj0f.cloudfront.net/slips/4242.png",
    };
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Attempted risk override despite QR evidence available" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_FILE_AXIS_RISK_NOT_ELIGIBLE" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses an exact file duplicate before any risk waiver or credit", async () => {
    const bytes = Buffer.from("ipe017-file-axis-exact-duplicate");
    const { topup, currentHash } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [{ sourceType: "order_payment", sourceId: 88, fileHash: currentHash }],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Risk acceptance must not bypass exact duplicate" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_FILE_AXIS_RISK_NOT_ELIGIBLE" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses a durable known file collision before any risk waiver or credit", async () => {
    const bytes = Buffer.from("ipe017-file-axis-known-collision");
    const { topup, currentHash } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyCollisions: [
        {
          kind: "file",
          identifierHash: currentHash,
          sourceType: "order_payment",
          sourceId: 89,
        },
      ],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Risk acceptance must not bypass known collision" },
      })
    ).rejects.toMatchObject({ code: "LEGACY_FILE_AXIS_RISK_NOT_ELIGIBLE" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses when current bytes disagree with the persisted fileHash", async () => {
    const originalBytes = Buffer.from("ipe017-file-axis-original");
    const changedBytes = Buffer.from("ipe017-file-axis-changed");
    const { topup } = fileOnlyLegacyTopup(originalBytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(changedBytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Should fail when bytes changed after extraction" },
      })
    ).rejects.toMatchObject({ code: "SLIP_INTEGRITY_MISMATCH_AT_APPROVAL" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("refuses when current bytes are unavailable", async () => {
    const bytes = Buffer.from("ipe017-file-axis-unavailable");
    const { topup } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Should fail when current slip cannot be read" },
      })
    ).rejects.toMatchObject({ code: "SLIP_CURRENT_BYTES_UNAVAILABLE" });
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("never fetches an arbitrary absolute URL through the file-axis override", async () => {
    const topup = {
      ...pendingTopup,
      extractedData: JSON.stringify({ amount: 250, fileHash: FILE_A }),
      slipImageUrl: "https://attacker.example/slips/4242.png",
    };
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
    });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Arbitrary URL must not become an SSRF fetch route" },
      })
    ).rejects.toMatchObject({ code: "SLIP_CURRENT_BYTES_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("account-merge source guard refuses the override before current-byte work or credit", async () => {
    const bytes = Buffer.from("ipe017-file-axis-merge-guard");
    const { topup } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
      accountMergeCase: { id: 991, status: "pending" },
    });
    dbModule.__setDbForTests(harness.fake);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Must remain behind account merge source guard" },
      })
    ).rejects.toMatchObject({ code: "ACCOUNT_MERGE_SOURCE_GUARDED" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.inserted.paymentSlipClaims).toBeUndefined();
    expect(harness.inserted.walletTransactions).toBeUndefined();
  });

  it("a lost status race creates no wallet value after the exact-file claim attempt", async () => {
    const bytes = Buffer.from("ipe017-file-axis-state-race");
    const { topup } = fileOnlyLegacyTopup(bytes);
    const harness = makeFakeDb({
      topup,
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 11280001 }],
      approvalAffectedRows: 0,
    });
    dbModule.__setDbForTests(harness.fake);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200 })));

    await expect(
      dbModule.approveWalletTopup(topup.id, 5, {
        legacyFileAxisRiskApproval: { reason: "Concurrent winner must keep this request from crediting" },
      })
    ).rejects.toMatchObject({ code: "TOPUP_STATE_RACE" });
    expect(harness.inserted.walletTransactions).toBeUndefined();
    expect(harness.updates.filter((u) => u.table === "walletAccounts")).toHaveLength(0);
    expect(harness.status).toBe("pending_review");
  });
});

describe("the wallet claim request forwards the override (structural)", () => {
  const code = readCode("server/db.ts");

  it("approveWalletTopup forwards the adjudicated evidence into claimSlip", () => {
    const start = code.indexOf("export async function approveWalletTopup(");
    const end = code.indexOf("export async function rejectWalletTopup(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    expect(body).toMatch(
      /legacyCaseAmbiguityResolution:\s*options\?\.legacyCaseAmbiguityResolution/
    );
  });

  it("the resolution is only ever an input to claimSlip, never a global skip", () => {
    // skipLegacyCheck is the blanket switch; neither resolution override may
    // be wired to it.
    expect(code).not.toMatch(/skipLegacyCheck:\s*options\?\.legacyCaseAmbiguityResolution/);
    expect(code).not.toMatch(/skipLegacyCheck:\s*.*legacyFileAxisRisk/);
  });

  it("the file-axis risk resolution is bound to the freshly recomputed current fileHash before claimSlip", () => {
    const start = code.indexOf("export async function approveWalletTopup(");
    const end = code.indexOf("export async function rejectWalletTopup(");
    const body = code.slice(start, end);
    const recomputeIdx = body.indexOf("currentFileHash = isLegacyStorageUrl");
    const claimIdx = body.indexOf("const claim = await claimSlip(");
    const resolutionIdx = body.indexOf("legacyFileAxisRiskResolution:", claimIdx);
    expect(recomputeIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(recomputeIdx);
    expect(resolutionIdx).toBeGreaterThan(claimIdx);
    expect(body.slice(resolutionIdx, resolutionIdx + 260)).toMatch(
      /expectedFileHash:\s*currentFileHash/
    );
  });

  it("account-merge guard and subject lock remain ahead of all file-axis risk work", () => {
    const start = code.indexOf("export async function approveWalletTopup(");
    const end = code.indexOf("export async function rejectWalletTopup(");
    const body = code.slice(start, end);
    const mergeGuardIdx = body.indexOf("assertAccountMergeClassifiedMutationAllowed");
    const rowLockIdx = body.indexOf("lockWalletTopupForUpdate");
    const overrideIdx = body.indexOf("} else if (fileAxisRiskRequested) {");
    expect(mergeGuardIdx).toBeGreaterThan(-1);
    expect(rowLockIdx).toBeGreaterThan(mergeGuardIdx);
    expect(overrideIdx).toBeGreaterThan(rowLockIdx);
  });

  it("claim and conditional approval stay inside the same transaction and precede wallet value creation", () => {
    const start = code.indexOf("export async function approveWalletTopup(");
    const end = code.indexOf("export async function rejectWalletTopup(");
    const body = code.slice(start, end);
    const transactionIdx = body.indexOf("return await db.transaction");
    const claimIdx = body.indexOf("const claim = await claimSlip(");
    const stateUpdateIdx = body.indexOf("status: \"approved\"");
    const walletCreditIdx = body.indexOf(".update(walletAccounts)");
    const ledgerIdx = body.indexOf("tx.insert(walletTransactions)");
    expect(transactionIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(transactionIdx);
    expect(stateUpdateIdx).toBeGreaterThan(claimIdx);
    expect(walletCreditIdx).toBeGreaterThan(stateUpdateIdx);
    expect(ledgerIdx).toBeGreaterThan(walletCreditIdx);
  });
});

describe("file-axis risk route and UI boundaries (structural)", () => {
  const routerCode = readCode("server/routers.ts");
  const pageCode = readCode("client/src/pages/AdminWalletTopupDetailPage.tsx");

  it("the admin route requires both a reason and the exact explicit confirmation literal", () => {
    const start = routerCode.indexOf("approveLegacyFileAxisRiskTopup:");
    expect(start).toBeGreaterThan(-1);
    const body = routerCode.slice(start, start + 1300);
    expect(body).toMatch(/reason:\s*z\.string\(\)\.trim\(\)\.min\(10\)\.max\(1000\)/);
    expect(body).toMatch(/z\.literal\("ACCEPT_LEGACY_FILE_AXIS_RISK"\)/);
    expect(body).toMatch(/adminApproveLegacyFileAxisRiskWalletTopup/);
  });

  it("the UI exposes the override only from the specific global file-axis unresolved scope", () => {
    expect(pageCode).toMatch(
      /ocrMeta\?\.duplicate\?\.strength === "unresolved"[\s\S]*ocrMeta\?\.duplicate\?\.unresolvedScope === "historical_file_axis_coverage"/
    );
    expect(pageCode).toMatch(/fileAxisCoverageRisk && canApproveOrReject/);
    expect(pageCode).toMatch(/Open Legacy File-Axis Risk Override/);
    expect(pageCode).toMatch(/not a detected[\s\S]*specific historical order/i);
    expect(pageCode).toMatch(/confirmation:\s*"ACCEPT_LEGACY_FILE_AXIS_RISK"/);
  });

  it("the file-axis risk UI remains separate from the NO_STRONG_IDENTIFIER break-glass", () => {
    expect(pageCode).toMatch(/Open Legacy Break-glass Approval/);
    expect(pageCode).toMatch(/Open Legacy File-Axis Risk Override/);
    expect(pageCode).toMatch(/APPROVE_UNPROTECTED_LEGACY_TOPUP/);
    expect(pageCode).toMatch(/ACCEPT_LEGACY_FILE_AXIS_RISK/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. A LOST STATE RACE MUST NEVER REOPEN A FINALIZED TOP-UP
// ════════════════════════════════════════════════════════════════════════

describe("TOPUP_STATE_RACE is a state outcome, not a review outcome", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("the state race is handled BEFORE the generic claim-error branch", () => {
    const raceIdx = code.indexOf('claimCode === "TOPUP_STATE_RACE"');
    const genericIdx = code.indexOf("if (claimCode) {");
    expect(raceIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(raceIdx).toBeLessThan(genericIdx);
  });

  it("the state race returns the current state instead of calling handlePendingReview", () => {
    const raceIdx = code.indexOf('claimCode === "TOPUP_STATE_RACE"');
    const genericIdx = code.indexOf("if (claimCode) {");
    const branch = code.slice(raceIdx, genericIdx);
    // IPE-001 wallet round: TOPUP_STATE_RACE (finalization) and
    // TOPUP_SLIP_VERSION_CHANGED (slip replaced mid-flight) share this one
    // terminal outcome, distinguished by which reason gets recorded rather
    // than by two separate branches - buildSupersededResult itself then
    // re-derives which actually happened from the persisted row.
    expect(branch).toMatch(/claimCode === "TOPUP_SLIP_VERSION_CHANGED"/);
    expect(branch).toMatch(/return await buildSupersededResult\(topupId, expectedSlipVersion\)/);
    expect(branch).not.toMatch(/handlePendingReview/);
  });

  it("the superseded result mutates nothing", () => {
    const start = code.indexOf("async function buildSupersededResult(");
    const end = code.indexOf("async function handlePendingReview(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, end);
    // A read, and nothing else.
    expect(body).toMatch(/db\.getWalletTopupById\(topupId\)/);
    expect(body).not.toMatch(/applyWalletTopupOcrUpdate|updateWalletTopupWithOCRApproval/);
    expect(body).not.toMatch(/db\.approveWalletTopup|db\.rejectWalletTopup|claimSlip/);
    // The only credited amount it can report is "none".
    expect(body).toMatch(/creditedAmount: undefined/);
  });

  it("it reports the persisted status, never a hard-coded pending_review", () => {
    const start = code.indexOf("async function buildSupersededResult(");
    const end = code.indexOf("async function handlePendingReview(");
    const body = code.slice(start, end);
    expect(body).toMatch(/current\?\.status/);
  });

  it("attempt history identifies a STATE race, not a provider fault or a duplicate", () => {
    const raceIdx = code.indexOf('claimCode === "TOPUP_STATE_RACE"');
    const branch = code.slice(raceIdx, raceIdx + 700);
    expect(branch).toMatch(/"TOPUP_SUPERSEDED_BY_FINALIZATION"/);
    expect(branch).toMatch(/"STATE"/);
    expect(branch).not.toMatch(/OCR_PROCESSING_ERROR|DUPLICATE_/);
  });
});

describe("pending-review writes cannot reopen a finalized top-up", () => {
  const dbCode = readCode("server/db.ts");
  const serviceCode = readCode("server/services/walletTopupSubmissionService.ts");

  it("the OCR update is conditional on a reviewable status when it targets pending_review", () => {
    const start = dbCode.indexOf("export async function applyWalletTopupOcrUpdate(");
    expect(start).toBeGreaterThan(-1);
    const end = dbCode.indexOf("return { applied:", start);
    expect(end).toBeGreaterThan(start);
    const body = dbCode.slice(start, end + 200);
    expect(body).toMatch(/const guarded = updates\.status === "pending_review"/);
    expect(body).toMatch(/REVIEWABLE_TOPUP_STATUSES/);
    expect(body).toMatch(/affectedRows/);
    expect(body).toMatch(/return \{ applied: !guarded \|\| affectedRows > 0, topup \}/);
    // The version guard is READ-only comparison state that narrows the
    // guarded WHERE clause - never applied to the write itself.
    expect(body).toMatch(/expectedSlipVersion\?:/);
    expect(body).toMatch(/if \(expectedSlipVersion\) \{/);
  });

  it("the reviewable set excludes every final status", () => {
    expect(dbCode).toMatch(
      /const REVIEWABLE_TOPUP_STATUSES = \["pending", "pending_review"\] as const/
    );
    const start = dbCode.indexOf("const REVIEWABLE_TOPUP_STATUSES");
    const line = dbCode.slice(start, dbCode.indexOf("\n", start));
    expect(line).not.toMatch(/approved|rejected|cancelled/);
  });

  it("the legacy wrapper keeps the same guard rather than bypassing it", () => {
    const start = dbCode.indexOf("export async function updateWalletTopupWithOCRApproval(");
    const body = dbCode.slice(start, start + 500);
    expect(body).toMatch(/await applyWalletTopupOcrUpdate\(topupId, updates\)/);
    expect(body).not.toMatch(/\.update\(walletTopups\)/);
  });

  it("all three review handlers honour a refused write", () => {
    const handlers = ["handlePendingReview", "handleDuplicate", "handleOCRError"];
    for (const handler of handlers) {
      const start = serviceCode.indexOf(`async function ${handler}(`);
      expect(start, handler).toBeGreaterThan(-1);
      const body = serviceCode.slice(start, start + 4200);
      expect(body, handler).toMatch(/applyWalletTopupOcrUpdate/);
      expect(body, handler).toMatch(/if \(!applied\) \{\s*\n\s*return await buildSupersededResult/);
    }
  });

  it("the auto-approval helper's pending_review branch is conditional too", () => {
    const start = dbCode.indexOf("export async function approveWalletTopupWithOCR(");
    const body = dbCode.slice(start, dbCode.indexOf("export ", start + 50));
    expect(body).not.toMatch(/For pending_review: update regardless of current status/);
    expect(body).toMatch(/const reviewAffected/);
    expect(body).toMatch(/reviewAffected === 0/);
  });

  it("the wallet result type can report a finalized status without inventing one", () => {
    expect(serviceCode).toMatch(
      /status: "pending_review" \| "approved" \| "rejected" \| "cancelled"/
    );
    expect(serviceCode).toMatch(/supersededByFinalization\?: boolean/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. PAGINATION BOUNDARIES
// ════════════════════════════════════════════════════════════════════════

/** Serves each table's rows page by page, exactly as keyset paging would. */
function makeScanTx(rows: { payments?: any[]; walletTopups?: any[] }) {
  const served: Record<string, number> = { payments: 0, walletTopups: 0 };
  const queries: Record<string, number> = { payments: 0, walletTopups: 0 };

  return {
    queries,
    tx: {
      select() {
        return {
          from(table: any) {
            const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      limit: async (n: number) => {
                        const all = (rows as any)[name] ?? [];
                        queries[name] = (queries[name] ?? 0) + 1;
                        const page = all.slice(served[name], served[name] + n);
                        served[name] += page.length;
                        return page;
                      },
                    };
                  },
                  limit: async () => [],
                };
              },
            };
          },
        };
      },
    },
  };
}

function filler(count: number, startId = 1): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    extractedData: JSON.stringify({ referenceRaw: `NOISE${startId + i}`, fileHash: FILE_B }),
  }));
}

function lossyRow(id: number) {
  // A legacy row that kept ONLY the upper-cased reference.
  return { id, extractedData: JSON.stringify({ reference: UPPER }) };
}

function exactRow(id: number) {
  return { id, extractedData: JSON.stringify({ referenceRaw: MIXED }) };
}

const lookup = { referenceHash: MIXED_HASH, referenceHashUpperCandidate: UPPER_HASH };

describe("a terminal empty page must not erase the lossy fallback", () => {
  it("A. exactly SCAN_PAGE_SIZE rows, lossy match in row 1 -> still ambiguity", async () => {
    const rows = [lossyRow(1), ...filler(SCAN_PAGE_SIZE - 1, 2)];
    expect(rows).toHaveLength(SCAN_PAGE_SIZE);

    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);

    // The full page forces a second, EMPTY query - the exact boundary that
    // previously returned undefined and let the replay create value.
    expect(harness.queries.payments).toBe(2);
    expect(match).toBeDefined();
    expect(match!.matchedBy).toBe("legacy_uppercase_only");
    expect(match!.sourceId).toBe(1);
  });

  it("B. exactly 2 x SCAN_PAGE_SIZE rows, lossy match in page 1 -> preserved", async () => {
    const rows = [lossyRow(1), ...filler(2 * SCAN_PAGE_SIZE - 1, 2)];
    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);

    expect(harness.queries.payments).toBe(3);
    expect(match?.matchedBy).toBe("legacy_uppercase_only");
  });

  it("C. SCAN_PAGE_SIZE + 1 rows still works", async () => {
    const rows = [lossyRow(1), ...filler(SCAN_PAGE_SIZE, 2)];
    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);
    expect(match?.matchedBy).toBe("legacy_uppercase_only");
  });

  it("D. SCAN_PAGE_SIZE - 1 rows still works", async () => {
    const rows = [lossyRow(1), ...filler(SCAN_PAGE_SIZE - 2, 2)];
    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);
    expect(harness.queries.payments).toBe(1);
    expect(match?.matchedBy).toBe("legacy_uppercase_only");
  });

  it("H. no exact and no lossy match -> no conflict", async () => {
    const harness = makeScanTx({ payments: filler(SCAN_PAGE_SIZE) });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);
    expect(match).toBeUndefined();
  });
});

describe("exact still beats lossy across pages and across sources", () => {
  it("E. lossy in row 1, exact in the LAST row of the page -> exact wins", async () => {
    const rows = [
      lossyRow(1),
      ...filler(SCAN_PAGE_SIZE - 2, 2),
      exactRow(SCAN_PAGE_SIZE),
    ];
    expect(rows).toHaveLength(SCAN_PAGE_SIZE);

    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);

    expect(match?.matchedBy).toBe("reference_exact");
    expect(match?.sourceId).toBe(SCAN_PAGE_SIZE);
  });

  it("E2. lossy in page 1, exact in page 2 -> exact wins", async () => {
    const rows = [
      lossyRow(1),
      ...filler(SCAN_PAGE_SIZE - 1, 2),
      exactRow(SCAN_PAGE_SIZE + 1),
    ];
    const harness = makeScanTx({ payments: rows });
    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);
    expect(match?.matchedBy).toBe("reference_exact");
  });

  it("F. lossy in ORDER rows, exact in WALLET rows -> exact wins globally", async () => {
    const harness = makeScanTx({
      // Exactly SCAN_PAGE_SIZE order rows, so the order scan ends on an
      // empty page while holding the lossy fallback.
      payments: [lossyRow(1), ...filler(SCAN_PAGE_SIZE - 1, 2)],
      walletTopups: [exactRow(90)],
    });

    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);

    expect(match?.matchedBy).toBe("reference_exact");
    expect(match?.sourceType).toBe("wallet_topup");
  });

  it("G. lossy in ORDER rows survives EOF while WALLET rows hold no conflict", async () => {
    const harness = makeScanTx({
      payments: [lossyRow(1), ...filler(SCAN_PAGE_SIZE - 1, 2)],
      walletTopups: filler(SCAN_PAGE_SIZE, 5000),
    });

    const match = await findLegacyApprovedDuplicate(lookup, undefined, harness.tx);

    expect(match?.matchedBy).toBe("legacy_uppercase_only");
    expect(match?.sourceType).toBe("order_payment");
  });

  it("an exact FILE match still outranks a lossy reference fold", async () => {
    const harness = makeScanTx({
      payments: [
        lossyRow(1),
        { id: 2, extractedData: JSON.stringify({ fileHash: FILE_A }) },
      ],
    });

    const match = await findLegacyApprovedDuplicate(
      { ...lookup, fileHash: FILE_A },
      undefined,
      harness.tx
    );

    expect(match?.matchedBy).toBe("file_exact");
  });

  it("regression: the empty-page exit returns the fallback, not undefined", () => {
    const code = readCode("server/services/legacySlipCompatibilityService.ts");
    expect(code).toMatch(/if \(!page \|\| page\.length === 0\) return fallback;/);
    expect(code).not.toMatch(/if \(!page \|\| page\.length === 0\) return undefined;/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. confirmed_duplicate COMMITS WITH ITS REJECTION
// ════════════════════════════════════════════════════════════════════════

describe("a duplicate resolution commits with its rejection", () => {
  const code = readCode("server/services/legacyCaseResolutionService.ts");

  it("the resolution is no longer written before the rejection flow", () => {
    expect(code).not.toMatch(/await insertResolution\(\s*\n?\s*await requireDb\(\)/);
    expect(code).not.toMatch(/adapter\.reject\(\{/);
  });

  it("the record is a callback handed to the rejection, like the approval path", () => {
    const start = code.indexOf('if (input.decision === "confirmed_duplicate")');
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, start + 2200);
    expect(body).toMatch(/await adapter\.rejectWithResolution\(\{/);
    expect(body).toMatch(/auditResolution: async \(tx: any\) => \{/);
    expect(body).toMatch(/await insertResolution\(tx, \{/);
  });

  it("the audit revalidates the ambiguity against state inside the transaction", () => {
    const start = code.indexOf('if (input.decision === "confirmed_duplicate")');
    const body = code.slice(start, start + 2200);
    // Re-derived from CURRENT extraction under the row lock, and required to
    // EQUAL the adjudicated fold - "an ambiguity is still present" was
    // satisfied by a DIFFERENT one, which is exactly the hole that left.
    expect(body).toMatch(/requireUnchangedAmbiguityInTx\(input, adapter, adjudicated, tx\)/);
    expect(code).toMatch(/adapter\.loadInTx\(tx\)/);
    expect(code).toMatch(/!live\.present \|\| !sameAmbiguity\(adjudicated, live\)/);
  });

  it("BOTH subject types expose a transactional rejection", () => {
    expect(code).toMatch(/rejectWithResolution\(args: \{/);
    // Order: its own transaction, conditional reject as the arbiter.
    expect(code).toMatch(/await database\.transaction\(async \(tx: any\) => \{/);
    expect(code).toMatch(/await db\.rejectPaymentIfReviewable\(/);
    expect(code).toMatch(/orderService\.rejectPayment\(input\.subjectId, String\(adminUserId\), reason, tx\)/);
    // Wallet: reuses the existing conditional rejection transaction.
    expect(code).toMatch(/db\.rejectWalletTopup\(input\.subjectId, adminUserId, reason, \{/);
    // Revalidation runs before the status change; the audit after it.
    expect(code).toMatch(/revalidate,[\s\S]{0,40}?auditResolution,/);
  });

  it("the order rejection reuses the canonical locked reviewability helper inside the transaction", () => {
    const start = code.indexOf(
      "async rejectWithResolution({ adminUserId, reason, revalidate, auditResolution })"
    );
    const body = code.slice(start, start + 2200);
    expect(body).toMatch(/orderService\.lockAndRequireReviewablePayment\(input\.subjectId, tx\)/);
  });

  it("losing the conditional rejection raises CONFLICT so the record rolls back", () => {
    const start = code.indexOf(
      "async rejectWithResolution({ adminUserId, reason, revalidate, auditResolution })"
    );
    const body = code.slice(start, start + 2200);
    expect(body).toMatch(/if \(!won\) \{/);
    expect(body).toMatch(/code: "CONFLICT"/);
  });

  it("the audit runs LAST, after the rejection has been confirmed to have won", () => {
    const start = code.indexOf(
      "async rejectWithResolution({ adminUserId, reason, revalidate, auditResolution })"
    );
    const body = code.slice(start, start + 2200);
    const wonIdx = body.indexOf("rejectPaymentIfReviewable");
    const auditIdx = body.indexOf("await auditResolution(tx)");
    expect(wonIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(wonIdx);
  });
});

describe("the rejection primitives are conditional", () => {
  const dbCode = readCode("server/db.ts");

  it("rejectPaymentIfReviewable refuses to touch a finalized payment", () => {
    const start = dbCode.indexOf("export async function rejectPaymentIfReviewable(");
    expect(start).toBeGreaterThan(-1);
    const body = dbCode.slice(start, start + 1400);
    // The guard is in the WHERE clause: only a reviewable row may be moved.
    const whereStart = body.indexOf(".where(");
    const where = body.slice(whereStart, body.indexOf("const header", whereStart));
    expect(where).toMatch(/eq\(payments\.status, "pending"\)/);
    expect(where).toMatch(/eq\(payments\.status, "pending_review"\)/);
    expect(where).not.toMatch(/"approved"|"cancelled"/);
    expect(body).toMatch(/affectedRows \|\| 0\) > 0/);
  });

  it("rejectWalletTopup runs the audit inside its existing conditional transaction", () => {
    const start = dbCode.indexOf("export async function rejectWalletTopup(");
    const end = dbCode.indexOf("export async function repairWalletTopupCredit(");
    const body = dbCode.slice(start, end);
    // The conditional update, its zero-row throw, and only then the audit.
    const condIdx = body.indexOf("Wallet top-up cannot be rejected");
    const auditIdx = body.indexOf("options.auditResolution(tx)");
    expect(condIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(condIdx);
    expect(body).toMatch(/eq\(walletTopups\.status, "pending" as any\)/);
  });
});

describe("the subject-level uniqueness still means one SUCCESSFUL resolution", () => {
  const code = readCode("server/services/legacyCaseResolutionService.ts");

  it("every insertResolution call now takes a transaction, never a bare connection", () => {
    // Call sites only - the declaration names its first parameter.
    const calls = code.match(/await insertResolution\(([^,]+),/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/insertResolution\(tx,/);
    }
  });

  it("a duplicate key is still reported as CONFLICT rather than silently ignored", () => {
    expect(code).toMatch(/ER_DUP_ENTRY/);
    expect(code).toMatch(/code: "CONFLICT"/);
  });
});
