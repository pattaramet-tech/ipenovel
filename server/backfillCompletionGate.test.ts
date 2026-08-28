import { describe, expect, it } from "vitest";
import { evaluateBackfillCompletion } from "../scripts/lib/backfillCompletionGate.mjs";

/**
 * IPE-004: the production incident this gate fixes.
 *
 * A dry-run backfill against real data found 915 historical rows that can
 * NEVER be resolved (no_slip_image_url - the bytes are permanently gone) and
 * 114 genuine strong-identifier collisions among historical rows. The OLD
 * gate required BOTH to be zero before `--mark-complete` could ever succeed -
 * which, for this exact corpus, is impossible no matter how many times the
 * backfill re-runs. That is what left the O(N) historical scan enabled
 * forever and caused unrelated new approvals to fail closed.
 */

function baseStats(overrides: Partial<Parameters<typeof evaluateBackfillCompletion>[0]> = {}) {
  return {
    failures: [],
    aliasUncovered: 0,
    aliasInconsistencies: [],
    fileHashUncovered: 0,
    staleClaimsUncovered: 0,
    unknownRowsFailed: 0,
    collisionMembersFailed: 0,
    ...overrides,
  };
}

const eof = { payments: true, walletTopups: true };

describe("evaluateBackfillCompletion", () => {
  it("a fully clean run with nothing to classify is complete", () => {
    const gate = evaluateBackfillCompletion(baseStats(), eof);
    expect(gate.cleanRun).toBe(true);
  });

  it("915 permanently-unresolved rows do NOT block completion once durably classified (unknownRowsFailed=0)", () => {
    // The production shape: unresolvedRows.length === 915, but every one of
    // them was successfully written to paymentSlipLegacyUnknown, so
    // unknownRowsFailed stays 0.
    const gate = evaluateBackfillCompletion(baseStats({ unknownRowsFailed: 0 }), eof);
    expect(gate.cleanRun).toBe(true);
    expect(gate.unknownRowsClassified).toBe(true);
  });

  it("114 collisions do NOT block completion once every member is durably recorded (collisionMembersFailed=0)", () => {
    const gate = evaluateBackfillCompletion(baseStats({ collisionMembersFailed: 0 }), eof);
    expect(gate.cleanRun).toBe(true);
    expect(gate.collisionsClassified).toBe(true);
  });

  it("a FAILED durable write for an unknown row DOES block completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ unknownRowsFailed: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
    expect(gate.unknownRowsClassified).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/unknownRowsFailed=1/);
  });

  it("IPE-004 P1: a TRANSIENT unknown (file_hash_recovery_failed) DOES block completion", () => {
    // A single failed signed-URL / storage / network / timeout / oversize
    // recovery must never retire the safety scan with recoverable history
    // unprotected. unknownRowsTransient counts those; nonzero => fail closed.
    const gate = evaluateBackfillCompletion(baseStats({ unknownRowsTransient: 3 }), eof);
    expect(gate.cleanRun).toBe(false);
    expect(gate.noTransientUnknown).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/unknownRowsTransient=3/);
  });

  it("a permanent-only unknown corpus (no_slip_image_url, transient count 0) still completes", () => {
    const gate = evaluateBackfillCompletion(
      baseStats({ unknownRowsFailed: 0, unknownRowsTransient: 0 }),
      eof
    );
    expect(gate.cleanRun).toBe(true);
  });

  it("IPE-004-C03: a FAILED cleanup of a resolved-but-stale unknown row blocks completion", () => {
    // A row was UNKNOWN on an earlier run and became resolvable this run
    // (fresh claim, sibling enrichment, or stale-claim migration recovering
    // its fileHash), but clearing the stale paymentSlipLegacyUnknown record
    // itself failed (delete threw, or the row was still present on re-read).
    // Completion must not claim an exact durable provenance state while a
    // resolved row still carries a contradictory "unknown" classification.
    const gate = evaluateBackfillCompletion(baseStats({ unknownCleanupFailed: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
    expect(gate.unknownCleanupSucceeded).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/unknownCleanupFailed=1/);
  });

  it("unknownCleanupFailed=0 (default) does not block completion", () => {
    const gate = evaluateBackfillCompletion(baseStats(), eof);
    expect(gate.unknownCleanupSucceeded).toBe(true);
  });

  it("IPE-004 P2: a known reference/QR sibling left unclaimed (strongIdUncovered) blocks completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ strongIdUncovered: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
    expect(gate.strongIdCoverageComplete).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/strongIdUncovered=1/);
  });

  it("a FAILED durable write for a collision member DOES block completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ collisionMembersFailed: 2 }), eof);
    expect(gate.cleanRun).toBe(false);
    expect(gate.collisionsClassified).toBe(false);
  });

  it("a processing failure still blocks completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ failures: [{ source: "x" }] }), eof);
    expect(gate.cleanRun).toBe(false);
  });

  it("an alias inconsistency still requires operator review before completion", () => {
    const gate = evaluateBackfillCompletion(
      baseStats({ aliasInconsistencies: [{ source: "x" }] }),
      eof
    );
    expect(gate.cleanRun).toBe(false);
    expect(gate.aliasCoverageComplete).toBe(false);
  });

  it("missing alias coverage still blocks completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ aliasUncovered: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
  });

  it("missing fileHash coverage still blocks completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ fileHashUncovered: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
  });

  it("an unrepaired stale claim still blocks completion", () => {
    const gate = evaluateBackfillCompletion(baseStats({ staleClaimsUncovered: 1 }), eof);
    expect(gate.cleanRun).toBe(false);
  });

  it("not reaching EOF on either source blocks completion", () => {
    expect(
      evaluateBackfillCompletion(baseStats(), { payments: false, walletTopups: true }).cleanRun
    ).toBe(false);
    expect(
      evaluateBackfillCompletion(baseStats(), { payments: true, walletTopups: false }).cleanRun
    ).toBe(false);
  });

  it("the production-shaped run (4147 scanned, 915 unknown, 114 collisions, 0 failures) is complete", () => {
    // Exactly the numbers from the incident's dry-run report, modelled as a
    // run where every unresolved row and every collision member was
    // successfully, durably recorded (failed counters at 0).
    const gate = evaluateBackfillCompletion(
      baseStats({ unknownRowsFailed: 0, collisionMembersFailed: 0 }),
      eof
    );
    expect(gate.cleanRun).toBe(true);
  });
});
