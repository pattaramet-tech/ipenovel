import { describe, expect, it } from "vitest";
import {
  evaluateEditorialCheckerState,
  getEditorialCheckerStaleReason,
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
} from "./editorialForeignChecker.domain";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    hasRun: true,
    isRunning: false,
    errorReason: null,
    staleReason: null as
      | null
      | "DRAFT_CHANGED"
      | "ENGINE_CHANGED"
      | "ALLOW_LIST_CHANGED",
    unresolvedCount: 0,
    blockingAnomalyCount: 0,
    ...overrides,
  };
}

describe("IPE-058-E canonical checker state machine", () => {
  it("NOT_RUN when no run exists; RUNNING while in flight", () => {
    expect(
      evaluateEditorialCheckerState(baseInput({ hasRun: false }))
    ).toEqual({ state: "NOT_RUN", isCurrent: false, qcReady: false });
    expect(
      evaluateEditorialCheckerState(
        baseInput({ hasRun: false, isRunning: true })
      )
    ).toEqual({ state: "RUNNING", isCurrent: false, qcReady: false });
  });

  it("STALE even when open=0 — never current, never ready", () => {
    // The IPE-058-A invariant: stale evidence with open=0 must NOT look ready.
    const result = evaluateEditorialCheckerState(
      baseInput({ staleReason: "DRAFT_CHANGED", unresolvedCount: 0 })
    );
    expect(result.state).toBe("STALE");
    expect(result.isCurrent).toBe(false);
    expect(result.qcReady).toBe(false);
    for (const reason of [
      "DRAFT_CHANGED",
      "ENGINE_CHANGED",
      "ALLOW_LIST_CHANGED",
    ] as const) {
      expect(
        evaluateEditorialCheckerState(baseInput({ staleReason: reason })).state
      ).toBe("STALE");
    }
  });

  it("ERROR on checker error — never ready regardless of counts", () => {
    const result = evaluateEditorialCheckerState(
      baseInput({ errorReason: "TRANSFORM_FAILED" })
    );
    expect(result.state).toBe("ERROR");
    expect(result.qcReady).toBe(false);
    expect(
      evaluateEditorialCheckerState(baseInput({ errorReason: "boom" })).state
    ).toBe("ERROR");
  });

  it("CURRENT_HAS_FINDINGS when unresolved blocking issues exist on current evidence", () => {
    expect(
      evaluateEditorialCheckerState(baseInput({ unresolvedCount: 3 }))
    ).toEqual({
      state: "CURRENT_HAS_FINDINGS",
      isCurrent: true,
      qcReady: false,
    });
    expect(
      evaluateEditorialCheckerState(baseInput({ blockingAnomalyCount: 1 }))
        .state
    ).toBe("CURRENT_HAS_FINDINGS");
  });

  it("CURRENT_READY only with current evidence and zero blocking issues", () => {
    expect(evaluateEditorialCheckerState(baseInput())).toEqual({
      state: "CURRENT_READY",
      isCurrent: true,
      qcReady: true,
    });
  });

  it("stale reason is draft/engine/allowlist binding only — never counts or timestamps", () => {
    const base = {
      currentDraftId: 42,
      runDraftId: 42,
      runEngineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      currentEngineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      runAllowListSha256: "a".repeat(64),
      currentAllowListSha256: "a".repeat(64),
    };
    expect(getEditorialCheckerStaleReason(base)).toBeNull();
    expect(
      getEditorialCheckerStaleReason({ ...base, currentDraftId: 43 })
    ).toBe("DRAFT_CHANGED");
    expect(
      getEditorialCheckerStaleReason({
        ...base,
        currentEngineVersion: "next",
      })
    ).toBe("ENGINE_CHANGED");
    expect(
      getEditorialCheckerStaleReason({
        ...base,
        currentAllowListSha256: "b".repeat(64),
      })
    ).toBe("ALLOW_LIST_CHANGED");
  });
});
