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
  /**
   * Durable permanently-unknown fixture rows for paymentSlipLegacyUnknown -
   * IPE-004-C03's post-completion file-axis sufficiency signal.
   * `findAnyLegacyFileIdentityUnknown` queries this with NO `.where()`
   * (`select().from(table).limit(1)`), unlike every other table here.
   */
  legacyUnknownRows?: Array<{ sourceType: "order_payment" | "wallet_topup"; sourceId: number }>;
} = {}) {
  const claims = options.claims ?? [];
  const legacyCollisions = options.legacyCollisions ?? [];
  const legacyUnknownRows = options.legacyUnknownRows ?? [];
  return {
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          return {
            // findAnyLegacyFileIdentityUnknown calls select().from(...).limit(1)
            // directly, with no .where() at all - the only such shape here.
            limit: async (n: number) => legacyUnknownRows.slice(0, n),
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

  it("IPE-004 P2: a known collision WINS over a singleton claim on the same hash - no fabricated owner", async () => {
    // The backfill gives the FIRST member of a colliding group an ordinary
    // paymentSlipClaims row and records the rest as collision members. A
    // plain findExistingClaim() would then present that first row as a proven
    // duplicate owner. The known-collision lookup runs first, so the verdict
    // is known_collision (no winner, manual review), never strong_duplicate.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [{ referenceHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1, kind: "reference" }],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 2 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
  });

  it("IPE-004-C03: a submission that is ITSELF the ONLY recorded member on a hash still fails closed - a lone self-member is a degenerate registry state, never a silent singleton winner", async () => {
    // The collision FACT is "this hash is in paymentSlipLegacyCollisions" -
    // it never depends on excluding the caller. A group with only one member
    // recorded (this row) is a partial/degenerate state (e.g. the other
    // member's write is still in flight, or was itself never durably
    // recorded) - the safe direction is manual review, never treating it as
    // proof of no conflict.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        {
          kind: "reference",
          identifierHash: MIXED_HASH,
          sourceType: self.sourceType,
          sourceId: self.sourceId,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
  });

  it("but a real group still blocks self when ANOTHER member shares the hash", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        {
          kind: "reference",
          identifierHash: MIXED_HASH,
          sourceType: self.sourceType,
          sourceId: self.sourceId,
        },
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 7 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
  });
});

// ─── IPE-004-C06: cross-axis conflict precedence ──────────────────────────
// A collision on ONE axis says nothing about whether ANOTHER axis proves an
// exact, unambiguous foreign owner. Returning known_collision the moment any
// axis collided was fail-closed but named the wrong finding and the wrong
// source - which is what an admin actually acts on. Precedence is now
// per-axis: a proven claim on a CLEAN axis wins; a singleton on a COLLIDING
// axis is still never promoted to a fabricated winner.

describe("cross-axis precedence: a proven owner on a clean axis outranks a collision elsewhere", () => {
  const OTHER_HASH = hashSlipReference(OTHER_REF)!;
  const QR_A = "9".repeat(64);

  it("collision-listed REFERENCE + exact foreign-owned non-collision FILE -> strong_duplicate by the file owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 55,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("file");
      expect(conflict.matchedSourceType).toBe("order_payment");
      expect(conflict.matchedSourceId).toBe(55);
    }
  });

  it("collision-listed FILE + exact foreign-owned non-collision REFERENCE -> strong_duplicate by the reference owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 66,
          userId: 3,
          referenceHash: OTHER_HASH,
          fileHash: null,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "file", identifierHash: FILE_A, sourceType: "wallet_topup", sourceId: 9 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: OTHER_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("reference");
      expect(conflict.matchedSourceId).toBe(66);
    }
  });

  it("collision-listed FILE + exact foreign-owned non-collision QR -> strong_duplicate by the QR owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "wallet_topup",
          sourceId: 77,
          userId: 3,
          referenceHash: null,
          fileHash: null,
          qrPayloadHash: QR_A,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "file", identifierHash: FILE_A, sourceType: "order_payment", sourceId: 9 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A, qrPayloadHash: QR_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("qr");
      expect(conflict.matchedSourceId).toBe(77);
    }
  });

  it("SAME-AXIS collision + a singleton claim on that same axis -> known_collision, NO fabricated winner", async () => {
    // This is the invariant the precedence rule must never break: the
    // backfill writes an ordinary claim for the FIRST member of a colliding
    // group, so a plain claim lookup on that axis WOULD "find an owner".
    // That owner was never adjudicated and must stay excluded.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 1,
          userId: 3,
          referenceHash: MIXED_HASH,
          fileHash: null,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("reference");
  });

  it("EVERY present axis is collision-ambiguous -> known_collision, reported deterministically on the first (reference, file, qr) axis", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "file", identifierHash: FILE_A, sourceType: "order_payment", sourceId: 8 },
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    // reference is checked before file, so reference is the reported axis.
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("reference");
  });

  it("MULTIPLE colliding axes: a singleton claim on the SECOND colliding axis is still never promoted", async () => {
    // Every colliding axis must be excluded from the claim lookup, not just
    // the first one found. The backfill writes an ordinary claim for the
    // first member of EVERY colliding group, so if only the first colliding
    // axis were excluded, the second one's singleton would be found and
    // wrongly returned as a proven owner - the exact fabricated winner this
    // precedence rule exists to prevent, reintroduced one axis over.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: "order_payment",
          sourceId: 8,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
        { kind: "file", identifierHash: FILE_A, sourceType: "order_payment", sourceId: 8 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("reference");
  });

  it("a collision on one axis while the clean axis is owned by SELF is not a duplicate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    // Self-ownership is never a duplicate, so the remaining finding is the
    // reference collision - still fail closed, still no winner.
    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("reference");
  });

  it("collision on one axis and NO claim on the clean axis -> known_collision (nothing proven to outrank it)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
  });

  // ── IPE-004-C07: clean-axis selection must be deterministic per axis ────
  // C06 correctly excluded collision-ambiguous axes, but the lookup was one
  // or(...) + limit(1), so the database chose which matching row came back.
  // A self-owned claim on one clean axis could be returned ahead of a foreign
  // owner on another clean axis; self is not a duplicate, so the proven
  // replay was discarded and a weaker verdict from a different axis won.
  //
  // In each of the following the SELF claim is deliberately listed FIRST, so
  // a lookup that stops at the first matching row sees self and gives up.

  it("C07: collision reference + SELF-owned clean file + FOREIGN clean QR -> strong_duplicate by the QR owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
        {
          sourceType: "order_payment",
          sourceId: 321,
          userId: 4,
          referenceHash: null,
          fileHash: null,
          qrPayloadHash: QR_A,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A, qrPayloadHash: QR_A },
        ...self,
      },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("qr");
      expect(conflict.matchedSourceType).toBe("order_payment");
      expect(conflict.matchedSourceId).toBe(321);
    }
  });

  it("C07: SELF-owned clean reference + FOREIGN clean file -> strong_duplicate by the file owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const OTHER_HASH2 = hashSlipReference(OTHER_REF)!;
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: OTHER_HASH2,
          fileHash: null,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
        {
          sourceType: "order_payment",
          sourceId: 322,
          userId: 4,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: OTHER_HASH2, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("file");
      expect(conflict.matchedSourceId).toBe(322);
    }
  });

  it("C07: SELF-owned clean file + FOREIGN clean QR -> strong_duplicate by the QR owner", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
        {
          sourceType: "order_payment",
          sourceId: 323,
          userId: 4,
          referenceHash: null,
          fileHash: null,
          qrPayloadHash: QR_A,
          legacyReferenceUpperHash: null,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A, qrPayloadHash: QR_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
    if (conflict.kind === "strong_duplicate") {
      expect(conflict.matchedKind).toBe("qr");
      expect(conflict.matchedSourceId).toBe(323);
    }
  });

  it("C07: EVERY clean axis is self-owned while another axis collides -> known_collision, self never a duplicate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: QR_A,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A, qrPayloadHash: QR_A },
        ...self,
      },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
    if (conflict.kind === "known_collision") expect(conflict.matchedKind).toBe("reference");
  });

  it("C07: every clean axis self-owned and NO collision anywhere -> no conflict at all", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: null,
          fileHash: FILE_A,
          qrPayloadHash: QR_A,
          legacyReferenceUpperHash: null,
        },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A, qrPayloadHash: QR_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });

  it("C07: a self-owned claim on a COLLIDING axis still never becomes a duplicate via the clean-axis search", async () => {
    // The colliding axis is excluded from the lookup entirely, so neither the
    // foreign first-member singleton nor a self row on it can be selected.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [
        {
          sourceType: self.sourceType,
          sourceId: self.sourceId,
          userId: 3,
          referenceHash: MIXED_HASH,
          fileHash: null,
          qrPayloadHash: null,
          legacyReferenceUpperHash: null,
        },
      ],
      legacyCollisions: [
        { kind: "reference", identifierHash: MIXED_HASH, sourceType: "order_payment", sourceId: 1 },
      ],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH }, ...self },
      tx
    );

    expect(conflict.kind).toBe("known_collision");
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

// ─── Post-completion file-axis sufficiency (IPE-004-C03) ─────────────────

describe("post-completion: fileHash-only submissions still fail closed against permanent unknown legacy history", () => {
  it("scan retired + a permanently-unknown historical row exists + current submission's ONLY evidence is fileHash -> unresolved, zero history scan", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, ...self },
      tx
    );

    // Never silently "none" just because the O(N) scan is off - the file
    // axis has a residual gap (paymentSlipLegacyUnknown is non-empty) that
    // a fileHash-only submission cannot be proven safe against.
    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") {
      expect(conflict.matchedSourceType).toBe("order_payment");
      expect(conflict.matchedSourceId).toBe(555);
      expect(conflict.unresolvedScope).toBe("historical_file_axis_coverage");
      const description = describeSlipConflict(conflict);
      expect(description).toContain("representative example");
      expect(description).toContain("NO evidence that this submission matches that record");
    }
  });

  it("the server-bound exact-file risk resolution waives ONLY the global post-completion coverage gate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { fileHash: FILE_A },
        legacyFileAxisRiskResolution: { expectedFileHash: FILE_A },
        ...self,
      },
      tx
    );

    expect(conflict).toEqual({ kind: "none" });
  });

  it("a file-axis waiver bound to any other hash does not waive the global coverage gate", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { fileHash: FILE_A },
        legacyFileAxisRiskResolution: { expectedFileHash: "b".repeat(64) },
        ...self,
      },
      tx
    );

    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") {
      expect(conflict.unresolvedScope).toBe("historical_file_axis_coverage");
    }
  });

  it("the post-completion waiver never bypasses a pre-backfill specific unresolved scan record", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      claims: [],
      approvedPayments: [{ id: 77, extractedData: null as any }],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { fileHash: FILE_A },
        legacyFileAxisRiskResolution: { expectedFileHash: FILE_A },
        ...self,
      },
      tx
    );

    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") {
      expect(conflict.unresolvedScope).toBe("legacy_scan_record");
      expect(conflict.matchedSourceId).toBe(77);
    }
  });

  it("scan retired + a permanently-unknown historical row exists + current submission ALSO carries a referenceHash -> sufficient, proceeds as none (acceptance criterion B)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
    });

    // A reference (or QR) axis is fully covered by the indexed claim
    // registry regardless of what the unknown-file registry holds - it must
    // never be dragged into review by an unrelated file-axis gap.
    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: MIXED_HASH, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });

  it("scan retired + a permanently-unknown historical row exists + current submission ALSO carries a qrPayloadHash -> sufficient, proceeds as none", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { qrPayloadHash: FILE_A, fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });

  it("scan retired + the unknown registry is EMPTY -> fileHash-only proceeds promptly as none (no permanent gap to fail closed over)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({ claims: [], legacyUnknownRows: [] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, ...self },
      tx
    );

    expect(conflict.kind).toBe("none");
  });

  it("scan STILL required (pre-completion) -> the sufficiency check is a no-op; the live scan's own unresolved handling governs instead", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    // Even with unknown rows durably recorded, while the scan is still
    // required the O(N) path already covers the file axis and returns its
    // own `unresolved` for anything it cannot evaluate - this checkpoint
    // must not ALSO run (which would mean two different unresolved sources
    // disagreeing, or worse, an unbounded read layered on top of the scan).
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "order_payment", sourceId: 555 }],
      approvedPayments: [],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, ...self },
      tx
    );

    // No approved historical rows in the scan and nothing else matches -
    // "none", never routed through the post-completion checkpoint.
    expect(conflict.kind).toBe("none");
  });

  it("Wallet parity: the same fileHash-only submission fails closed identically regardless of sourceType", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [],
      legacyUnknownRows: [{ sourceType: "wallet_topup", sourceId: 900 }],
    });

    const conflict = await evaluateSlipConflict(
      {
        identifiers: { fileHash: FILE_A },
        sourceType: "order_payment",
        sourceId: 42,
      },
      tx
    );

    expect(conflict.kind).toBe("unresolved");
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
