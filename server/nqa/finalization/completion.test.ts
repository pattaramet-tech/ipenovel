import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../core";
import { rollbackActivatedFixture } from "../rollout/testSupport";
import { evaluateNqaProductionSoak } from "../soak/gate";
import { evaluateNqaRolloutCompletion } from "./completion";
import { buildCompletedGraduatedRolloutFixture } from "./testSupport";

describe("NQA M20 graduated rollout completion gate", () => {
  it("marks a healthy ordered multi-cycle rollout ready for candidate finalization review", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();

    expect(fixture.completionGate).toMatchObject({
      decision: "READY_FOR_CANDIDATE_FINALIZATION_REVIEW",
      failureReasons: [],
      metrics: {
        expansionCycles: 2,
        passingExpansionSoaks: 2,
        terminalTargetCount: 3,
        universeTargetCount: 3,
        terminalCoverage: 1,
      },
    });
    expect(fixture.completionGate.finalSoakGate).toEqual(
      fixture.finalSoak.gate
    );
  });

  it("holds when terminal coverage has not reached the explicit rollout universe", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const gate = evaluateNqaRolloutCompletion({
      registryState: fixture.registryState,
      initialScope: fixture.initialScope,
      expansionState: fixture.expansionState,
      expansionEvents: fixture.expansionEvents,
      finalSoakGate: fixture.finalSoak.gate,
      rolloutUniverse: [
        ...fixture.finalScope.targets,
        { row: 5, chapter: 200 },
      ],
      criteria: {
        minExpansionCycles: 2,
        minTerminalTargets: 3,
        minTerminalCoverage: 1,
      },
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.metrics.terminalCoverage).toBe(0.75);
    expect(gate.failureReasons).toContain("TERMINAL_COVERAGE_INSUFFICIENT");
  });

  it("holds when expansion history is supplied out of order", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const gate = evaluateNqaRolloutCompletion({
      registryState: fixture.registryState,
      initialScope: fixture.initialScope,
      expansionState: fixture.expansionState,
      expansionEvents: [...fixture.expansionEvents].reverse(),
      finalSoakGate: fixture.finalSoak.gate,
      rolloutUniverse: fixture.finalScope.targets,
      criteria: {
        minExpansionCycles: 2,
        minTerminalTargets: 3,
        minTerminalCoverage: 1,
      },
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("EXPANSION_HISTORY_MISMATCH");
  });

  it("holds when the terminal scope has not passed its own final soak", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const holdFinalSoak = evaluateNqaProductionSoak({
      state: fixture.registryState,
      scope: fixture.finalScope,
      monitoringRecords: fixture.finalSoak.records,
      operationalSamples: fixture.finalSoak.samples,
      windowStart: "2026-09-25T00:20:00+07:00",
      windowEnd: "2026-09-25T01:20:00+07:00",
      criteria: {
        minWindowMinutes: 60,
        minOperationalSamples: 100,
        minSuccessfulSamples: 3,
        minTargetCoverage: 1,
        maxErrorRate: 0,
        maxP95LatencyMs: 500,
        requireZeroReviewRequired: true,
        requireZeroBlockExpansion: true,
      },
    });

    const gate = evaluateNqaRolloutCompletion({
      registryState: fixture.registryState,
      initialScope: fixture.initialScope,
      expansionState: fixture.expansionState,
      expansionEvents: fixture.expansionEvents,
      finalSoakGate: holdFinalSoak,
      rolloutUniverse: fixture.finalScope.targets,
      criteria: {
        minExpansionCycles: 2,
        minTerminalTargets: 3,
        minTerminalCoverage: 1,
      },
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toContain("FINAL_SOAK_NOT_READY");
  });

  it("rejects a rehashed completion artifact whose nested expansion state was tampered", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const tamperedState = {
      ...fixture.completionGate.currentExpansionState,
      revision: fixture.completionGate.currentExpansionState.revision + 1,
    };
    const { artifactFingerprint: _ignored, ...withoutArtifactFingerprint } =
      fixture.completionGate;
    const forgedPayload = {
      ...withoutArtifactFingerprint,
      currentExpansionState: tamperedState,
    };
    const forged = {
      ...forgedPayload,
      artifactFingerprint: hashCanonicalJson({
        scope: "nqa:rollout-completion-gate:v1",
        ...forgedPayload,
      }),
    };

    const { verifyNqaRolloutCompletionGate } = await import("./completion");
    expect(() => verifyNqaRolloutCompletionGate(forged)).toThrow(
      "scope expansion state fingerprint mismatch"
    );
  });

  it("holds if M17 rolls back before rollout completion is evaluated", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    await rollbackActivatedFixture({
      store: fixture.activationStore,
      transactionId: fixture.initial.activation.transactionId,
    });
    const rolledBackState = await fixture.activationStore.readState();

    const gate = evaluateNqaRolloutCompletion({
      registryState: rolledBackState,
      initialScope: fixture.initialScope,
      expansionState: fixture.expansionState,
      expansionEvents: fixture.expansionEvents,
      finalSoakGate: fixture.finalSoak.gate,
      rolloutUniverse: fixture.finalScope.targets,
      criteria: {
        minExpansionCycles: 2,
        minTerminalTargets: 3,
        minTerminalCoverage: 1,
      },
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.failureReasons).toEqual(
      expect.arrayContaining(["REGISTRY_MISMATCH", "FINAL_SCOPE_MISMATCH"])
    );
  });
});
