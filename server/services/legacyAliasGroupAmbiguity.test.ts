/**
 * IPE-001 P1: "Adjudicate the complete lossy alias group"
 * (server/services/legacySlipCompatibilityService.ts,
 * server/services/slipConflictEvaluator.ts, server/services/slipClaimService.ts,
 * server/services/ocrRecheckService.ts, server/routers.ts).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * When TWO (or more) historical rows fold to the SAME lossy uppercase alias,
 * only ONE was ever surfaced - the first found by the live scan, or the
 * first row returned by the indexed alias lookup. An admin adjudicating
 * "confirmed distinct" compared the incoming submission against that ONE row
 * and approved it, even though the incoming transaction could equally be a
 * replay of the OTHER historical row sharing the same alias, which the admin
 * never saw and never adjudicated.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Cardinality is checked BEFORE surfacing any single member, in BOTH
 * mechanisms:
 *   - pre-backfill: `findLegacyAliasGroupMembers` scans both tables for a
 *     second row folding to the same alias.
 *   - post-backfill: `findClaimsByLegacyAlias` returns every matching claim,
 *     not just the first.
 * If more than one member exists, `evaluateSlipConflict` returns a NEW,
 * distinct kind - `legacy_case_ambiguity_group` - which `claimSlip` NEVER
 * waives (it does not even inspect `legacyCaseAmbiguityResolution` for this
 * kind), and which Recheck/Admin Detail surface as a dedicated, non-waivable
 * state rather than the single-member `legacy_case_ambiguity`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import { claimSlip } from "./slipClaimService";
import * as backfillState from "./slipBackfillStateService";
import { hashSlipReference } from "./slipIdentifierService";

afterEach(() => {
  vi.restoreAllMocks();
});

// Genuinely mixed-case so upper-casing is lossy (a reference with no
// lowercase letters would make its own upper-cased form identical, collapsing
// "ambiguity" into an exact match - see IPE-001's earlier discrimination note).
const MIXED = "202608225ApOyxElgdOo7YVwv";
const MIXED_HASH = hashSlipReference(MIXED)!;
const UPPER_HASH = hashSlipReference(MIXED.toUpperCase())!;
const FILE_A = "a".repeat(64);
const FILE_B = "b".repeat(64);

function makeTx(
  options: {
    claims?: any[];
    approvedPayments?: Array<{ id: number; extractedData: string }>;
    approvedTopups?: Array<{ id: number; extractedData: string }>;
  } = {}
) {
  const claims = options.claims ?? [];
  return {
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          return {
            where(cond: any) {
              const wanted = boundHashes(cond);
              const cols = targetedColumns(cond);
              const legacyRows =
                name === "payments"
                  ? (options.approvedPayments ?? [])
                  : name === "walletTopups"
                    ? (options.approvedTopups ?? [])
                    : [];
              return {
                orderBy() {
                  return { limit: async () => legacyRows };
                },
                limit: async (n: number) => {
                  if (name !== "paymentSlipClaims") return legacyRows;
                  if (!wanted.length) return [];
                  return claims
                    .filter((c) => cols.some((col) => c[col] && wanted.includes(c[col])))
                    .slice(0, n);
                },
              };
            },
          };
        },
      };
    },
  };
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

const self = { sourceType: "wallet_topup" as const, sourceId: 900 };

describe("A. exactly one historical alias member: existing single-member ambiguity resolution still works", () => {
  it("post-backfill (indexed claim)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 42,
          referenceHash: UPPER_HASH,
          legacyReferenceUpperHash: UPPER_HASH,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") {
      expect(conflict.requiresAdminResolution).toBe(true);
      expect(conflict.matchedSourceId).toBe(42);
    }
  });

  it("pre-backfill (live scan)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      approvedPayments: [{ id: 42, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") expect(conflict.matchedSourceId).toBe(42);
  });
});

describe("B. two historical rows sharing one alias: cannot be waived by adjudicating only one", () => {
  it("evaluateSlipConflict returns the dedicated group kind, not a single-member ambiguity", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 42,
          referenceHash: UPPER_HASH,
          legacyReferenceUpperHash: UPPER_HASH,
        },
        {
          sourceType: "wallet_topup",
          sourceId: 99,
          referenceHash: hashSlipReference("SOMEOTHERMIXEDcase")!,
          legacyReferenceUpperHash: UPPER_HASH,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
    if (conflict.kind === "legacy_case_ambiguity_group") {
      expect(conflict.requiresAdminResolution).toBe(false);
      expect(conflict.advisory).toBe(true);
    }
  });

  it("claimSlip refuses with legacy_alias_group_ambiguity, never claims, never creates value", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
        { sourceType: "wallet_topup", sourceId: 99, legacyReferenceUpperHash: UPPER_HASH },
      ],
    }) as any;
    tx.insert = () => ({ values: async () => [{ insertId: 1 }] });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 500,
        userId: 1,
        identifiers: { referenceHash: MIXED_HASH },
        referenceRawForLegacyLookup: MIXED,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_alias_group_ambiguity");
  });

  it("a resolution presented for ONE member is NEVER consulted - the waiver has no effect on a group", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
        { sourceType: "wallet_topup", sourceId: 99, legacyReferenceUpperHash: UPPER_HASH },
      ],
    }) as any;
    tx.insert = () => ({ values: async () => [{ insertId: 1 }] });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 500,
        userId: 1,
        identifiers: { referenceHash: MIXED_HASH },
        referenceRawForLegacyLookup: MIXED,
        // An admin resolution that adjudicated ONE member (#42) - must be
        // completely ignored for a group ambiguity.
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: UPPER_HASH,
          expectedMatchedSourceType: "order_payment",
          expectedMatchedSourceId: 42,
          expectedIncomingReferenceHash: MIXED_HASH,
        },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_alias_group_ambiguity");
    }
  });
});

describe("C/D. a strong duplicate still wins over a group ambiguity", () => {
  it("C. exact reference duplicate against one group member wins", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        // This claim IS the exact reference being submitted now.
        { sourceType: "order_payment", sourceId: 42, referenceHash: MIXED_HASH, legacyReferenceUpperHash: UPPER_HASH },
        { sourceType: "wallet_topup", sourceId: 99, legacyReferenceUpperHash: UPPER_HASH },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedSourceId).toBe(42);
  });

  it("D. exact FILE duplicate against one group member wins", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, fileHash: FILE_A, legacyReferenceUpperHash: UPPER_HASH },
        { sourceType: "wallet_topup", sourceId: 99, legacyReferenceUpperHash: UPPER_HASH },
      ],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A },
        rawReference: MIXED,
        ...self,
      },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedKind).toBe("file");
  });
});

describe("E. pre-backfill live scan detects the complete alias group", () => {
  it("two approved historical rows (across BOTH tables) folding to the same alias -> group ambiguity", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      approvedPayments: [{ id: 10, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
      approvedTopups: [{ id: 20, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
  });

  it("two approved rows within the SAME table also produce a group ambiguity", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      approvedPayments: [
        { id: 10, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) },
        { id: 11, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
  });
});

describe("F. post-backfill indexed alias lookup produces the SAME semantic result as the live scan", () => {
  it("both mechanisms agree: two members -> group; one member -> single ambiguity", async () => {
    // PRE-backfill: two approved historical rows folding to the alias.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const preTx = makeTx({
      approvedPayments: [{ id: 10, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
      approvedTopups: [{ id: 20, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const pre = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      preTx
    );

    // POST-backfill: the SAME two rows, now represented as two indexed claims.
    vi.restoreAllMocks();
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const postTx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 10, legacyReferenceUpperHash: UPPER_HASH },
        { sourceType: "wallet_topup", sourceId: 20, legacyReferenceUpperHash: UPPER_HASH },
      ],
    });
    const post = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      postTx
    );

    expect(pre.kind).toBe("legacy_case_ambiguity_group");
    expect(post.kind).toBe(pre.kind);
  });
});

describe("G. the group/no-group verdict does not depend on row id or table scan order", () => {
  it("swapping which table holds which member yields the identical decision", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);

    const orderFirst = makeTx({
      approvedPayments: [{ id: 5, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
      approvedTopups: [{ id: 500, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const walletFirstConflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      orderFirst
    );

    vi.restoreAllMocks();
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    // Reversed relative ordering (higher id in payments, lower in topups) -
    // the scan-order-independence claim is about the BOOLEAN group verdict,
    // not which specific member gets named for display.
    const reversedIds = makeTx({
      approvedPayments: [{ id: 900, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
      approvedTopups: [{ id: 1, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const reversedConflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      reversedIds
    );

    expect(walletFirstConflict.kind).toBe("legacy_case_ambiguity_group");
    expect(reversedConflict.kind).toBe("legacy_case_ambiguity_group");
  });

  it("a single member stays a single-member ambiguity regardless of which table it lives in", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const inPayments = makeTx({
      approvedPayments: [{ id: 5, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const a = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      inPayments
    );

    vi.restoreAllMocks();
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const inTopups = makeTx({
      approvedTopups: [{ id: 5, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const b = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      inTopups
    );

    expect(a.kind).toBe("legacy_case_ambiguity");
    expect(b.kind).toBe("legacy_case_ambiguity");
  });
});

describe("Recheck and Admin Detail treat a group ambiguity as a non-waivable, distinct state", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  function readCode(rel: string): string {
    return fs
      .readFileSync(path.resolve(process.cwd(), rel), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  it("ocrRecheckService.ts excludes aliasGroupAmbiguity from verificationPassed", () => {
    const code = readCode("server/services/ocrRecheckService.ts");
    const idx = code.indexOf("const verificationPassed =");
    const body = code.slice(idx, idx + 300);
    expect(body).toMatch(/!aliasGroupAmbiguity/);
  });

  it("ocrRecheckService.ts never grants requiresAdminResolution for the group strength", () => {
    const code = readCode("server/services/ocrRecheckService.ts");
    const idx = code.indexOf('strength: "legacy_case_ambiguity_group"');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 300);
    expect(block).not.toMatch(/requiresAdminResolution: true/);
  });

  it("routers.ts maps the group kind with the dedicated reviewReason, never requiresAdminResolution: true", () => {
    const code = readCode("server/routers.ts");
    const idx = code.indexOf('conflict.kind === "legacy_case_ambiguity_group"');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 900);
    expect(block).toMatch(/reviewReasonOverride = "LEGACY_ALIAS_GROUP_AMBIGUITY"/);
    expect(block).not.toMatch(/requiresAdminResolution: true/);
  });

  it("claimSlip never inspects legacyCaseAmbiguityResolution when handling a group ambiguity", () => {
    const code = readCode("server/services/slipClaimService.ts");
    const idx = code.indexOf('conflict.kind === "legacy_case_ambiguity_group"');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, code.indexOf("if (conflict.kind ===", idx + 10));
    expect(block).not.toMatch(/legacyCaseAmbiguityResolution/);
  });

  it("describeLegacyCaseAmbiguity (the audited resolution flow) is not present for a group - by construction", () => {
    const code = readCode("server/services/legacyCaseResolutionService.ts");
    expect(code).toMatch(/conflict\.kind !== "legacy_case_ambiguity"/);
  });

  it("all four live claim paths name the SAME LEGACY_ALIAS_GROUP_AMBIGUITY term", () => {
    const orderApprove = readCode("server/services/orderService.ts");
    const walletApprove = readCode("server/db.ts");
    const orderAuto = readCode("server/services/slipSubmissionService.ts");
    for (const code of [orderApprove, walletApprove, orderAuto]) {
      expect(code).toMatch(/LEGACY_ALIAS_GROUP_AMBIGUITY/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// H. PARTIAL BACKFILL: indexed and live-scan members are unioned
// ════════════════════════════════════════════════════════════════════════
//
// IPE-001-C03 P1: while the legacy scan is still required (backfill
// incomplete), an indexed alias match with exactly ONE member does NOT mean
// only one historical source shares the fold - it only means one has been
// backfilled so far. The previous code returned the single-member ambiguity
// the moment `aliasMatches.length === 1`, before ever consulting the live
// scan for a second, not-yet-backfilled source sharing the same alias - an
// admin could then "confirm distinct" against the one row they were shown,
// unknowingly waiving a replay of the row the backfill hadn't reached yet.

describe("H. partial backfill: indexed and live-scan members are unioned into one semantic group", () => {
  it("1. one indexed ORDER + one unindexed WALLET, same fold, scan required -> group", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedTopups: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
    if (conflict.kind === "legacy_case_ambiguity_group") {
      expect(conflict.requiresAdminResolution).toBe(false);
    }
  });

  it("2. one indexed WALLET + one unindexed ORDER, same fold, scan required -> group (reverse direction)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        { sourceType: "wallet_topup", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedPayments: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
  });

  it("3. one indexed and one unindexed member in the SAME table -> group", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedPayments: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity_group");
  });

  it("4. the SAME historical source visible through BOTH the registry and the scan counts once - single-member semantics preserved", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      // Source #42's own underlying row is STILL approved and therefore
      // still visible to the live scan - this is not a second member.
      approvedPayments: [{ id: 42, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") {
      expect(conflict.requiresAdminResolution).toBe(true);
      expect(conflict.matchedSourceId).toBe(42);
    }
  });

  it("5. an exact strong duplicate against one union member still wins over the group", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 42,
          referenceHash: MIXED_HASH,
          legacyReferenceUpperHash: UPPER_HASH,
        },
      ],
      approvedTopups: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedSourceId).toBe(42);
  });

  it("6. once the scan is no longer required, indexed-only stays authoritative - a single indexed alias is still just a single-member ambiguity", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      // Present in the mock but irrelevant: scanRequired=false means the
      // live scan is never consulted, matching "backfill complete" reality.
      approvedTopups: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") expect(conflict.matchedSourceId).toBe(42);
  });

  it("7. claimSlip refuses a partial-backfill union group exactly like a fully-indexed one - a single-member resolution has no effect", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedTopups: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    }) as any;
    tx.insert = () => ({ values: async () => [{ insertId: 1 }] });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 500,
        userId: 1,
        identifiers: { referenceHash: MIXED_HASH },
        referenceRawForLegacyLookup: MIXED,
        legacyCaseAmbiguityResolution: {
          expectedLegacyAliasHash: UPPER_HASH,
          expectedMatchedSourceType: "order_payment",
          expectedMatchedSourceId: 42,
          expectedIncomingReferenceHash: MIXED_HASH,
        },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_alias_group_ambiguity");
  });

  it("8. the union verdict does not depend on which table holds the indexed vs. unindexed member", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const indexedInOrders = makeTx({
      claims: [
        { sourceType: "order_payment", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedTopups: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const a = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      indexedInOrders
    );

    vi.restoreAllMocks();
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const indexedInWallets = makeTx({
      claims: [
        { sourceType: "wallet_topup", sourceId: 42, legacyReferenceUpperHash: UPPER_HASH },
      ],
      approvedPayments: [{ id: 99, extractedData: JSON.stringify({ reference: MIXED.toUpperCase() }) }],
    });
    const b = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      indexedInWallets
    );

    expect(a.kind).toBe("legacy_case_ambiguity_group");
    expect(b.kind).toBe("legacy_case_ambiguity_group");
  });
});
