import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as dbModule from "../db";
import { claimSlip } from "./slipClaimService";
import { hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";
import { classifyRepresentation } from "../../scripts/lib/backfillRepresentation.mjs";

/**
 * Round 9. Three findings, all of them "the decision and the thing it was
 * about drifted apart":
 *
 *  1. a confirmed-distinct resolution waived whatever ambiguity happened to
 *     be current, and recorded the one the admin saw - a Recheck landing in
 *     between could turn a decision about reference A into an approval of a
 *     replay of reference B
 *  2. the backfill counted a legacy row as represented when its claim held
 *     the strong identifiers but no advisory alias, so completion could
 *     retire the scan while that row stayed replayable
 *  3. a transient second fetch failure let Recheck DELETE a file hash it had
 *     already recovered and persisted
 *
 * (1) and (2) are exercised behaviourally; the transaction ORDERING and the
 * row locking need a live MySQL transaction, which this sandbox does not
 * have, so those are asserted structurally.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const MIXED_A = "202608225ApOyxElgdOo7YVwv";
const MIXED_B = "202608226BqPzyFmhePp8ZWxw";
const UPPER_A = MIXED_A.toUpperCase();
const UPPER_B = MIXED_B.toUpperCase();
const HASH_A = hashSlipReference(MIXED_A)!;
const HASH_B = hashSlipReference(MIXED_B)!;
const ALIAS_A = hashSlipReference(UPPER_A)!;
const ALIAS_B = hashSlipReference(UPPER_B)!;
const FILE_A = "a".repeat(64);
const FILE_B = "b".repeat(64);

// ════════════════════════════════════════════════════════════════════════
// 1. THE WAIVER IS BOUND TO THE EVIDENCE
// ════════════════════════════════════════════════════════════════════════

function makeRegistry(claims: any[]) {
  const inserted: any[] = [];
  return {
    inserted,
    tx: {
      select() {
        return {
          from(table: any) {
            const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
            return {
              where(cond: any) {
                const wanted = boundHashes(cond);
                const cols = targetedColumns(cond);
                return {
                  orderBy() {
                    return { limit: async () => [] };
                  },
                  limit: async (n: number) => {
                    if (name !== "paymentSlipClaims") return [];
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

/** The historical row whose casing is unrecoverable, folding to ALIAS_A. */
const LEGACY_A = {
  sourceType: "order_payment",
  sourceId: 42,
  userId: 7,
  referenceHash: null,
  legacyReferenceUpperHash: ALIAS_A,
  fileHash: null,
  qrPayloadHash: null,
};

const LEGACY_B = {
  sourceType: "wallet_topup",
  sourceId: 99,
  userId: 8,
  referenceHash: null,
  legacyReferenceUpperHash: ALIAS_B,
  fileHash: null,
  qrPayloadHash: null,
};

/** What the admin adjudicated: the fold against order payment #42. */
const ADJUDICATED_A = {
  expectedLegacyAliasHash: ALIAS_A,
  expectedMatchedSourceType: "order_payment" as const,
  expectedMatchedSourceId: 42,
  // The exact case-preserving reference reviewed. Without this the waiver
  // named only the fold, and a casing-only change slipped past it.
  expectedIncomingReferenceHash: HASH_A,
};

function request(referenceRaw: string, sourceId = 900) {
  return {
    sourceType: "order_payment" as const,
    sourceId,
    userId: 3,
    identifiers: { referenceHash: hashSlipReference(referenceRaw)! },
    referenceRawForLegacyLookup: referenceRaw,
  };
}

describe("an admin resolution applies only to the evidence it was about", () => {
  beforeEach(() => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("F. same alias + same source -> the advisory waiver works and the exact claim runs", async () => {
    const registry = makeRegistry([LEGACY_A]);

    const outcome = await claimSlip(
      { ...request(MIXED_A), legacyCaseAmbiguityResolution: ADJUDICATED_A },
      registry.tx
    );

    expect(outcome.claimed).toBe(true);
    expect(registry.inserted).toHaveLength(1);
    expect(registry.inserted[0].referenceHash).toBe(HASH_A);
    // A modern claim never writes the lossy alias.
    expect(registry.inserted[0].legacyReferenceUpperHash).toBeNull();
  });

  it("B. evidence changed to a DIFFERENT alias -> refused, nothing claimed", async () => {
    // Recheck rewrote the extraction: the submission now folds to ALIAS_B,
    // matching a different historical row. The decision was about ALIAS_A.
    const registry = makeRegistry([LEGACY_A, LEGACY_B]);

    const outcome = await claimSlip(
      { ...request(MIXED_B), legacyCaseAmbiguityResolution: ADJUDICATED_A },
      registry.tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_case_ambiguity_changed");
    }
    expect(registry.inserted).toHaveLength(0);
  });

  it("E. same alias but a DIFFERENT matched source -> refused", async () => {
    // Same fold value, recorded against wallet_topup#99 rather than #42.
    const registry = makeRegistry([
      { ...LEGACY_B, legacyReferenceUpperHash: ALIAS_A },
    ]);

    const outcome = await claimSlip(
      { ...request(MIXED_A), legacyCaseAmbiguityResolution: ADJUDICATED_A },
      registry.tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_case_ambiguity_changed");
    expect(registry.inserted).toHaveLength(0);
  });

  it("C. evidence became a STRONG duplicate -> blocked, never waived", async () => {
    const registry = makeRegistry([
      LEGACY_A,
      // An exact, case-preserving claim now owns this reference.
      { ...LEGACY_A, sourceId: 55, referenceHash: HASH_A, legacyReferenceUpperHash: null },
    ]);

    const outcome = await claimSlip(
      { ...request(MIXED_A), legacyCaseAmbiguityResolution: ADJUDICATED_A },
      registry.tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("already_claimed");
    expect(registry.inserted).toHaveLength(0);
  });

  it("an exact FILE duplicate is not waived either", async () => {
    const registry = makeRegistry([
      LEGACY_A,
      { ...LEGACY_A, sourceId: 56, legacyReferenceUpperHash: null, fileHash: FILE_A },
    ]);

    const outcome = await claimSlip(
      {
        ...request(MIXED_A),
        identifiers: { referenceHash: HASH_A, fileHash: FILE_A },
        legacyCaseAmbiguityResolution: ADJUDICATED_A,
      },
      registry.tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("already_claimed");
  });

  it("D. the ambiguity disappeared -> the claim simply proceeds, nothing is waived", async () => {
    // Nothing matches any more. There is no ambiguity to override, so this
    // is an ordinary claim - the stale decision grants nothing extra.
    const registry = makeRegistry([]);

    const outcome = await claimSlip(
      { ...request(MIXED_A), legacyCaseAmbiguityResolution: ADJUDICATED_A },
      registry.tx
    );

    expect(outcome.claimed).toBe(true);
  });

  it("A. with no resolution at all the ambiguity still stops the claim", async () => {
    const registry = makeRegistry([LEGACY_A]);
    const outcome = await claimSlip(request(MIXED_A), registry.tx);

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_case_ambiguity");
    expect(registry.inserted).toHaveLength(0);
  });
});

describe("the resolution service derives the evidence itself", () => {
  const svc = readCode("server/services/legacyCaseResolutionService.ts");
  const routers = readCode("server/routers.ts");

  it("the adjudicated evidence is captured server-side, never from the request", () => {
    expect(svc).toMatch(/const adjudicated: AdjudicatedAmbiguity = \{/);
    expect(svc).toMatch(/legacyAliasHash: ambiguity\.legacyAliasHash/);
    // The input type carries no evidence fields at all.
    const start = svc.indexOf("export interface ResolveLegacyCaseInput {");
    const body = svc.slice(start, svc.indexOf("}", start));
    expect(body).not.toMatch(/expectedLegacyAliasHash|matchedSource|aliasHash/i);
  });

  it("the routers accept only subject, decision and reason", () => {
    for (const marker of ["resolveLegacyCaseAmbiguity"]) {
      expect(routers).toMatch(new RegExp(marker));
    }
    expect(routers).not.toMatch(/expectedLegacyAliasHash/);
    expect(routers).not.toMatch(/expectedMatchedSourceId/);
  });

  it("confirmed_distinct hands the evidence to the approval, not a boolean", () => {
    expect(svc).toMatch(/adjudicated,\s*\n\s*auditResolution:/);
    expect(svc).not.toMatch(/legacyCaseAmbiguityResolved/);
  });

  it("the audit records the ADJUDICATED evidence, which the claim proved current", () => {
    const start = svc.indexOf('resolutionType: "legacy_case_confirmed_distinct"');
    const body = svc.slice(start, start + 300);
    expect(body).toMatch(/ambiguity: adjudicated/);
  });

  it("G. confirmed_duplicate is bound to the same evidence in-transaction", () => {
    const start = svc.indexOf('if (input.decision === "confirmed_duplicate")');
    const body = svc.slice(start, start + 1600);
    expect(body).toMatch(/await requireUnchangedAmbiguityInTx\(input, adapter, adjudicated, tx\)/);
    expect(body).toMatch(/ambiguity: adjudicated/);
  });

  it("the in-transaction guard re-reads CURRENT extraction and demands equality", () => {
    const start = svc.indexOf("async function requireUnchangedAmbiguityInTx(");
    const body = svc.slice(start, start + 1600);
    expect(body).toMatch(/adapter\.loadInTx\(tx\)/);
    expect(body).toMatch(/current\.extractedData/);
    expect(body).toMatch(/sameAmbiguity\(adjudicated, live\)/);
    expect(body).toMatch(/code: "PRECONDITION_FAILED"/);
    // Presence alone is NOT enough - that was the defect.
    expect(body).toMatch(/!live\.present \|\| !sameAmbiguity/);
  });

  it("equality means same alias AND same matched source", () => {
    const start = svc.indexOf("function sameAmbiguity(");
    const body = svc.slice(start, start + 600);
    expect(body).toMatch(/legacyAliasHash \?\? null\) === \(b\.legacyAliasHash \?\? null\)/);
    expect(body).toMatch(/a\.matchedSourceType === b\.matchedSourceType/);
    expect(body).toMatch(/a\.matchedSourceId === b\.matchedSourceId/);
  });
});

describe("H. the subject is locked across revalidation and commit", () => {
  const dbCode = readCode("server/db.ts");
  const orderCode = readCode("server/services/orderService.ts");
  const svc = readCode("server/services/legacyCaseResolutionService.ts");

  it("both lock helpers use the repo's SELECT ... FOR UPDATE convention", () => {
    expect(dbCode).toMatch(/export async function lockPaymentForUpdate\(/);
    expect(dbCode).toMatch(/export async function lockWalletTopupForUpdate\(/);
    expect(dbCode).toMatch(/SELECT id FROM payments WHERE id = \$\{paymentId\} FOR UPDATE/);
    expect(dbCode).toMatch(/SELECT id FROM walletTopups WHERE id = \$\{topupId\} FOR UPDATE/);
  });

  it("the order approval locks BEFORE reading the evidence it decides on", () => {
    const lockIdx = orderCode.indexOf("db.lockPaymentForUpdate(paymentId, tx)");
    const readIdx = orderCode.indexOf('const payment = await traceOrderApprovalStage("payment_current_read", () => db.getPaymentByIdForUpdate(paymentId, tx))');
    const claimIdx = orderCode.indexOf("const claim = await atOrderPaymentApprovalStage");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(lockIdx);
    expect(claimIdx).toBeGreaterThan(readIdx);
  });

  it("the wallet approval locks before its in-transaction reload", () => {
    const start = dbCode.indexOf("export async function approveWalletTopup(");
    const body = dbCode.slice(start, start + 2500);
    const lockIdx = body.indexOf("lockWalletTopupForUpdate(topupId, tx)");
    const readIdx = body.indexOf("const topupResult = await tx.select()");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(lockIdx);
  });

  it("both rejection transactions lock too", () => {
    expect(svc).toMatch(/await orderService\.lockAndRequireReviewablePayment\(input\.subjectId, tx\)/);
    expect(orderCode).toMatch(/db\.lockPaymentForUpdate\(paymentId, tx\)/);
    const start = dbCode.indexOf("export async function rejectWalletTopup(");
    const body = dbCode.slice(start, start + 1200);
    expect(body).toMatch(/await lockWalletTopupForUpdate\(topupId, tx\)/);
  });

  it("the existing recheck CAS guarantee is untouched", () => {
    const recheck = readCode("server/services/ocrRecheckService.ts");
    expect(recheck).toMatch(/updatePaymentIfNotFinalized/);
    expect(dbCode).toMatch(/export async function updatePaymentIfNotFinalized\(/);
  });
});

describe("the approval paths report changed evidence distinctly", () => {
  const dbCode = readCode("server/db.ts");
  const orderCode = readCode("server/services/orderService.ts");

  it("order approval raises LEGACY_CASE_AMBIGUITY_CHANGED_REVIEW_REQUIRED", () => {
    expect(orderCode).toMatch(/legacy_case_ambiguity_changed/);
    expect(orderCode).toMatch(/LEGACY_CASE_AMBIGUITY_CHANGED_REVIEW_REQUIRED/);
  });

  it("wallet approval raises the same code, distinct from REQUIRES_RESOLUTION", () => {
    expect(dbCode).toMatch(/"LEGACY_CASE_AMBIGUITY_CHANGED_REVIEW_REQUIRED"/);
    expect(dbCode).toMatch(/"LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION"/);
  });

  it("the admin-facing message leaks no hash and says to re-review", () => {
    const claim = readCode("server/services/slipClaimService.ts");
    const start = claim.indexOf('if (outcome.reason === "legacy_case_ambiguity_changed")');
    const body = claim.slice(start, start + 900);
    expect(body).toMatch(/Refresh and review the current evidence/);
    expect(body).not.toMatch(/Hash|hash/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. BACKFILL: REQUIRED ADVISORY ALIAS COVERAGE
// ════════════════════════════════════════════════════════════════════════

const HERE = { sourceType: "order_payment", sourceId: 42 };
const IDS = { referenceHash: HASH_A, fileHash: FILE_A };

function ownClaim(overrides: any = {}) {
  return {
    id: 1,
    sourceType: "order_payment",
    sourceId: 42,
    referenceHash: HASH_A,
    fileHash: FILE_A,
    qrPayloadHash: null,
    legacyReferenceUpperHash: null,
    ...overrides,
  };
}

describe("a legacy row is represented only when its alias is covered too", () => {
  it("A. strong identifiers represented AND required alias present -> REPRESENTED", () => {
    const result = classifyRepresentation(
      IDS,
      HERE,
      [ownClaim({ legacyReferenceUpperHash: ALIAS_A })],
      ALIAS_A
    );
    expect(result).toEqual({ kind: "represented" });
  });

  it("B. strong identifiers represented but required alias NULL -> needs_alias", () => {
    const result: any = classifyRepresentation(IDS, HERE, [ownClaim()], ALIAS_A);
    expect(result.kind).toBe("needs_alias");
    expect(result.expected).toBe(ALIAS_A);
    // The SAME claim is targeted - never a second insert.
    expect(result.claim.id).toBe(1);
  });

  it("C. after enrichment the same row reads REPRESENTED", () => {
    const enriched = ownClaim({ legacyReferenceUpperHash: ALIAS_A });
    expect(classifyRepresentation(IDS, HERE, [enriched], ALIAS_A)).toEqual({
      kind: "represented",
    });
  });

  it("D. a DIFFERENT non-null alias is an inconsistency, never an overwrite", () => {
    const result: any = classifyRepresentation(
      IDS,
      HERE,
      [ownClaim({ legacyReferenceUpperHash: ALIAS_B })],
      ALIAS_A
    );
    expect(result.kind).toBe("alias_inconsistent");
    expect(result.existing).toBe(ALIAS_B);
    expect(result.expected).toBe(ALIAS_A);
  });

  it("E. recoverable casing needs no alias -> REPRESENTED", () => {
    // expectedAliasHash undefined: deriveIdentifiers only produces one for
    // legacy_uppercase evidence.
    expect(classifyRepresentation(IDS, HERE, [ownClaim()], undefined)).toEqual({
      kind: "represented",
    });
  });

  it("F. a modern claim needs no alias either", () => {
    expect(
      classifyRepresentation({ referenceHash: HASH_A }, HERE, [ownClaim()], undefined)
    ).toEqual({ kind: "represented" });
  });

  it("G. two sources sharing one lossy alias is not a strong collision", () => {
    // The other source's claim does not own THIS row's identifiers, so it is
    // simply not matched here; sharing an alias is advisory grouping only.
    const other = {
      id: 2,
      sourceType: "wallet_topup",
      sourceId: 99,
      referenceHash: HASH_B,
      fileHash: FILE_B,
      qrPayloadHash: null,
      legacyReferenceUpperHash: ALIAS_A,
    };
    const result = classifyRepresentation(
      IDS,
      HERE,
      [ownClaim({ legacyReferenceUpperHash: ALIAS_A }), other],
      ALIAS_A
    );
    expect(result).toEqual({ kind: "represented" });
  });

  it("a foreign owner is still a collision, alias or not", () => {
    const foreign = ownClaim({ id: 3, sourceType: "wallet_topup", sourceId: 99 });
    const result: any = classifyRepresentation(IDS, HERE, [foreign], ALIAS_A);
    expect(result.kind).toBe("collision");
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("IPE-004 P2: a same-source claim missing ONLY a reference sibling is a repair, not a collision", () => {
    // The claim owns the file hash (same source) but not this row's distinct
    // reference, and nobody else owns that reference. Previously this was
    // reported as a "(unclaimed)" collision, forcing manual review; the
    // review flagged that reference and qr are UNIQUE columns exactly like
    // fileHash and must be enriched in place the same way.
    const partial = ownClaim({ referenceHash: null, legacyReferenceUpperHash: ALIAS_A });
    const result: any = classifyRepresentation(IDS, HERE, [partial], ALIAS_A);
    expect(result.kind).toBe("needs_strong_identifier");
    expect(result.claim.id).toBe(1);
    expect(result.missing).toEqual([{ kind: "reference", field: "referenceHash", value: HASH_A }]);
  });

  it("IPE-001-C01: a same-source claim missing ONLY the fileHash is a repair, not a collision", () => {
    // The claim owns the reference but not this row's exact fileHash - the
    // exact gap Codex flagged: a row already represented via reference/QR
    // whose earlier backfill run never captured its exact fileHash. This
    // must be mechanically repairable (needs_strong_identifier), never a hard
    // collision requiring manual review - reference/QR presence never
    // excuses missing file-byte replay coverage, but neither does it block
    // the tool from filling the gap itself.
    const partial = ownClaim({ fileHash: null, legacyReferenceUpperHash: ALIAS_A });
    const result: any = classifyRepresentation(IDS, HERE, [partial], ALIAS_A);
    expect(result.kind).toBe("needs_strong_identifier");
    expect(result.missing).toEqual([{ kind: "file", field: "fileHash", value: FILE_A }]);
    expect(result.claim.id).toBe(1);
  });

  it("a fileHash claimed by a DIFFERENT source is still a genuine collision", () => {
    const own = ownClaim({ fileHash: null, legacyReferenceUpperHash: ALIAS_A });
    const foreignFile = {
      id: 4,
      sourceType: "wallet_topup",
      sourceId: 77,
      referenceHash: HASH_B,
      fileHash: FILE_A,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(IDS, HERE, [own, foreignFile], ALIAS_A);
    expect(result.kind).toBe("collision");
    expect(result.findings.some((f: any) => f.detail === "claimed by a DIFFERENT source")).toBe(
      true
    );
  });

  it("nothing matched at all is claimable, not represented", () => {
    expect(classifyRepresentation(IDS, HERE, [], ALIAS_A)).toBeUndefined();
  });

  it("a row with no strong identifier is never represented", () => {
    expect(classifyRepresentation({}, HERE, [ownClaim()], ALIAS_A)).toBeUndefined();
  });

  it("IPE-004 P2: a same-source claim missing ONLY a QR sibling is enrichable, not a collision", () => {
    const withQr = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: HASH_B };
    const claim = ownClaim({ qrPayloadHash: null, legacyReferenceUpperHash: ALIAS_A });
    const result: any = classifyRepresentation(withQr, HERE, [claim], ALIAS_A);
    expect(result.kind).toBe("needs_strong_identifier");
    expect(result.missing).toEqual([{ kind: "qr", field: "qrPayloadHash", value: HASH_B }]);
  });

  it("IPE-004 P2: more than one missing same-source axis is enriched together, not a collision", () => {
    const claim = ownClaim({ referenceHash: null, qrPayloadHash: null, legacyReferenceUpperHash: ALIAS_A });
    const withAll = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: HASH_B };
    const result: any = classifyRepresentation(withAll, HERE, [claim], ALIAS_A);
    expect(result.kind).toBe("needs_strong_identifier");
    expect(result.missing.map((m: any) => m.kind).sort()).toEqual(["qr", "reference"]);
  });

  it("a missing sibling that IS owned by a foreign source is still a collision, not an enrichment", () => {
    const own = ownClaim({ referenceHash: null, legacyReferenceUpperHash: ALIAS_A });
    const foreignRef = {
      id: 5,
      sourceType: "wallet_topup",
      sourceId: 88,
      referenceHash: HASH_A,
      fileHash: FILE_B,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(IDS, HERE, [own, foreignRef], ALIAS_A);
    expect(result.kind).toBe("collision");
    // The file axis IS already same-source owned (`own.fileHash === FILE_A`) -
    // nothing residual to claim, so it must not appear as residual either.
    expect(result.residual ?? []).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════
  // IPE-004-C05: a collision on ONE axis must never silently drop coverage
  // accounting for a SIBLING axis this row also carries but that nobody -
  // not a foreign source, not this same source - owns yet.
  // ══════════════════════════════════════════════════════════════════════

  const QR_A = "c".repeat(64);

  it("C05: reference collides with a foreign source, file+QR are unclaimed anywhere -> both residual", () => {
    const ids = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: QR_A };
    const foreignRef = {
      id: 9,
      sourceType: "wallet_topup",
      sourceId: 200,
      referenceHash: HASH_A,
      fileHash: null,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(ids, HERE, [foreignRef], undefined);
    expect(result.kind).toBe("collision");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("reference");
    expect(result.residual.map((r: any) => r.kind).sort()).toEqual(["file", "qr"]);
    expect(result.residual).toEqual(
      expect.arrayContaining([
        { kind: "file", field: "fileHash", value: FILE_A },
        { kind: "qr", field: "qrPayloadHash", value: QR_A },
      ])
    );
  });

  it("C05: file is the ONLY collision, reference+QR are unclaimed anywhere -> both residual", () => {
    const ids = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: QR_A };
    const foreignFile = {
      id: 10,
      sourceType: "wallet_topup",
      sourceId: 201,
      referenceHash: null,
      fileHash: FILE_A,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(ids, HERE, [foreignFile], undefined);
    expect(result.kind).toBe("collision");
    expect(result.findings.map((f: any) => f.kind)).toEqual(["file"]);
    expect(result.residual.map((r: any) => r.kind).sort()).toEqual(["qr", "reference"]);
  });

  it("C05: QR is the ONLY collision, reference+file are unclaimed anywhere -> both residual", () => {
    const ids = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: QR_A };
    const foreignQr = {
      id: 11,
      sourceType: "wallet_topup",
      sourceId: 202,
      referenceHash: null,
      fileHash: null,
      qrPayloadHash: QR_A,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(ids, HERE, [foreignQr], undefined);
    expect(result.kind).toBe("collision");
    expect(result.findings.map((f: any) => f.kind)).toEqual(["qr"]);
    expect(result.residual.map((r: any) => r.kind).sort()).toEqual(["file", "reference"]);
  });

  it("C05: an axis already SAME-SOURCE-owned via a split claim row is excluded from residual - idempotent rerun", () => {
    // Simulates a rerun: an earlier pass already wrote a residual-only claim
    // row for this exact source covering fileHash (C04/C05's own residual
    // mechanism). This pass must recognize that ownership, not attempt a
    // redundant insert or falsely report it uncovered.
    const ids = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: QR_A };
    const foreignRef = {
      id: 12,
      sourceType: "wallet_topup",
      sourceId: 203,
      referenceHash: HASH_A,
      fileHash: null,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const splitSameSourceClaim = {
      id: 13,
      sourceType: "order_payment",
      sourceId: 42,
      referenceHash: null,
      fileHash: FILE_A,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(ids, HERE, [foreignRef, splitSameSourceClaim], undefined);
    expect(result.kind).toBe("collision");
    expect(result.findings.map((f: any) => f.kind)).toEqual(["reference"]);
    // file is already same-source owned via the split claim row - excluded.
    // Only qr (owned by nobody) remains residual.
    expect(result.residual.map((r: any) => r.kind)).toEqual(["qr"]);
  });

  it("C05: residual is empty when every non-colliding axis is already same-source-owned - nothing left to claim", () => {
    const ids = { referenceHash: HASH_A, fileHash: FILE_A, qrPayloadHash: QR_A };
    const foreignRef = {
      id: 14,
      sourceType: "wallet_topup",
      sourceId: 204,
      referenceHash: HASH_A,
      fileHash: null,
      qrPayloadHash: null,
      legacyReferenceUpperHash: null,
    };
    const splitSameSourceClaim = {
      id: 15,
      sourceType: "order_payment",
      sourceId: 42,
      referenceHash: null,
      fileHash: FILE_A,
      qrPayloadHash: QR_A,
      legacyReferenceUpperHash: null,
    };
    const result: any = classifyRepresentation(ids, HERE, [foreignRef, splitSameSourceClaim], undefined);
    expect(result.kind).toBe("collision");
    expect(result.residual).toEqual([]);
  });
});

describe("H. completion is refused while any required alias is missing", () => {
  const script = readCode("scripts/backfill-slip-claims.mjs");
  // IPE-004: the clean-run computation moved into
  // scripts/lib/backfillCompletionGate.mjs (see backfillCompletionGate.test.ts
  // for its full unit coverage) so it can be tested directly and so
  // completion no longer requires zero collisions/unresolved rows - only
  // that they were durably classified. Required alias coverage is
  // UNCHANGED: still part of the rule, just relocated.
  const gateCode = readCode("scripts/lib/backfillCompletionGate.mjs");

  it("alias coverage is part of the clean-run rule", () => {
    expect(gateCode).toMatch(
      /const aliasCoverageComplete = stats\.aliasUncovered === 0 && stats\.aliasInconsistencies\.length === 0;/
    );
    const start = gateCode.indexOf("const cleanRun =");
    const body = gateCode.slice(start, start + 400);
    expect(body).toMatch(/aliasCoverageComplete/);
    // The script still delegates to it and still refuses when it says no.
    expect(script).toMatch(/evaluateBackfillCompletion\(/);
    expect(script).toMatch(/const cleanRun = gate\.cleanRun/);
  });

  it("the refusal message names the alias counters", () => {
    expect(gateCode).toMatch(/aliasUncovered=\$\{stats\.aliasUncovered\}/);
    expect(gateCode).toMatch(/aliasInconsistencies=\$\{stats\.aliasInconsistencies\.length\}/);
    // The script's console.error surfaces the gate's own reasons verbatim.
    expect(script).toMatch(/gate\.reasons\.join/);
  });

  it("a dry run reports WOULD_ENRICH_LEGACY_ALIAS and counts the row as uncovered", () => {
    const start = script.indexOf('if (registry?.kind === "needs_alias")');
    const body = script.slice(start, start + 1800);
    expect(body).toMatch(/WOULD_ENRICH_LEGACY_ALIAS/);
    expect(body).toMatch(/stats\.wouldEnrichAlias \+= 1/);
    expect(body).toMatch(/stats\.aliasUncovered \+= 1/);
  });

  it("a live run UPDATES the same claim and re-reads to confirm", () => {
    const start = script.indexOf('if (registry?.kind === "needs_alias")');
    // Bounded to the branch itself - the normal claim insert lives further down.
    const body = script.slice(start, script.indexOf('if (registry?.kind === "collision")', start));
    expect(body).toMatch(/\.update\(schema\.paymentSlipClaims\)/);
    expect(body).toMatch(/\.set\(\{ legacyReferenceUpperHash: registry\.expected \}\)/);
    expect(body).toMatch(/await verifyAliasPersisted\(registry\.claim\.id, registry\.expected\)/);
    // No second claim row is ever inserted for an alias.
    expect(body).not.toMatch(/\.insert\(schema\.paymentSlipClaims\)/);
  });

  it("an enrichment that did not land is a failure, not coverage", () => {
    const start = script.indexOf('if (registry?.kind === "needs_alias")');
    const body = script.slice(start, start + 1800);
    expect(body).toMatch(/alias not present after update/);
  });

  it("an inconsistency is reported and sets a non-zero exit code", () => {
    expect(script).toMatch(/LEGACY_ALIAS_INCONSISTENCY/);
    // IPE-004: the final exit-code check was rewritten so that a merely
    // EXPECTED finding (a durably-classified collision or unresolved row)
    // no longer forces a non-zero exit forever - but a genuine operator-only
    // problem, like an alias inconsistency, still does.
    const start = script.indexOf("const hasGenuineProblem =");
    const body = script.slice(start, start + 300);
    expect(body).toMatch(/stats\.aliasInconsistencies\.length > 0/);
  });

  it("the advisory alias grouping still does not block completion", () => {
    expect(script).toMatch(/AMBIGUOUS_LEGACY_ALIAS_GROUP/);
    expect(script).toMatch(/does NOT block completion/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2b. BACKFILL: MANDATORY EXACT fileHash COVERAGE (IPE-001-C01)
// ════════════════════════════════════════════════════════════════════════
//
// Codex P1: a row already carrying a reference/QR could be marked complete
// without ever owning its exact file hash, so replaying the same image when
// OCR is disabled/fails could present only a fileHash and evade the
// historical claim entirely. Mirrors the alias-coverage matrix above, but
// for the file axis.

describe("I. completion is refused while any required exact fileHash coverage is missing", () => {
  const script = readCode("scripts/backfill-slip-claims.mjs");
  // IPE-004: relocated into scripts/lib/backfillCompletionGate.mjs - see the
  // note on section H above. Required fileHash coverage is UNCHANGED.
  const gateCode = readCode("scripts/lib/backfillCompletionGate.mjs");

  it("fileHash coverage is part of the clean-run rule", () => {
    expect(gateCode).toMatch(
      /const fileHashCoverageComplete = stats\.fileHashUncovered === 0;/
    );
    const start = gateCode.indexOf("const cleanRun =");
    const body = gateCode.slice(start, start + 400);
    expect(body).toMatch(/fileHashCoverageComplete/);
  });

  it("the refusal message names the fileHash coverage counter", () => {
    expect(gateCode).toMatch(/fileHashUncovered=\$\{stats\.fileHashUncovered\}/);
  });

  it("a dry run reports WOULD_ENRICH_<axis> and counts the row as uncovered", () => {
    const start = script.indexOf('if (registry?.kind === "needs_strong_identifier")');
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 2200);
    expect(body).toMatch(/WOULD_ENRICH_\$\{m\.kind\.toUpperCase\(\)\}/);
    expect(body).toMatch(/stats\[c\.would\] \+= 1/);
    expect(body).toMatch(/stats\[c\.uncovered\] \+= 1/);
    // fileHash keeps its own counters so the gate's fileHashUncovered stays
    // meaningful; reference/qr share strongId*.
    expect(body).toMatch(/uncovered: "fileHashUncovered"/);
    expect(body).toMatch(/uncovered: "strongIdUncovered"/);
  });

  it("a live run UPDATES the same claim, one axis at a time, and re-reads to confirm", () => {
    const start = script.indexOf('if (registry?.kind === "needs_strong_identifier")');
    const body = script.slice(start, script.indexOf('if (registry?.kind === "collision")', start));
    expect(body).toMatch(/\.update\(schema\.paymentSlipClaims\)/);
    expect(body).toMatch(/\.set\(\{ \[m\.field\]: m\.value \}\)/);
    expect(body).toMatch(/rows\?\.\[0\]\?\.\[m\.field\] === m\.value/);
    // No second claim row is ever inserted for an enrichment.
    expect(body).not.toMatch(/\.insert\(schema\.paymentSlipClaims\)/);
  });

  it("an enrichment that did not land is a failure, not coverage", () => {
    const start = script.indexOf('if (registry?.kind === "needs_strong_identifier")');
    const body = script.slice(start, start + 2200);
    expect(body).toMatch(/\$\{m\.field\} not present after update/);
  });

  it("a duplicate-key error during enrichment is reported as a genuine collision, never swallowed", () => {
    const start = script.indexOf('if (registry?.kind === "needs_strong_identifier")');
    const body = script.slice(start, script.indexOf('if (registry?.kind === "collision")', start));
    expect(body).toMatch(/ER_DUP_ENTRY/);
    // IPE-004-C03: the collision-recording logic itself moved into the
    // shared, independently-tested recordConfirmedDuplicateKeyCollisions ->
    // resolveDuplicateKeyCollisions pure function (see
    // backfillDuplicateKeyResolution.test.ts) - it re-reads to identify the
    // EXACT colliding axis rather than blindly recording every present
    // identifier. This site now delegates to it instead of pushing inline.
    expect(body).toMatch(/recordConfirmedDuplicateKeyCollisions\(/);

    const fnCode = readCode("scripts/backfill-slip-claims.mjs");
    const fnStart = fnCode.indexOf("async function recordConfirmedDuplicateKeyCollisions(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = fnCode.slice(fnStart, fnStart + 600);
    expect(fnBody).toMatch(/resolveDuplicateKeyCollisions\(/);
    expect(fnBody).toMatch(/tracker\.collisions\.push/);
  });

  it("--mark-complete is refused while fileHash coverage is incomplete", () => {
    const start = script.indexOf("if (!cleanRun) {");
    const body = script.slice(start, start + 700);
    // The refusal message surfaces the gate's own reasons, which include
    // fileHashUncovered whenever it is non-zero (see backfillCompletionGate.mjs).
    expect(body).toMatch(/gate\.reasons\.join/);
  });
});

describe("required fileHash coverage via classifyRepresentation", () => {
  it("a fresh row with nothing claimed yet is claimable, not repairable - the normal insert already carries fileHash", () => {
    expect(classifyRepresentation(IDS, HERE, [], undefined)).toBeUndefined();
  });

  it("a row with no fileHash identifier at all never triggers file-hash repair", () => {
    expect(
      classifyRepresentation({ referenceHash: HASH_A }, HERE, [ownClaim({ fileHash: null })], undefined)
    ).toEqual({ kind: "represented" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. RECHECK: A STRONG IDENTIFIER IS MONOTONIC
// ════════════════════════════════════════════════════════════════════════

describe("recheck may add a strong identifier but never remove one", () => {
  const code = readCode("server/services/ocrRecheckService.ts");

  // IPE-001-C08: A failed second fetch used to silently fall back to the
  // pre-OCR hash (`recomputedFileHash ?? preOcrFileHash`), treating an
  // UNPROVEN second read as if it were confirmed stability - exactly the P1
  // this round closed. It is now routed through the same verifyStableOrBlock
  // checkpoint as a genuine mismatch (see server/recheckFileIntegrityDurability.test.ts
  // for the dedicated coverage of that helper); this block keeps only the
  // invariants specific to the "add, never remove" monotonic promise itself.

  it("the persisted extraction is built from the effective hash", () => {
    const start = code.indexOf("let effectiveFileHash:");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, start + 700);
    expect(body).toMatch(/const extractedWithFile = effectiveFileHash/);
  });

  it("C. two different hashes for one stored slip is an integrity stop, via the shared checkpoint", () => {
    const start = code.indexOf("async function verifyStableOrBlock(");
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, start + 2200);
    expect(body).toMatch(/SLIP_INTEGRITY_BLOCK_REASON/);
    expect(body).toMatch(/readyForAdminApproval: false/);
    expect(body).toMatch(/verificationPassed: false/);
    // The post-extraction call site returns the block result immediately -
    // before the EXTRACTION update further down - so HASH_A's persisted
    // extraction is not overwritten.
    const postExtractCallIdx = code.indexOf(
      "let effectiveFileHash: string | undefined = preOcrFileHash || undefined;"
    );
    const blockedReturnIdx = code.indexOf("if (blocked) return blocked;", postExtractCallIdx);
    const finalWriteIdx = code.indexOf("const wroteFinal = await db.updatePaymentIfNotFinalized(");
    expect(blockedReturnIdx).toBeGreaterThan(postExtractCallIdx);
    expect(blockedReturnIdx).toBeLessThan(finalWriteIdx);
  });

  it("the mismatch is durably persisted, not just returned - IPE-001 P2", () => {
    // A same-URL byte mutation must block normal Approve until integrity is
    // re-established, not merely be logged and forgotten with this response.
    const start = code.indexOf("async function verifyStableOrBlock(");
    const returnIdx = code.indexOf("return {", start);
    const body = code.slice(start, returnIdx);
    expect(body).toMatch(/const wroteBlock = await db\.updatePaymentIfNotFinalized\(/);
    expect(body).toMatch(/reviewReason: SLIP_INTEGRITY_BLOCK_REASON/);
    // Guarded by the same slip-version binding as every other conditional
    // write in this function - a genuine replacement (which already clears
    // reviewReason on publish) must not have this stale block written onto it.
    expect(body).toMatch(/slipVersionAtStart/);
    expect(body).toMatch(/if \(!wroteBlock\) \{/);
    expect(body).toMatch(/return await buildSupersededResult\(/);
  });

  it("the shared block reason is exported from orderService, not duplicated as a literal", () => {
    const orderCode = readCode("server/services/orderService.ts");
    expect(orderCode).toMatch(
      /export const SLIP_INTEGRITY_BLOCK_REASON = "SLIP_FILE_HASH_CHANGED_DURING_RECHECK";/
    );
    expect(code).toMatch(/import \{ sameSlipVersion, SLIP_INTEGRITY_BLOCK_REASON \} from "\.\/orderService"/);
    expect(code).not.toMatch(/"SLIP_FILE_HASH_CHANGED_DURING_RECHECK"/);
  });

  it("the integrity stop happens BEFORE any persistence of the new extraction", () => {
    const checkpointIdx = code.indexOf(
      "let effectiveFileHash: string | undefined = preOcrFileHash || undefined;"
    );
    const finalWriteIdx = code.indexOf("const wroteFinal = await db.updatePaymentIfNotFinalized(");
    expect(checkpointIdx).toBeGreaterThan(-1);
    expect(finalWriteIdx).toBeGreaterThan(checkpointIdx);
  });

  it("the integrity stop still reports the identifier it kept", () => {
    const start = code.indexOf("async function verifyStableOrBlock(");
    const body = code.slice(start, start + 2800);
    expect(body).toMatch(/hasStrongIdentifier: true/);
    expect(body).toMatch(/fileIdentifierStatus: describeFileIdentifierStatus\(\{ fileHash: baselineHash \}\)/);
  });

  it("the reported file-identifier status uses the effective hash", () => {
    expect(code).toMatch(/fileHash: effectiveFileHash,\s*\n\s*duplicateFileMatch/);
  });

  it("E/F. the pre-OCR recovery still runs above the OCR guard and merges", () => {
    const preIdx = code.indexOf("const preOcrFileHash = await computeSlipFileHash");
    const guardIdx = code.indexOf("if (!config.enabled)");
    expect(preIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(preIdx);
    expect(code).toMatch(/mergeFileHashInto\(payment\.extractedData as string \| null, preOcrFileHash\)/);
  });

  it("G. the hash is always computed server-side from the stored bytes", () => {
    expect(code).toMatch(/computeSlipFileHash\(payment\.slipImageUrl\)/);
    expect(code).not.toMatch(/input\.fileHash|clientFileHash/);
  });
});
