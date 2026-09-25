import { describe, expect, it } from "vitest";
import { buildPublishFinalGatePackage } from "./publishFinalGate.domain";

describe("workspace publish final gate domain", () => {
  const base = {
    workspaceId: 1,
    workspaceNovelId: 2,
    publishRunId: 3,
    readinessDigest: "a".repeat(64),
    ownership: { owner: "sheets" as const, cutoverEpoch: 0 as const, version: 7 },
    transitionIds: [] as number[],
    inheritedBlockers: [] as string[],
  };

  it("builds a deterministic gate-ready package and explicit operator command", () => {
    const first = buildPublishFinalGatePackage(base);
    const second = buildPublishFinalGatePackage({ ...base, transitionIds: [] });
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.gateReady).toBe(true);
    expect(first.operatorCutoverEligible).toBe(true);
    expect(first.blockers).toEqual([]);
    expect(first.cutoverCommand).toEqual({ expectedOwner: "sheets", expectedCutoverEpoch: 0, expectedVersion: 7, automatic: false });
    expect(first.sideEffects).toEqual({ providerDeliveryApplied: false, registryMutationApplied: false });
  });

  it("fails closed when transition history exists", () => {
    const result = buildPublishFinalGatePackage({ ...base, transitionIds: [9, 4] });
    expect(result.gateReady).toBe(false);
    expect(result.operatorCutoverEligible).toBe(false);
    expect(result.blockers).toEqual(["TRANSITION_HISTORY_PRESENT"]);
    expect(result.transitionIds).toEqual([4, 9]);
  });

  it("folds inherited readiness blockers into the final gate digest", () => {
    const first = buildPublishFinalGatePackage({ ...base, inheritedBlockers: ["STALE_LAST_PUBLISHED_HASH", "CHECKER_NOT_PASSED"] });
    const second = buildPublishFinalGatePackage({ ...base, inheritedBlockers: ["CHECKER_NOT_PASSED", "STALE_LAST_PUBLISHED_HASH"] });
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.blockers).toEqual(["CUTOVER_READINESS_BLOCKED"]);
    expect(first.gateReady).toBe(false);
  });
});
