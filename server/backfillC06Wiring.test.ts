/**
 * IPE-004-C06: structural pins for scripts/backfill-slip-claims.mjs's
 * required-advisory-alias wiring. The decision LOGIC is independently
 * unit-tested in backfillAliasCoverage.test.ts (the pure
 * decideAliasCoverage matrix); this file pins that the script actually
 * CALLS it on the two buckets that previously escaped alias coverage
 * entirely - the script itself connects to a real database at module load
 * and cannot be imported in this sandbox (no TEST_DATABASE_URL), matching
 * this codebase's established pattern for other DB-connected files.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const code = readCode("scripts/backfill-slip-claims.mjs");

describe("P1: the unknown-only bucket covers its required advisory alias", () => {
  it("the no-strong-identifier + unrecoverable-file branch calls ensureLegacyAliasCoverage before continuing", () => {
    const idx = code.indexOf("stats.noIdentifier += 1;");
    expect(idx).toBeGreaterThan(-1);
    // Scope to THIS branch's own "continue;" so the pin cannot be satisfied
    // by a call belonging to a later branch.
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/await recordUnknownRow\(/);
    expect(body).toMatch(/await ensureLegacyAliasCoverage\(expectedAlias, sourceType, row\.id, row\.userId\)/);
  });
});

describe("P1: both collision buckets cover their required advisory alias", () => {
  it("the registry.kind === collision branch calls ensureLegacyAliasCoverage", () => {
    const idx = code.indexOf('if (registry?.kind === "collision") {');
    expect(idx).toBeGreaterThan(-1);
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/await ensureLegacyAliasCoverage\(expectedAlias, sourceType, row\.id, row\.userId\)/);
  });

  it("the in-run tracker collision branch calls ensureLegacyAliasCoverage", () => {
    const idx = code.indexOf("const collidingKinds = tracker.check(ids, current);");
    expect(idx).toBeGreaterThan(-1);
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/await ensureLegacyAliasCoverage\(expectedAlias, sourceType, row\.id, row\.userId\)/);
  });
});

describe("P1: ensureLegacyAliasCoverage never fabricates exact coverage and never silently fails", () => {
  it("delegates the decision to the independently-tested pure module", () => {
    expect(code).toMatch(
      /import \{ decideAliasCoverage \} from "\.\/lib\/backfillAliasCoverage\.mjs";/
    );
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 3000);
    expect(body).toMatch(/decideAliasCoverage\(expectedAlias, await findAllSameSourceClaims\(current\)\)/);
  });

  it("the alias-only insert leaves EVERY exact identifier column null", () => {
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    const insertIdx = code.indexOf("db.insert(schema.paymentSlipClaims)", idx);
    expect(insertIdx).toBeGreaterThan(idx);
    const body = code.slice(insertIdx, insertIdx + 500);
    expect(body).toMatch(/referenceHash: null/);
    expect(body).toMatch(/fileHash: null/);
    expect(body).toMatch(/qrPayloadHash: null/);
    expect(body).toMatch(/legacyReferenceUpperHash: expectedAlias/);
  });

  it("re-reads by SOURCE to verify the alias actually landed, and counts a miss as uncovered + failure", () => {
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    const body = code.slice(idx, idx + 3000);
    expect(body).toMatch(/const after = await findAllSameSourceClaims\(current\);/);
    expect(body).toMatch(/after\.some\(\(c\) => c\.legacyReferenceUpperHash === expectedAlias\)/);
    expect(body).toMatch(/stats\.aliasUncovered \+= 1;/);
    expect(body).toMatch(/stage: "alias coverage"/);
  });

  it("a thrown write is caught and counted uncovered - never swallowed", () => {
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    const body = code.slice(idx, idx + 3000);
    const catchIdx = body.lastIndexOf("} catch (error) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = body.slice(catchIdx, catchIdx + 400);
    expect(catchBody).toMatch(/stats\.aliasUncovered \+= 1;/);
    expect(catchBody).toMatch(/stats\.failures\.push\(/);
  });

  it("an inconsistent existing alias is reported for an operator, never overwritten", () => {
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    const body = code.slice(idx, idx + 3000);
    expect(body).toMatch(/decision\.action === "inconsistent"/);
    expect(body).toMatch(/stats\.aliasInconsistencies\.push\(/);
  });

  it("dry-run reports the coverage it WOULD create instead of silently skipping it", () => {
    const idx = code.indexOf("async function ensureLegacyAliasCoverage(");
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(/if \(!isLive\)/);
    expect(body).toMatch(/stats\.wouldEnrichAlias \+= 1;/);
    expect(body).toMatch(/stats\.aliasUncovered \+= 1;/);
  });

  it("alias coverage is recognized across ALL same-source claim rows, not just the first", () => {
    const idx = code.indexOf("async function findAllSameSourceClaims(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 600);
    // Must never collapse to .limit(1) - split residual claim
    // rows from C04/C05 mean a source can own several.
    expect(body).not.toMatch(/\.limit\(1\)/);
    expect(body).toMatch(/\.limit\((\d+|SAME_SOURCE_CLAIM_READ_LIMIT)\)/);
  });
});

describe("P2: conflict evaluation is per-axis", () => {
  const evaluator = readCode("server/services/slipConflictEvaluator.ts");

  it("collects EVERY colliding axis rather than short-circuiting on the first", () => {
    expect(evaluator).toMatch(/findKnownLegacyCollisionAxes\(input\.identifiers, tx, self\)/);
    expect(evaluator).toMatch(/const collidingKinds = new Set\(collisionAxes\.map\(\(c\) => c\.kind\)\)/);
  });

  it("the exact-claim lookup is restricted to the axes proven clean", () => {
    // IPE-004-C07 replaced the or()+limit(1) findExistingClaim here with the
    // deterministic per-axis helper; the restriction to clean axes is what
    // this pin is actually about, and is unchanged.
    expect(evaluator).toMatch(/findForeignClaimPerAxis\(nonCollidingIdentifiers, tx, self\)/);
    expect(evaluator).not.toMatch(/findExistingClaim\(input\.identifiers, tx\)/);
  });

  it("known_collision is returned only AFTER the clean-axis claim lookup found nothing", () => {
    const claimIdx = evaluator.indexOf("findForeignClaimPerAxis(nonCollidingIdentifiers, tx, self)");
    const collisionReturnIdx = evaluator.indexOf("if (collisionAxes.length > 0) {");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(collisionReturnIdx).toBeGreaterThan(claimIdx);
  });

  it("the per-axis lookup is still bounded and indexed - no scan reintroduced", () => {
    const service = readCode("server/services/slipLegacyCollisionService.ts");
    const idx = service.indexOf("export async function findKnownLegacyCollisionAxes(");
    expect(idx).toBeGreaterThan(-1);
    const body = service.slice(idx, idx + 1200);
    expect(body).toMatch(/\.limit\(5\)/);
    expect(body).toMatch(/eq\(paymentSlipLegacyCollisions\.identifierHash, hash\)/);
  });
});
