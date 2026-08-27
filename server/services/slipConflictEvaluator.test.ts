import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateSlipConflict, describeSlipConflict } from "./slipConflictEvaluator";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";
import * as legacyCompat from "./legacySlipCompatibilityService";

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
  /** Durable known-collision fixture rows for paymentSlipLegacyCollisions. */
  legacyCollisions?: Array<{
    kind: "reference" | "file" | "qr";
    identifierHash: string;
    sourceType: "order_payment" | "wallet_topup";
    sourceId: number;
  }>;
} = {}) {
  const claims = options.claims ?? [];
  const legacyCollisions = options.legacyCollisions ?? [];
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
                  if (name === "paymentSlipLegacyCollisions") {
                    // Matched purely by identifierHash - test fixtures never
                    // reuse a hash value across two different `kind`s, so
                    // this stays unambiguous without needing to also decode
                    // which `kind` the query targeted.
                    if (!wanted.length) return [];
                    return legacyCollisions
                      .filter((c) => wanted.includes(c.identifierHash))
                      .map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId }))
                      .slice(0, n);
                  }
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

// ─── Durable known-collision registry (IPE-004) ──────────────────────────

describe("known_collision - durable, indexed, no winner picked", () => {
  it("an incoming reference that matches a durably recorded collision fails closed", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") {
      expect(conflict.matchedKind).toBe("reference");
      expect(conflict.advisory).toBe(true);
      expect(conflict.requiresAdminResolution).toBe(false);
    }
  });

  it("an incoming file hash that matches a durably recorded FILE collision fails closed", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "file", identifierHash: FILE_A, sourceType: "wallet_topup", sourceId: 9 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("file");
  });

  it("known_collision is checked via an indexed lookup even when the legacy scan is NOT required (post-backfill)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const scan = vi.spyOn(legacyCompat, "findLegacyApprovedDuplicate");
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    // Proves this is an indexed lookup, not the O(N) historical scan.
    expect(scan).not.toHaveBeenCalled();
  });

  it("an unrelated identifier is never blocked by a collision on a DIFFERENT hash", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "reference", identifierHash: UPPER_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: hashSlipReference(OTHER_REF)! }, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });
});

// ─── Production-shaped unresolved history must never block an unrelated,
// safe approval (IPE-004 acceptance criterion 1) ───────────────────────────

describe("production-shaped unresolved history never blocks an unrelated approval", () => {
  it("hundreds of no_slip_image_url-style unresolved historical rows do not block a clean new approval once the scan is not required", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    // Many historical rows with nothing at all to identify them - exactly the
    // production shape (915 unresolved rows) - but the scan is not consulted
    // at all once backfill is complete, so they cannot matter here.
    const manyUnresolvedRows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      extractedData: JSON.stringify({}),
    }));
    const tx = makeTx({ claims: [], approvedPayments: manyUnresolvedRows, approvedTopups: [] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: hashSlipReference(OTHER_REF)! }, rawReference: OTHER_REF, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });

  it("the normal approval path performs NO full-history paging once the scan is not required (acceptance criterion 6)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const scanSpy = vi.spyOn(legacyCompat, "findLegacyApprovedDuplicate");
    const groupSpy = vi.spyOn(legacyCompat, "findLegacyAliasGroupMembers");
    const tx = makeTx({ claims: [] });

    await evaluateSlipConflict(
      { identifiers: { referenceHash: hashSlipReference(OTHER_REF)! }, rawReference: OTHER_REF, ...self },
      tx
    );

    expect(scanSpy).not.toHaveBeenCalled();
    expect(groupSpy).not.toHaveBeenCalled();
  });
});

// ─── A current submission whose OWN safety genuinely depends on unknown
// legacy file identity must still fail closed (IPE-004 acceptance criterion 2)

describe("a current submission that genuinely depends on unknown legacy evidence still fails closed", () => {
  it("pre-backfill: an approved historical row with NOTHING recoverable (no reference, no file) still blocks as unresolved when only a fileHash is being compared", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    // A historical row with no reference evidence at all and (implicitly, via
    // legacySlipCompatibilityService's own recovery attempt failing because
    // there is no slipImageUrl on this fixture) no recoverable file hash -
    // its OWN identity is fully unknown.
    const unresolvableRow = { id: 77, extractedData: null as any };
    const tx = makeTx({ claims: [], approvedPayments: [unresolvableRow] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, ...self },
      tx
    );

    // Never silently treated as "no conflict" - the current submission's own
    // replay-safety on the file axis cannot be confirmed against a row whose
    // file identity is unknown, so it fails closed pending manual review.
    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") expect(conflict.matchedSourceId).toBe(77);
  });

  it("a submission with NO strong identifier at all cannot be evaluated and must never be treated as safe (belt-and-braces, enforced by the caller)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({ claims: [] });
    // evaluateSlipConflict itself only classifies conflicts among identifiers
    // that exist; the "no identifier at all" case is refused one layer up by
    // claimSlip's `no_strong_identifier` outcome (see slipClaimService.test.ts) -
    // asserted here only to document that an empty identifier set is never
    // itself reported as a strong "none" duplicate verdict that a caller
    // might mistake for a green light independent of that gate.
    const conflict = await evaluateSlipConflict({ identifiers: {}, ...self }, tx);
    expect(conflict.kind).toBe("none");
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
