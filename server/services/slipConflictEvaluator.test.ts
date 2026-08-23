import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateSlipConflict, describeSlipConflict } from "./slipConflictEvaluator";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";

/**
 * The single shared conflict classifier.
 *
 * Two kinds of evidence must never be collapsed:
 *   STRONG (exact reference / file / qr) -> duplicate, may hard-block
 *   LOSSY  (uppercase fold of a legacy row) -> advisory ambiguity
 *
 * And EXACT ALWAYS WINS: if a record matches both ways the verdict is a
 * strong duplicate. Collapsing a lossy fold into a duplicate hard-blocks a
 * legitimate case-sensitive reference with no admin escape - the dead end
 * this design exists to remove.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const MIXED = "202608225ApOyxElgdOo7YVwv";
const UPPER = MIXED.toUpperCase();
const MIXED_HASH = hashSlipReference(MIXED)!;
const UPPER_HASH = hashSlipReference(UPPER)!;
const OTHER_REF = "016234222922AQR05745";
const FILE_A = "f".repeat(64);

/** Registry + historical-record fake honouring column targeting. */
function makeTx(options: {
  claims?: any[];
  approvedPayments?: Array<{ id: number; extractedData: string }>;
  approvedTopups?: Array<{ id: number; extractedData: string }>;
} = {}) {
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
  // Depth 12: an or(eq, eq) nests the bound Param deeper than a single eq,
  // and a shallow limit silently returned no hashes at all.
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

// ─── Exact wins over lossy ───────────────────────────────────────────────

describe("exact evidence always outranks a lossy fold", () => {
  it("exact reference + upper candidate both match -> STRONG duplicate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    // One claim carries BOTH the exact hash and the alias.
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 7,
          referenceHash: MIXED_HASH,
          legacyReferenceUpperHash: UPPER_HASH,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedKind).toBe("reference");
  });

  it("ONLY the upper candidate matches -> legacy_case_ambiguity", async () => {
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
      expect(conflict.advisory).toBe(true);
      expect(conflict.requiresAdminResolution).toBe(true);
      expect(conflict.matchedSourceId).toBe(42);
    }
  });

  it("same FILE matches while the reference only folds -> STRONG file duplicate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 9,
          referenceHash: UPPER_HASH,
          legacyReferenceUpperHash: UPPER_HASH,
          fileHash: FILE_A,
        },
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

  it("no conflict at all -> none", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({ claims: [] });
    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: hashSlipReference(OTHER_REF)! }, rawReference: OTHER_REF, ...self },
      tx
    );
    expect(conflict.kind).toBe("none");
  });

  it("a record never conflicts with ITSELF", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [{ sourceType: "wallet_topup", sourceId: 900, referenceHash: MIXED_HASH }],
    });
    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );
    expect(conflict.kind).toBe("none");
  });
});

// ─── Pre- vs post-backfill parity ────────────────────────────────────────

describe("pre- and post-backfill produce the SAME verdict", () => {
  /** Historical row persisted with only an upper-cased reference. */
  const legacyRow = { id: 42, extractedData: JSON.stringify({ reference: UPPER }) };

  it("PRE-backfill (scan): uppercase-only match -> legacy_case_ambiguity", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({ claims: [], approvedPayments: [legacyRow] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
    if (conflict.kind === "legacy_case_ambiguity") expect(conflict.matchedSourceId).toBe(42);
  });

  it("POST-backfill (indexed alias): the SAME submission -> legacy_case_ambiguity", async () => {
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
    if (conflict.kind === "legacy_case_ambiguity") expect(conflict.matchedSourceId).toBe(42);
  });

  it("PRE-backfill: an EXACT historical reference is still a strong duplicate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const exactRow = { id: 11, extractedData: JSON.stringify({ referenceRaw: MIXED }) };
    const tx = makeTx({ claims: [], approvedPayments: [exactRow] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.viaLegacyCompatibility).toBe(true);
      expect(conflict.matchedSourceId).toBe(11);
    }
  });

  it("PRE-backfill: an exact match in a LATER row still beats an earlier lossy one", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [],
      approvedPayments: [
        { id: 1, extractedData: JSON.stringify({ reference: UPPER }) }, // lossy
        { id: 2, extractedData: JSON.stringify({ referenceRaw: MIXED }) }, // exact
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
      tx
    );

    // Returning the first hit would have reported ambiguity and hidden a real
    // duplicate.
    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") expect(conflict.matchedSourceId).toBe(2);
  });

  it("a modern reference with NO legacy row is not dragged into review", async () => {
    for (const scanEnabled of [true, false]) {
      vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(scanEnabled);
      const tx = makeTx({ claims: [], approvedPayments: [] });
      const conflict = await evaluateSlipConflict(
        { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, ...self },
        tx
      );
      expect(conflict.kind).toBe("none");
    }
  });
});

describe("describeSlipConflict", () => {
  it("hedges an ambiguity and never calls it proof", () => {
    const msg = describeSlipConflict({
      kind: "legacy_case_ambiguity",
      matchedSourceType: "order_payment",
      matchedSourceId: 5,
      advisory: true,
      requiresAdminResolution: true,
    });
    expect(msg).toMatch(/NOT proof/i);
    expect(msg).toMatch(/order payment #5/);
    expect(msg).toMatch(/admin must decide/i);
  });

  it("states a strong duplicate plainly", () => {
    const msg = describeSlipConflict({
      kind: "strong_duplicate",
      matchedKind: "file",
      matchedSourceType: "wallet_topup",
      matchedSourceId: 8,
      viaLegacyCompatibility: false,
    });
    expect(msg).toMatch(/already been used/i);
    expect(msg).toMatch(/wallet top-up #8/);
  });

  it("never leaks a hash", () => {
    const msg = describeSlipConflict({
      kind: "legacy_case_ambiguity",
      matchedSourceType: "order_payment",
      matchedSourceId: 5,
      advisory: true,
      requiresAdminResolution: true,
      legacyAliasHash: UPPER_HASH,
    });
    expect(msg).not.toMatch(/[0-9a-f]{32,}/);
  });
});

// ─── The classifier is shared, not duplicated ────────────────────────────

describe("one classifier, used everywhere", () => {
  const read = (rel: string) =>
    fs
      .readFileSync(path.resolve(process.cwd(), rel), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

  it("claimSlip uses it", () => {
    expect(read("server/services/slipClaimService.ts")).toMatch(/evaluateSlipConflict\(/);
  });

  it("Admin Recheck uses it", () => {
    expect(read("server/services/ocrRecheckService.ts")).toMatch(/evaluateSlipConflict\(/);
  });

  it("the resolver uses it to revalidate server-side", () => {
    expect(read("server/services/legacyCaseResolutionService.ts")).toMatch(
      /evaluateSlipConflict\(/
    );
  });

  it("it is READ-ONLY - it never inserts a claim", () => {
    const code = read("server/services/slipConflictEvaluator.ts");
    expect(code).not.toMatch(/\.insert\(/);
    expect(code).not.toMatch(/claimSlip\(/);
  });
});
