import { describe, expect, it } from "vitest";

import { rollbackActivatedFixture } from "../rollout/testSupport";
import { buildNqaCandidateFinalizationAuthorization } from "./integrity";
import { InMemoryNqaBaselineLineageStore } from "./store";
import { finalizeNqaCandidateBaseline } from "./transaction";
import { buildCompletedGraduatedRolloutFixture } from "./testSupport";

describe("NQA M20 explicit candidate finalization transaction", () => {
  it("finalizes the candidate as the next baseline while preserving the predecessor and M17 rollback state", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const registryBefore = await fixture.activationStore.readState();

    const event = await finalizeNqaCandidateBaseline({
      activationStore: fixture.activationStore,
      expansionStore: fixture.expansionStore,
      lineageStore: fixture.lineageStore,
      transactionId: "m20-finalize-001",
      completionGate: fixture.completionGate,
      authorization: fixture.finalizationAuthorization,
      committedAt: "2026-09-25T01:26:00+07:00",
    });

    expect(event.resultingLineageState).toMatchObject({
      revision: 1,
      baselinePolicyVersion: registryBefore.activePolicyVersion,
      baselinePolicyFingerprint: registryBefore.activePolicyFingerprint,
      predecessorBaselinePolicyVersion:
        registryBefore.rollbackTarget!.policyVersion,
      predecessorBaselinePolicyFingerprint:
        registryBefore.rollbackTarget!.policyFingerprint,
      sourceFinalizationTransactionId: "m20-finalize-001",
      sourceCompletionArtifactFingerprint:
        fixture.completionGate.artifactFingerprint,
    });
    expect(event.resultingLineageState.baselinePolicy).toEqual(
      registryBefore.activePolicy
    );
    expect(event.resultingLineageState.predecessorBaselinePolicy).toEqual(
      registryBefore.rollbackTarget!.policy
    );
    expect(event.sourceExpansionEvents).toEqual(fixture.expansionEvents);
    expect(event.sourceCompletionGate.finalSoakGate).toEqual(
      fixture.finalSoak.gate
    );

    const registryAfter = await fixture.activationStore.readState();
    expect(registryAfter).toEqual(registryBefore);
    expect(registryAfter.rollbackTarget).not.toBeNull();
  });

  it("is idempotent for the exact same finalization intent", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const input = {
      activationStore: fixture.activationStore,
      expansionStore: fixture.expansionStore,
      lineageStore: fixture.lineageStore,
      transactionId: "m20-finalize-idempotent",
      completionGate: fixture.completionGate,
      authorization: fixture.finalizationAuthorization,
      committedAt: "2026-09-25T01:26:00+07:00",
    } as const;

    const first = await finalizeNqaCandidateBaseline(input);
    const second = await finalizeNqaCandidateBaseline(input);
    expect(second).toEqual(first);
    expect(await fixture.lineageStore.listEvents()).toHaveLength(1);
  });

  it("rejects a HOLD completion gate even with a human authorization", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const holdGate = {
      ...fixture.completionGate,
      decision: "HOLD" as const,
      failureReasons: ["INSUFFICIENT_EXPANSION_CYCLES" as const],
    };

    await expect(
      finalizeNqaCandidateBaseline({
        activationStore: fixture.activationStore,
        expansionStore: fixture.expansionStore,
        lineageStore: fixture.lineageStore,
        transactionId: "m20-finalize-hold",
        completionGate: holdGate,
        authorization: fixture.finalizationAuthorization,
        committedAt: "2026-09-25T01:26:00+07:00",
      })
    ).rejects.toThrow();
  });

  it("fails closed if M17 is rolled back after completion evidence and authorization were created", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    await rollbackActivatedFixture({
      store: fixture.activationStore,
      transactionId: fixture.initial.activation.transactionId,
    });

    await expect(
      finalizeNqaCandidateBaseline({
        activationStore: fixture.activationStore,
        expansionStore: fixture.expansionStore,
        lineageStore: fixture.lineageStore,
        transactionId: "m20-finalize-stale",
        completionGate: fixture.completionGate,
        authorization: fixture.finalizationAuthorization,
        committedAt: "2026-09-25T01:26:00+07:00",
      })
    ).rejects.toThrow();
  });

  it("rejects expired and tampered human authorization", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const expired = buildNqaCandidateFinalizationAuthorization({
      registryState: fixture.registryState,
      expansionState: fixture.expansionState,
      completionGate: fixture.completionGate,
      authorizationId: "m20-expired-auth",
      authorizerId: "human-finalization-operator",
      approvedAt: "2026-09-25T01:00:00+07:00",
      validUntil: "2026-09-25T01:05:00+07:00",
    });

    await expect(
      finalizeNqaCandidateBaseline({
        activationStore: fixture.activationStore,
        expansionStore: fixture.expansionStore,
        lineageStore: fixture.lineageStore,
        transactionId: "m20-finalize-expired",
        completionGate: fixture.completionGate,
        authorization: expired,
        committedAt: "2026-09-25T01:26:00+07:00",
      })
    ).rejects.toThrow("outside its validity window");

    const tampered = {
      ...fixture.finalizationAuthorization,
      authorizerId: "another-human",
    };
    await expect(
      finalizeNqaCandidateBaseline({
        activationStore: fixture.activationStore,
        expansionStore: fixture.expansionStore,
        lineageStore: fixture.lineageStore,
        transactionId: "m20-finalize-tampered",
        completionGate: fixture.completionGate,
        authorization: tampered,
        committedAt: "2026-09-25T01:26:00+07:00",
      })
    ).rejects.toThrow("authorization fingerprint mismatch");
  });

  it("rejects a lineage store initialized from the wrong predecessor baseline", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const wrongLineage = new InMemoryNqaBaselineLineageStore({
      ...fixture.registryState.rollbackTarget!.policy,
      minPassMeanScore:
        fixture.registryState.rollbackTarget!.policy.minPassMeanScore + 0.01,
    });

    await expect(
      finalizeNqaCandidateBaseline({
        activationStore: fixture.activationStore,
        expansionStore: fixture.expansionStore,
        lineageStore: wrongLineage,
        transactionId: "m20-finalize-wrong-lineage",
        completionGate: fixture.completionGate,
        authorization: fixture.finalizationAuthorization,
        committedAt: "2026-09-25T01:26:00+07:00",
      })
    ).rejects.toThrow("lineage.predecessorBaseline");
  });
});
