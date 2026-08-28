/**
 * IPE-004-C04: structural pins for scripts/backfill-slip-claims.mjs's
 * orchestration wiring. The decision LOGIC is independently unit-tested in
 * backfillResidualIdentifierClaim.test.ts and
 * backfillDuplicateKeyResolution.test.ts (pure modules); this file pins
 * that the script actually CALLS them at every required site - the script
 * itself connects to a real database at module load and cannot be imported
 * in this sandbox (no TEST_DATABASE_URL), matching this codebase's
 * established pattern for other DB-connected files.
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

describe("P1: partial duplicate insert claims every non-colliding residual axis", () => {
  it("the top-level insert catch calls claimResidualIdentifiers whenever confirmed > 0 and selfOwnsEvery is false", () => {
    const catchIdx = code.indexOf("const { confirmed, selfOwnsEvery, collisions } = await recordConfirmedDuplicateKeyCollisions(");
    expect(catchIdx).toBeGreaterThan(-1);
    const body = code.slice(catchIdx, catchIdx + 1400);
    // Pin the SPECIFIC branch that reaches claimResidualIdentifiers, not just
    // any "} else {" in the window (the outer catch's own else, a few lines
    // further down, would otherwise satisfy a looser regex and mask a
    // reverted/disabled branch here).
    const residualBranchIdx = body.indexOf("await claimResidualIdentifiers(");
    expect(residualBranchIdx).toBeGreaterThan(-1);
    const precedingGuard = body.slice(0, residualBranchIdx);
    expect(precedingGuard).toMatch(/\}\s*else\s*(if\s*\([^)]*\))?\s*\{[^}]*$/s);
    expect(precedingGuard).not.toMatch(/\belse if \(false\)/);
  });

  it("claimResidualIdentifiers delegates to the independently-tested pure module", () => {
    const fnIdx = code.indexOf("async function claimResidualIdentifiers(");
    expect(fnIdx).toBeGreaterThan(-1);
    const body = code.slice(fnIdx, fnIdx + 900);
    expect(body).toMatch(/await claimResidualIdentifiersPure\(/);
  });

  it("the pure module is imported from scripts/lib, not reimplemented inline", () => {
    expect(code).toMatch(
      /import \{ claimResidualIdentifiers as claimResidualIdentifiersPure \} from "\.\/lib\/backfillResidualIdentifierClaim\.mjs";/
    );
  });

  it("uncovered residual axes increment the correct gate counters (fileHashUncovered / strongIdUncovered)", () => {
    const fnIdx = code.indexOf("async function claimResidualIdentifiers(");
    const body = code.slice(fnIdx, fnIdx + 1800);
    expect(body).toMatch(/coverageCounters\(field\)\.uncovered/);
  });

  it("a residual claim failure is recorded as a failure - never silently swallowed", () => {
    const fnIdx = code.indexOf("async function claimResidualIdentifiers(");
    const body = code.slice(fnIdx, fnIdx + 1800);
    expect(body).toMatch(/stats\.failures\.push\(/);
    expect(body).toMatch(/stage: "residual identifier claim"/);
  });
});

describe("P2: stale unknown cleanup after a collision is durably written, on every collision path", () => {
  it("registry.kind === collision defers unknown cleanup until after finalizeCollisionRegistry", () => {
    const idx = code.indexOf('if (registry?.kind === "collision") {');
    expect(idx).toBeGreaterThan(-1);
    // Scope tightly to THIS block's own "continue;" - a wider fixed window
    // bleeds into the next site's identical push call a few lines later and
    // would falsely pass even if this block's own push were deleted. The
    // bound was widened in C05 and again in C06 as this block grew (residual
    // axes, then required alias coverage); it stays bounded to THIS block's
    // own continue, never a fixed slice, which is what prevents the bleed.
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    expect(blockEndIdx - idx).toBeLessThan(900);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/pendingUnknownClearsAfterCollision\.push/);
    // Must NOT call clearStaleUnknownRow directly here - the write hasn't
    // happened yet at this point in the run.
    expect(body).not.toMatch(/await clearStaleUnknownRow/);
  });

  it("the in-run tracker.check collision path also defers cleanup the same way", () => {
    const idx = code.indexOf("const collidingKinds = tracker.check(ids, current);");
    expect(idx).toBeGreaterThan(-1);
    // Widened in C05 and again in C06 as this block grew (residual axes,
    // then required alias coverage) - still bounded to THIS block's own
    // "continue;", not a fixed width, so it cannot bleed into a neighboring
    // site's identical push call.
    const blockEndIdx = code.indexOf("continue;", idx);
    expect(blockEndIdx).toBeGreaterThan(idx);
    expect(blockEndIdx - idx).toBeLessThan(900);
    const body = code.slice(idx, blockEndIdx);
    expect(body).toMatch(/pendingUnknownClearsAfterCollision\.push/);
    expect(body).not.toMatch(/await clearStaleUnknownRow/);
  });

  it("recordConfirmedDuplicateKeyCollisions (the shared duplicate-insert path) defers cleanup for confirmed file-axis collisions", () => {
    const idx = code.indexOf("async function recordConfirmedDuplicateKeyCollisions(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 700);
    expect(body).toMatch(/pendingUnknownClearsAfterCollision\.push/);
    expect(body).toMatch(/c\.kind === "file"/);
  });

  it("finalizeCollisionRegistry reports which members actually succeeded", () => {
    const idx = code.indexOf("async function finalizeCollisionRegistry()");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 1400);
    expect(body).toMatch(/succeeded\.add\(/);
    expect(body).toMatch(/return succeeded;/);
  });

  it("pending clears are processed only AFTER finalizeCollisionRegistry, gated on actual success", () => {
    const callIdx = code.indexOf("const succeededCollisionMembers = await finalizeCollisionRegistry();");
    expect(callIdx).toBeGreaterThan(-1);
    const nextLineIdx = code.indexOf(
      "await clearPendingUnknownRowsAfterCollisionFinalization(succeededCollisionMembers);",
      callIdx
    );
    expect(nextLineIdx).toBeGreaterThan(callIdx);
    expect(nextLineIdx - callIdx).toBeLessThan(100);
  });

  it("clearPendingUnknownRowsAfterCollisionFinalization delegates the selection decision to the independently-tested pure module", () => {
    const idx = code.indexOf("async function clearPendingUnknownRowsAfterCollisionFinalization(");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 500);
    expect(body).toMatch(/selectPendingClearsToApply\(/);
    expect(body).toMatch(/await clearStaleUnknownRow\(sourceType, sourceId\)/);
  });

  it("selectPendingClearsToApply is imported from scripts/lib, not reimplemented inline", () => {
    expect(code).toMatch(
      /import \{ selectPendingClearsToApply \} from "\.\/lib\/backfillPendingUnknownClearScheduler\.mjs";/
    );
  });
});

describe("P3: documentation no longer says paymentSlipLegacyUnknown is never consulted", () => {
  it("the durable-registry doc comment describes the bounded post-completion check", () => {
    // Raw source, NOT readCode - the claim being pinned lives in the block
    // comment itself, which readCode's comment-stripping would remove.
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), "server/services/slipLegacyCollisionService.ts"),
      "utf-8"
    );
    expect(raw).not.toMatch(/never\s+consulted by evaluateSlipConflict/);
    expect(raw).toMatch(/IPE-004-C03/);
    expect(raw).toMatch(/findAnyLegacyFileIdentityUnknown/);
  });

  it("the runbook no longer claims the table is never consulted", () => {
    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), "RUNBOOK_legacy_slip_backfill.md"),
      "utf-8"
    );
    expect(runbook).not.toMatch(/never consulted by that path/);
    expect(runbook).toMatch(/IPE-004-C03/);
  });

  it("the backfill's own mark-complete console message no longer claims the table is never consulted", () => {
    expect(code).not.toMatch(/are never\s*\\n\s*"\s*\+\s*"\s*consulted to block or approve/);
  });
});
