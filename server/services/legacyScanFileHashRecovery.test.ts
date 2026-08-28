/**
 * IPE-001 P1: "Include extraction-less approvals in the live legacy scan".
 *
 * ── The bug ─────────────────────────────────────────────────────────────
 * The live compatibility scan (legacySlipCompatibilityService.ts) selected
 * approved rows with `isNotNull(extractedDataColumn)`, so an approved
 * historical payment/top-up with `extractedData = NULL` - a legitimate shape
 * from an older OCR-disabled/manual-approval flow - was invisible to live
 * anti-replay protection entirely, even though it created real value. A
 * replay of the exact stored image could produce a fresh fileHash, see no
 * registry claim, see no legacy scan match, and create financial value
 * again.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 * The scan predicate no longer filters on extractedData. For a row with no
 * persisted fileHash, a submission that DOES carry a fileHash to compare now
 * triggers server-side recovery from the row's own `slipImageUrl` via the
 * same production primitive new submissions use (`computeSlipFileHash`).
 * A row that cannot be evaluated at all (no slipImageUrl, or recovery fails)
 * is UNRESOLVED - never silently treated as "no conflict". It fails closed
 * through a new `SlipConflict`/`SlipClaimOutcome` kind
 * (`unresolved` / `legacy_scan_unresolved`), distinct from both a proven
 * duplicate and an ordinary review outcome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claimSlip } from "./slipClaimService";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import * as backfillState from "./slipBackfillStateService";
import * as slipFileHashService from "./slipFileHashService";
import { hashSlipReference } from "./slipIdentifierService";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the SQL scan predicate itself no longer excludes NULL extraction", () => {
  // The mocked transaction used throughout this file does not evaluate a
  // real drizzle WHERE expression - it pages an in-memory array by cursor
  // only - so it cannot discriminate on the SQL predicate change itself.
  // This structural check pins that directly.
  const code = readCode("server/services/legacySlipCompatibilityService.ts");

  it("scanApproved's WHERE no longer filters on extractedDataColumn", () => {
    expect(code).not.toMatch(/isNotNull\(extractedDataColumn\)/);
    expect(code).not.toMatch(/isNotNull,/);
    const start = code.indexOf("async function scanApproved<T");
    const body = code.slice(start, start + 1200);
    expect(body).toMatch(/eq\(statusColumn, "approved"\), gt\(idColumn, cursor\)/);
  });

  it("slipImageUrl is selected for both order-payment and wallet-topup scans", () => {
    expect(code).toMatch(/payments\.slipImageUrl/);
    expect(code).toMatch(/walletTopups\.slipImageUrl/);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FILE_A = "a".repeat(64);
const FILE_B = "b".repeat(64);
const REF = "016234222922AQR05745";
const REF_HASH = hashSlipReference(REF)!;

/**
 * Fake transaction mirroring legacySlipCompatibilityService.test.ts's
 * makeFakeTx, extended with `slipImageUrl` on rows and a claims table so it
 * can be driven through the real claimSlip() entry point.
 */
function makeFakeTx(
  options: {
    approvedPayments?: Array<{ id: number; extractedData: string | null; slipImageUrl?: string | null }>;
    approvedTopups?: Array<{ id: number; extractedData: string | null; slipImageUrl?: string | null }>;
    pageSize?: number;
  } = {}
) {
  const claims: any[] = [];
  const pageSize = options.pageSize ?? 500;
  const cursorsSeen: Record<string, number[]> = { payments: [], walletTopups: [] };

  return {
    _claims: claims,
    _cursorsSeen: cursorsSeen,
    insert() {
      return {
        async values(v: any) {
          claims.push(v);
          return [{ insertId: claims.length }];
        },
      };
    },
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          const rows =
            name === "payments"
              ? (options.approvedPayments ?? [])
              : name === "walletTopups"
                ? (options.approvedTopups ?? [])
                : [];
          return {
            // findAnyLegacyFileIdentityUnknown (IPE-004-C03) calls
            // select().from(...).limit(1) directly, with no .where() at all -
            // the only such shape here. This fixture never seeds
            // paymentSlipLegacyUnknown, so it is always empty.
            limit: (n: number) =>
              Promise.resolve(name === "paymentSlipLegacyUnknown" ? [] : rows.slice(0, n)),
            where(cond: any) {
              const cursor = extractCursor(cond);
              if (name in cursorsSeen) cursorsSeen[name].push(cursor);
              return {
                orderBy() {
                  return {
                    limit(n: number) {
                      if (name === "paymentSlipClaims") return Promise.resolve([]);
                      const page = rows
                        .filter((r) => r.id > cursor)
                        .sort((a, b) => a.id - b.id)
                        .slice(0, Math.min(n, pageSize));
                      return Promise.resolve(page);
                    },
                  };
                },
                limit(n: number) {
                  if (name === "paymentSlipClaims") return Promise.resolve([]);
                  return Promise.resolve(rows.slice(0, n));
                },
              };
            },
          };
        },
      };
    },
  };
}

function extractCursor(cond: any): number {
  const found: number[] = [];
  const walk = (node: any, depth = 0) => {
    if (!node || depth > 8) return;
    if (typeof node === "number") found.push(node);
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") {
      for (const key of Object.keys(node)) walk((node as any)[key], depth + 1);
    }
  };
  walk(cond);
  return found.length ? Math.max(...found) : 0;
}

describe("A/B. NULL-extraction legacy row, matching image -> strong duplicate, no value created", () => {
  it("A. order payment", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_A);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 11, extractedData: null, slipImageUrl: "r2p:payment-slips/old" }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 99, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("order_payment");
      expect(outcome.existingSourceId).toBe(11);
      expect(outcome.viaLegacyCompatibility).toBe(true);
    }
    expect(tx._claims).toHaveLength(0);
  });

  it("B. wallet top-up", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_A);
    const tx = makeFakeTx({
      approvedTopups: [{ id: 77, extractedData: null, slipImageUrl: "r2p:payment-slips/old" }],
    });

    const outcome = await claimSlip(
      { sourceType: "order_payment", sourceId: 5, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("wallet_topup");
      expect(outcome.existingSourceId).toBe(77);
    }
  });
});

describe("C. NULL-extraction legacy row, DIFFERENT recovered image -> genuinely no conflict", () => {
  it("recovery succeeds and proves the rows are different files", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_B);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 11, extractedData: null, slipImageUrl: "r2p:payment-slips/old" }],
    });

    const outcome = await claimSlip(
      { sourceType: "order_payment", sourceId: 500, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(true);
  });
});

describe("D. extractedData exists but has no strong identifier -> recovery still participates", () => {
  it("a row with only a bare amount field still triggers recovery and blocks a real replay", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_A);
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 21,
          extractedData: JSON.stringify({ amount: 100 }),
          slipImageUrl: "r2p:payment-slips/old",
        },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 501, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
  });
});

describe("E/F. unresolved rows fail closed, never silently pass as 'no conflict'", () => {
  it("E. slipImageUrl exists but hash recovery fails -> unresolved, no claim, no value", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 31, extractedData: null, slipImageUrl: "r2p:payment-slips/gone" }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 502, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_scan_unresolved");
    }
    expect(tx._claims).toHaveLength(0);
  });

  it("F. no slipImageUrl and no usable identifier -> unresolved, fails closed", async () => {
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [{ id: 32, extractedData: null, slipImageUrl: null }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 503, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_scan_unresolved");
    }
    // No network/recovery call was even attempted - nothing to recover from.
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("IPE-001-C01: a row this scan cannot evaluate at all is STILL unresolved, even when the incoming submission carries no fileHash to compare", async () => {
    // Previously, an incoming submission with no fileHash short-circuited
    // straight to "no conflict" before this row's own resolvability was even
    // considered - so a transient failure computing the INCOMING fileHash
    // (or any flow that never carries one) let a row with a totally unknown
    // file identity slide through as clean. The row's own resolvability is
    // what must decide: no persisted hash, no slipImageUrl to recover from ->
    // genuinely unknown -> fails closed, regardless of the incoming side.
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [{ id: 33, extractedData: null, slipImageUrl: null }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 504, userId: 1, identifiers: { referenceHash: REF_HASH } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_scan_unresolved");
    }
    // No network/recovery call was even attempted - there is no slipImageUrl
    // for this row to recover from, independent of the incoming fileHash gap.
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("IPE-001-C01: when the row's OWN identity IS resolvable, recovery is now attempted even without an incoming fileHash - and a failure there still fails closed", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 34, extractedData: null, slipImageUrl: "r2p:payment-slips/gone" }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 505, userId: 1, identifiers: { referenceHash: REF_HASH } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_scan_unresolved");
    }
    expect(slipFileHashService.computeSlipFileHash).toHaveBeenCalledWith("r2p:payment-slips/gone");
  });

  it("F. a row that IS fully evaluable via its own persisted fileHash is NOT converted to unresolved merely because the incoming submission lacks one", async () => {
    // A merely missing incoming fileHash must not, by itself, turn every
    // fully evaluable nonmatch into unresolved - only a row whose OWN
    // identity cannot be established does that.
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [
        { id: 35, extractedData: JSON.stringify({ fileHash: FILE_B }), slipImageUrl: null },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 506, userId: 1, identifiers: { referenceHash: REF_HASH } },
      tx
    );

    expect(outcome.claimed).toBe(true);
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("F2. a row with reference evidence that simply does NOT match is a resolved nonmatch, not unresolved - even with no incoming fileHash and no recoverable image", async () => {
    // The row has SOME reference evidence (it just isn't this submission's).
    // That already independently proves it is not a match; the file axis
    // being unknown on top of that must not convert it to unresolved -
    // otherwise every approved historical row with an unrelated reference
    // and no stored image would fail-close every unrelated new submission
    // whose own fileHash happens to be unavailable.
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 36,
          extractedData: JSON.stringify({ reference: "SOME-OTHER-REFERENCE", amount: 1 }),
          slipImageUrl: null,
        },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 507, userId: 1, identifiers: { referenceHash: REF_HASH } },
      tx
    );

    expect(outcome.claimed).toBe(true);
    expect(computeSpy).not.toHaveBeenCalled();
  });
});

describe("IPE-001-C02: a nonmatching reference must never suppress exact-file replay detection when the incoming submission HAS a fileHash", () => {
  // C01's fix skipped file-axis recovery entirely whenever a historical row
  // carried ANY reference evidence, even if none of it matched the incoming
  // submission. That is only safe when there is nothing on the incoming side
  // to compare (see F2 above) - when the incoming submission DOES carry a
  // fileHash, a stale, incorrect, or merely unrelated reference field must
  // never suppress a real same-image comparison.

  it("1. reference evidence present but mismatched, no persisted fileHash, recoverable image matches incoming fileHash -> strong duplicate, no value created", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_A);
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 40,
          extractedData: JSON.stringify({ reference: "UNRELATED-REFERENCE", amount: 1 }),
          slipImageUrl: "r2p:payment-slips/replay",
        },
      ],
    });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 508,
        userId: 1,
        identifiers: { referenceHash: REF_HASH, fileHash: FILE_A },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceId).toBe(40);
      expect(outcome.viaLegacyCompatibility).toBe(true);
    }
    expect(tx._claims).toHaveLength(0);
  });

  it("2. same as (1) but the incoming submission has NO reference at all - the file axis alone still catches the replay", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_A);
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 41,
          extractedData: JSON.stringify({ reference: "UNRELATED-REFERENCE", amount: 1 }),
          slipImageUrl: "r2p:payment-slips/replay2",
        },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 509, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceId).toBe(41);
    }
  });

  it("3. recovered fileHash genuinely differs -> no conflict, the reference-based reasoning is not needed to prove it", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(FILE_B);
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 42,
          extractedData: JSON.stringify({ reference: "UNRELATED-REFERENCE", amount: 1 }),
          slipImageUrl: "r2p:payment-slips/different",
        },
      ],
    });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 510,
        userId: 1,
        identifiers: { referenceHash: REF_HASH, fileHash: FILE_A },
      },
      tx
    );

    expect(outcome.claimed).toBe(true);
  });

  it("4. incoming fileHash unavailable + independent nonmatching exact reference -> retains the C01 non-overblocking behavior (regression guard for F2)", async () => {
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [
        {
          id: 43,
          extractedData: JSON.stringify({ reference: "UNRELATED-REFERENCE", amount: 1 }),
          slipImageUrl: "r2p:payment-slips/never-fetched",
        },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 511, userId: 1, identifiers: { referenceHash: REF_HASH } },
      tx
    );

    expect(outcome.claimed).toBe(true);
    expect(computeSpy).not.toHaveBeenCalled();
  });
});

describe("G. pagination boundary: unresolved/recoverable rows are not skipped across pages", () => {
  const filler = (n: number, imageUrl: string | null = null) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      extractedData: null as string | null,
      slipImageUrl: imageUrl,
    }));

  it("a recoverable duplicate beyond the first page is still found", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockImplementation(async (url) =>
      url === "r2p:payment-slips/target" ? FILE_A : undefined
    );
    const rows = filler(1200);
    rows[rows.length - 1] = {
      id: 1200,
      extractedData: null,
      slipImageUrl: "r2p:payment-slips/target",
    };
    // Every other filler row has no slipImageUrl - each is individually
    // unresolved, but the scan must still reach row 1200 and find the exact
    // match rather than stopping or losing coverage at a page boundary.
    // (This also proves an unresolved fallback never short-circuits ahead of
    // a later strong match, mirroring the existing lossy-fold-vs-exact test.)

    const tx = makeFakeTx({ approvedPayments: rows, pageSize: 500 });
    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 7001, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceId).toBe(1200);
    }
    const cursors = tx._cursorsSeen.payments;
    expect(cursors.length).toBeGreaterThan(2);
  });

  it("with no recoverable match anywhere, the run reports unresolved rather than a false 'clean'", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeFakeTx({ approvedPayments: filler(1200, "r2p:payment-slips/unreadable"), pageSize: 500 });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 7002, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_scan_unresolved");
  });
});

describe("H. an exact match still outranks BOTH a lossy fold and an unresolved row", () => {
  it("a later exact reference beats an earlier unresolved row", async () => {
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeFakeTx({
      approvedPayments: [
        { id: 1, extractedData: null, slipImageUrl: null }, // unresolved
        { id: 2, extractedData: JSON.stringify({ referenceRaw: REF }) }, // exact
      ],
    });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 8000,
        userId: 1,
        identifiers: { referenceHash: REF_HASH },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceId).toBe(2);
    }
    // Row 1 has no reference match and no slipImageUrl to recover from, so it
    // is unresolved WITHOUT a network call (independent of the incoming
    // fileHash gap - see IPE-001-C01 tests above); the later exact reference
    // match still outranks that unresolved fallback, exactly as it outranks
    // a lossy fold.
    expect(computeSpy).not.toHaveBeenCalled();
  });
});

describe("I. after backfill completion the live scan (and recovery) never runs", () => {
  it("isLegacyScanRequired() = false short-circuits before any legacy row is touched", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { fileHash: FILE_A },
        sourceType: "wallet_topup",
        sourceId: 1,
      },
      makeFakeTx({ approvedPayments: [{ id: 1, extractedData: null, slipImageUrl: null }] })
    );

    expect(conflict.kind).toBe("none");
    expect(computeSpy).not.toHaveBeenCalled();
  });
});

describe("the conflict evaluator surfaces 'unresolved' distinctly from a duplicate and an ambiguity", () => {
  it("evaluateSlipConflict returns kind: unresolved with the matched source", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 44, extractedData: null, slipImageUrl: "r2p:payment-slips/x" }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") {
      expect(conflict.matchedSourceType).toBe("order_payment");
      expect(conflict.matchedSourceId).toBe(44);
    }
  });
});
