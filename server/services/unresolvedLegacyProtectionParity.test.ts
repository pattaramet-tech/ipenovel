/**
 * IPE-001 P2 (two findings, one theme): "Block recheck readiness for
 * unresolved legacy rows" (server/services/ocrRecheckService.ts) and
 * "Surface unresolved legacy protection in order details" (server/routers.ts
 * admin.orders.detail).
 *
 * ── The bugs ───────────────────────────────────────────────────────────────
 * The previous round introduced `SlipConflict`'s `"unresolved"` kind: an
 * approved historical row the live legacy scan could not evaluate (no
 * persisted fileHash, none recoverable from stored bytes). Normal Approve
 * already fails closed on it (`LEGACY_APPROVED_SLIP_UNRESOLVED`, wired into
 * all four live claim paths). Two other consumers of the SAME
 * `evaluateSlipConflict` classifier were not updated to recognise it:
 *
 *   - Admin Recheck's readiness computation excluded only `strong_duplicate`
 *     and `legacy_case_ambiguity`, so an unresolved row could still produce
 *     `verificationPassed: true, readyForAdminApproval: true` - inviting an
 *     admin to approve something Approve is guaranteed to refuse.
 *   - The admin order-detail query mapped only `strong_duplicate` and
 *     `legacy_case_ambiguity`, so `unresolved` fell through unmapped: the
 *     panel could show an unrelated old OCR reason with no indication that
 *     replay protection is incomplete.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Both now recognise `conflict.kind === "unresolved"` using the SAME
 * terminology `claimSlip`'s callers already throw
 * (`LEGACY_APPROVED_SLIP_UNRESOLVED`) - no second error string invented.
 * Recheck: `verificationPassed`/`readyForAdminApproval` are false, and the
 * `duplicate` field reports a third, distinct `strength: "unresolved"`
 * (never `"strong"`, never `"legacy_case_ambiguity"` - it has no audited
 * "confirm distinct" resolution flow, so `requiresAdminResolution` is never
 * set true for it). Detail: the same mapping, also without offering the
 * legacy-case resolution controls.
 *
 * ── Why exercised this way ─────────────────────────────────────────────────
 * `evaluateSlipConflict` itself is behaviourally exercised (real classifier,
 * mocked `computeSlipFileHash`, same harness style as
 * legacyScanFileHashRecovery.test.ts) to prove it actually returns
 * `"unresolved"` for this exact input shape. Recheck's and the router's
 * consumption of that result are pinned structurally, matching this
 * repo's established pattern for these two files (both already have
 * structural-only coverage elsewhere, e.g. ocrRecheckService.test.ts's
 * "strength: 'legacy_case_ambiguity'" checks and
 * lockedStatusAndDetailClassifier.test.ts's router checks) - a full
 * behavioural run of either would require a live database connection this
 * sandbox does not have.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import { claimSlip } from "./slipClaimService";
import * as backfillState from "./slipBackfillStateService";
import * as slipFileHashService from "./slipFileHashService";
import { hashSlipReference } from "./slipIdentifierService";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

afterEach(() => {
  vi.restoreAllMocks();
});

const FILE_A = "a".repeat(64);
const REF = "016234222922AQR05745";
const REF_HASH = hashSlipReference(REF)!;

function makeTx(options: {
  claims?: any[];
  approvedPayments?: Array<{ id: number; extractedData: string | null; slipImageUrl?: string | null }>;
  approvedTopups?: Array<{ id: number; extractedData: string | null; slipImageUrl?: string | null }>;
} = {}) {
  const claims = options.claims ?? [];
  return {
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          return {
            // findAnyLegacyFileIdentityUnknown (IPE-004-C03) calls
            // select().from(...).limit(1) directly, with no .where() at all -
            // the only such shape here. This fixture never seeds
            // paymentSlipLegacyUnknown, so it is always empty.
            limit: async () => [],
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

// ════════════════════════════════════════════════════════════════════════
// §9 A-E: the classifier itself, which both consumers below rely on
// ════════════════════════════════════════════════════════════════════════

describe("evaluateSlipConflict: the unresolved verdict both consumers must respect", () => {
  it("A. a strong identifier is present but the legacy scan cannot evaluate an approved row -> unresolved", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeTx({
      approvedPayments: [{ id: 71, extractedData: null, slipImageUrl: "r2p:payment-slips/x" }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("unresolved");
    if (conflict.kind === "unresolved") {
      expect(conflict.matchedSourceType).toBe("order_payment");
      expect(conflict.matchedSourceId).toBe(71);
    }
  });

  it("B. same shape, no conflicting historical row -> none (existing READY behavior unchanged)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeTx({ approvedPayments: [] });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("none");
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("C. a strong duplicate is unaffected by the unresolved branch", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      claims: [{ sourceType: "order_payment", sourceId: 9, referenceHash: REF_HASH }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { referenceHash: REF_HASH }, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("strong_duplicate");
  });

  it("D. a legacy-case ambiguity is unaffected by the unresolved branch", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    // Must contain lowercase letters, or its upper-cased form is identical
    // and this collapses into an exact match instead of a lossy fold.
    const MIXED = "202608225ApOyxElgdOo7YVwv";
    const MIXED_HASH = hashSlipReference(MIXED)!;
    const UPPER_HASH = hashSlipReference(MIXED.toUpperCase())!;
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
      { identifiers: { referenceHash: MIXED_HASH }, rawReference: MIXED, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("legacy_case_ambiguity");
  });

  it("E. post-backfill (scan disabled), an unresolvable legacy row never surfaces at all", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const computeSpy = vi.spyOn(slipFileHashService, "computeSlipFileHash");
    const tx = makeTx({
      approvedPayments: [{ id: 71, extractedData: null, slipImageUrl: "r2p:payment-slips/x" }],
    });

    const conflict = await evaluateSlipConflict(
      { identifiers: { fileHash: FILE_A }, sourceType: "wallet_topup", sourceId: 1 },
      tx
    );

    expect(conflict.kind).toBe("none");
    expect(computeSpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7-9: Recheck readiness must treat unresolved as blocking
// ════════════════════════════════════════════════════════════════════════

describe("ocrRecheckService.ts: unresolved blocks READY, using the existing terminology", () => {
  const code = readCode("server/services/ocrRecheckService.ts");

  it("verificationPassed excludes an unresolved conflict, not just strong/ambiguity", () => {
    const idx = code.indexOf("const verificationPassed =");
    const body = code.slice(idx, idx + 300);
    expect(body).toMatch(/!strongDuplicate/);
    expect(body).toMatch(/!legacyAmbiguity/);
    expect(body).toMatch(/!unresolvedLegacy/);
  });

  it("readyForAdminApproval is derived from verificationPassed, so it inherits the block", () => {
    expect(code).toMatch(
      /const readyForAdminApproval = verificationPassed && strongIdentifierPresent;/
    );
  });

  it("the unresolved conflict reason reuses LEGACY_APPROVED_SLIP_UNRESOLVED, no second error string", () => {
    const idx = code.indexOf("const conflictReason =");
    const body = code.slice(idx, code.indexOf(";", idx + 200));
    expect(body).toMatch(/unresolvedLegacy\s*\n?\s*\?\s*"LEGACY_APPROVED_SLIP_UNRESOLVED"/);
  });

  it("unresolved is classified from conflict.kind, deriving from the same evaluator", () => {
    expect(code).toMatch(
      /const unresolvedLegacy = conflict\.kind === "unresolved" \? conflict : undefined;/
    );
  });

  it("never describes an unresolved row as a proven duplicate", () => {
    const idx = code.indexOf("strength: \"unresolved\"");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(Math.max(0, idx - 400), idx + 200);
    expect(body).not.toMatch(/strength: "strong"/);
  });

  it("does not grant the audited legacy-case resolution flow to an unresolved row", () => {
    const idx = code.indexOf("requiresAdminResolution: Boolean(legacyAmbiguity)");
    expect(idx).toBeGreaterThan(-1);
    // Confirms the flag is bound to legacyAmbiguity ONLY, not unresolvedLegacy.
    expect(code.slice(idx, idx + 60)).not.toMatch(/unresolvedLegacy/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §10: Admin order detail must surface the same state
// ════════════════════════════════════════════════════════════════════════

describe("routers.ts admin.orders.detail: unresolved legacy protection is surfaced", () => {
  const code = readCode("server/routers.ts");

  it("maps conflict.kind === 'unresolved' using the shared evaluator's result", () => {
    expect(code).toMatch(/\} else if \(conflict\.kind === "unresolved"\) \{/);
  });

  it("uses the SAME reviewReason terminology as normal Approve and Recheck", () => {
    const idx = code.indexOf('conflict.kind === "unresolved"');
    const body = code.slice(idx, idx + 900);
    expect(body).toMatch(/reviewReasonOverride = "LEGACY_APPROVED_SLIP_UNRESOLVED"/);
    expect(body).toMatch(/strength: "unresolved"/);
  });

  it("never offers the legacy-case 'confirm distinct' resolution controls for it", () => {
    const idx = code.indexOf('conflict.kind === "unresolved"');
    const body = code.slice(idx, idx + 900);
    expect(body).not.toMatch(/requiresAdminResolution: true/);
  });

  it("the duplicate type accepts the third strength value", () => {
    expect(code).toMatch(/strength: "strong" \| "legacy_case_ambiguity" \| "unresolved"/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §12: Detail / Recheck / Approve parity for the SAME unresolved state
// ════════════════════════════════════════════════════════════════════════

describe("Detail, Recheck and Approve agree on the SAME unresolved historical protection state", () => {
  it("claimSlip (Approve's own path) refuses with legacy_scan_unresolved for this exact shape", async () => {
    vi.spyOn(slipFileHashService, "computeSlipFileHash").mockResolvedValue(undefined);
    const tx = makeTx({
      approvedPayments: [{ id: 71, extractedData: null, slipImageUrl: "r2p:payment-slips/x" }],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 900, userId: 1, identifiers: { fileHash: FILE_A } },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) expect(outcome.reason).toBe("legacy_scan_unresolved");
  });

  it("none of the three consumers can report READY / NO CONFLICT / DUPLICATE CONFIRMED for it", () => {
    const recheck = readCode("server/services/ocrRecheckService.ts");
    const routers = readCode("server/routers.ts");
    const claimService = readCode("server/services/slipClaimService.ts");

    // Recheck: readiness is gated off unresolvedLegacy (verified above);
    // spot-check the literal never appears attached to a bare "true".
    expect(recheck).not.toMatch(/unresolvedLegacy[\s\S]{0,40}readyForAdminApproval\s*=\s*true/);

    // Router: the unresolved branch never sets strength to "strong".
    const idx = routers.indexOf('conflict.kind === "unresolved"');
    expect(routers.slice(idx, idx + 900)).not.toMatch(/strength: "strong"/);

    // Claim service: unresolved is a distinct reason, never folded into
    // already_claimed (which would imply a confirmed duplicate).
    expect(claimService).toMatch(/reason: "legacy_scan_unresolved"/);
  });

  it("all three name the identical reviewReason string", () => {
    const recheck = readCode("server/services/ocrRecheckService.ts");
    const routers = readCode("server/routers.ts");
    const orderApprove = readCode("server/services/orderService.ts");
    const walletApprove = readCode("server/db.ts");

    for (const code of [recheck, routers, orderApprove, walletApprove]) {
      expect(code).toMatch(/LEGACY_APPROVED_SLIP_UNRESOLVED/);
    }
  });
});
