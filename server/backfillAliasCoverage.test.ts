/**
 * IPE-004-C06 P1: decideAliasCoverage - the required advisory alias must be
 * durably indexed for a legacy_uppercase row in EVERY strong bucket,
 * including the two that previously escaped it (unknown-only, collision).
 */
import { describe, expect, it } from "vitest";
import { decideAliasCoverage } from "../scripts/lib/backfillAliasCoverage.mjs";

const ALIAS_A = "a".repeat(64);
const ALIAS_B = "b".repeat(64);

describe("decideAliasCoverage", () => {
  it("no expectedAlias (casing was recoverable) -> nothing required, never invents coverage", () => {
    expect(decideAliasCoverage(undefined, [])).toEqual({ action: "none" });
    expect(decideAliasCoverage(undefined, [{ id: 1, legacyReferenceUpperHash: null }])).toEqual({
      action: "none",
    });
  });

  it("UNKNOWN-ONLY: legacy_uppercase row owning no claim at all -> insert an alias-only row", () => {
    // The exact gap: no strong identifier, no recoverable file bytes, so no
    // claim row exists and none can be created from exact identifiers. The
    // alias is still required coverage.
    expect(decideAliasCoverage(ALIAS_A, [])).toEqual({ action: "insert_alias_only" });
  });

  it("COLLISION: a same-source claim exists with an empty alias slot -> enrich it in place, no second row", () => {
    const claims = [{ id: 7, legacyReferenceUpperHash: null }];
    expect(decideAliasCoverage(ALIAS_A, claims)).toEqual({ action: "enrich", claimId: 7 });
  });

  it("an undefined alias slot is treated the same as null", () => {
    const claims = [{ id: 8 }];
    expect(decideAliasCoverage(ALIAS_A, claims as any)).toEqual({ action: "enrich", claimId: 8 });
  });

  it("IDEMPOTENT RERUN: the alias is already present -> already covered, no write, no churn", () => {
    const claims = [{ id: 9, legacyReferenceUpperHash: ALIAS_A }];
    expect(decideAliasCoverage(ALIAS_A, claims)).toEqual({
      action: "already_covered",
      claimId: 9,
    });
  });

  it("SPLIT CLAIM ROWS: coverage on ANY same-source row counts - never a redundant second write", () => {
    // C04/C05 residual claims mean one source can own several rows. The
    // alias living on a different one of them is still coverage.
    const claims = [
      { id: 10, legacyReferenceUpperHash: null },
      { id: 11, legacyReferenceUpperHash: ALIAS_A },
    ];
    expect(decideAliasCoverage(ALIAS_A, claims)).toEqual({
      action: "already_covered",
      claimId: 11,
    });
  });

  it("SPLIT CLAIM ROWS: with no coverage anywhere, the empty slot is enriched rather than adding a row", () => {
    const claims = [
      { id: 12, legacyReferenceUpperHash: ALIAS_B },
      { id: 13, legacyReferenceUpperHash: null },
    ];
    expect(decideAliasCoverage(ALIAS_A, claims)).toEqual({ action: "enrich", claimId: 13 });
  });

  it("every same-source claim holds a DIFFERENT alias -> inconsistent, never overwritten", () => {
    // Overwriting could erase coverage for a fold that claim is currently
    // protecting. The tool never guesses; an operator adjudicates and
    // completion stays refused.
    const claims = [{ id: 14, legacyReferenceUpperHash: ALIAS_B }];
    expect(decideAliasCoverage(ALIAS_A, claims)).toEqual({
      action: "inconsistent",
      claimId: 14,
      existing: ALIAS_B,
    });
  });

  it("a null/undefined claims list is handled as no claims, not a crash", () => {
    expect(decideAliasCoverage(ALIAS_A, undefined as any)).toEqual({ action: "insert_alias_only" });
  });
});
