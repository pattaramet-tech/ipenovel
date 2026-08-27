/**
 * IPE-004-C05: structural pins for scripts/backfill-slip-claims.mjs's
 * general-collision residual-axis wiring. The decision LOGIC is
 * independently unit-tested in boundResolutionAndAliasCoverage.test.ts
 * (classifyRepresentation's `residual` computation) and
 * backfillResidualIdentifierClaim.test.ts (the pure claim/retry state
 * machine, reused unchanged from C04); this file pins that the script
 * actually CALLS them at both collision-discovery sites - the script itself
 * connects to a real database at module load and cannot be imported in this
 * sandbox (no TEST_DATABASE_URL), matching this codebase's established
 * pattern for other DB-connected files.
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

describe("P1: registry-discovered collision claims every residual axis", () => {
  it("the registry.kind === collision branch calls claimResidualAxesAfterCollision when residual is non-empty", () => {
    const idx = code.indexOf('if (registry?.kind === "collision") {');
    expect(idx).toBeGreaterThan(-1);
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/registry\.residual\s*&&\s*registry\.residual\.length > 0/);
    expect(body).toMatch(/await claimResidualAxesAfterCollision\(/);
  });

  it("the residual ids object is built from registry.residual entries, not the full ids", () => {
    const idx = code.indexOf('if (registry?.kind === "collision") {');
    const callIdx = code.indexOf("await claimResidualAxesAfterCollision(", idx);
    expect(callIdx).toBeGreaterThan(idx);
    const before = code.slice(idx, callIdx);
    expect(before).toMatch(/for \(const \{ field, value \} of registry\.residual\) residualIds\[field\] = value;/);
  });

  it("the in-run tracker collision branch also calls claimResidualAxesAfterCollision", () => {
    const idx = code.indexOf("const collidingKinds = tracker.check(ids, current);");
    expect(idx).toBeGreaterThan(-1);
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/await claimResidualAxesAfterCollision\(/);
  });

  it("the in-run tracker residual ids exclude every colliding kind", () => {
    const idx = code.indexOf("const collidingKinds = tracker.check(ids, current);");
    const callIdx = code.indexOf("await claimResidualAxesAfterCollision(", idx);
    expect(callIdx).toBeGreaterThan(idx);
    const before = code.slice(idx, callIdx);
    expect(before).toMatch(/!collidingKinds\.includes\(kind\)/);
  });

  it("claimResidualAxesAfterCollision delegates the actual claim/retry state machine to claimResidualIdentifiers, not a reimplementation", () => {
    const idx = code.indexOf("async function claimResidualAxesAfterCollision(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(/await claimResidualIdentifiers\(residualIds, new Set\(\)/);
  });

  it("claimResidualAxesAfterCollision reports dry-run coverage instead of silently skipping it", () => {
    const idx = code.indexOf("async function claimResidualAxesAfterCollision(");
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(/if \(!isLive\)/);
    expect(body).toMatch(/stats\[c\.would\]/);
    expect(body).toMatch(/stats\[c\.uncovered\]/);
  });

  it("claimResidualAxesAfterCollision remembers residual identifiers in the in-run tracker before any dry-run/live branch", () => {
    const idx = code.indexOf("async function claimResidualAxesAfterCollision(");
    const liveCheckIdx = code.indexOf("if (!isLive)", idx);
    const rememberIdx = code.indexOf("tracker.remember(residualIds, current);", idx);
    expect(rememberIdx).toBeGreaterThan(idx);
    expect(rememberIdx).toBeLessThan(liveCheckIdx);
  });

  it("empty residual is a documented no-op - no counters touched, no claim attempted", () => {
    const idx = code.indexOf("async function claimResidualAxesAfterCollision(");
    const body = code.slice(idx, idx + 500);
    expect(body).toMatch(/if \(present\.length === 0\) return;/);
  });
});

describe("P3: documentation no longer contradicts the bounded post-completion sufficiency check", () => {
  it("the runbook's top unknown-bucket bullet no longer claims the table is never consulted", () => {
    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), "RUNBOOK_legacy_slip_backfill.md"),
      "utf-8"
    );
    expect(runbook).not.toMatch(/\*\*Never\s*\n?\s*consulted to block or approve anything\.\*\*/);
    expect(runbook).not.toMatch(/Never\s+consulted to block or approve anything/);
  });

  it("the backfill's UNRESOLVED per-row console message no longer claims it is never consulted", () => {
    expect(code).not.toMatch(/NEVER consulted to block or approve an unrelated/);
  });
});
