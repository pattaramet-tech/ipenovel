import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { finalizeNqaCandidateBaseline } from "./transaction";
import {
  InMemoryNqaBaselineLineageStore,
  JsonFileNqaBaselineLineageStore,
  type NqaBaselineLineageStore,
} from "./store";
import {
  createNqaFinalizedBaselineAlignmentPolicyResolver,
  createNqaNextCycleInMemoryActivationStore,
  createNqaNextCycleJsonActivationStore,
  resolveNqaFinalizedBaselineRuntime,
} from "./runtime";
import { buildCompletedGraduatedRolloutFixture } from "./testSupport";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

async function finalizeFixture(lineageStore?: NqaBaselineLineageStore) {
  const fixture = await buildCompletedGraduatedRolloutFixture();
  const store = lineageStore ?? fixture.lineageStore;
  const event = await finalizeNqaCandidateBaseline({
    activationStore: fixture.activationStore,
    expansionStore: fixture.expansionStore,
    lineageStore: store,
    transactionId: "m21-finalize-runtime",
    completionGate: fixture.completionGate,
    authorization: fixture.finalizationAuthorization,
    committedAt: "2026-09-25T01:26:00+07:00",
  });
  return { fixture, store, event };
}

describe("NQA M21 finalized baseline runtime adoption", () => {
  it("resolves the exact finalized M20 candidate as the next runtime baseline with provenance", async () => {
    const { fixture, store, event } = await finalizeFixture();

    const resolution = await resolveNqaFinalizedBaselineRuntime({
      lineageStore: store,
    });

    expect(resolution).toMatchObject({
      source: "M20_FINALIZED_BASELINE_LINEAGE",
      lineageRevision: 1,
      baselinePolicyVersion: fixture.registryState.activePolicyVersion,
      baselinePolicyFingerprint: fixture.registryState.activePolicyFingerprint,
      predecessorBaselinePolicyFingerprint:
        fixture.registryState.rollbackTarget!.policyFingerprint,
      sourceFinalizationTransactionId: event.transactionId,
      sourceFinalizationEventFingerprint: event.eventFingerprint,
      sourceCompletionArtifactFingerprint:
        fixture.completionGate.artifactFingerprint,
    });
    expect(resolution.baselinePolicy).toEqual(
      fixture.registryState.activePolicy
    );
    expect(resolution.provenanceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("provides the finalized lineage policy through the semantic alignment resolver adapter", async () => {
    const { fixture, store } = await finalizeFixture();
    const resolver = createNqaFinalizedBaselineAlignmentPolicyResolver({
      lineageStore: store,
    });

    await expect(resolver()).resolves.toEqual(
      fixture.registryState.activePolicy
    );
  });

  it("seeds the next M17 cycle genesis from the finalized M20 baseline without changing the previous M17 registry", async () => {
    const { fixture, store } = await finalizeFixture();
    const previousRegistry = await fixture.activationStore.readState();

    const nextCycle = await createNqaNextCycleInMemoryActivationStore({
      lineageStore: store,
    });
    const nextState = await nextCycle.store.readState();

    expect(nextState).toMatchObject({
      revision: 0,
      activePolicyVersion: fixture.registryState.activePolicyVersion,
      activePolicyFingerprint: fixture.registryState.activePolicyFingerprint,
      rollbackTarget: null,
      lastTransactionId: null,
    });
    expect(nextState.activePolicy).toEqual(fixture.registryState.activePolicy);
    expect(await fixture.activationStore.readState()).toEqual(previousRegistry);
  });

  it("reopens the next-cycle durable M17 genesis with the same finalized baseline", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "nqa-m21-next-cycle-")
    );
    cleanup.push(root);
    const { fixture, store } = await finalizeFixture();

    const first = await createNqaNextCycleJsonActivationStore({
      lineageStore: store,
      rootDir: root,
    });
    const beforeRestart = await first.store.readState();

    const reopened = await createNqaNextCycleJsonActivationStore({
      lineageStore: store,
      rootDir: root,
    });
    const afterRestart = await reopened.store.readState();

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.activePolicy).toEqual(
      fixture.registryState.activePolicy
    );
  });

  it("fails closed when lineage contains only genesis and has never been finalized", async () => {
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const store = new InMemoryNqaBaselineLineageStore(
      fixture.registryState.rollbackTarget!.policy
    );

    await expect(
      resolveNqaFinalizedBaselineRuntime({ lineageStore: store })
    ).rejects.toThrow("requires completed M20 baseline lineage");
  });

  it("fails closed when the latest finalized lineage cannot resolve its source finalization event", async () => {
    const { store } = await finalizeFixture();
    const state = await store.readState();
    const missingEventStore: NqaBaselineLineageStore = {
      readState: async () => state,
      getEvent: async () => null,
      listEvents: async () => [],
      compareAndAppend: async () => "CONFLICT",
    };

    await expect(
      resolveNqaFinalizedBaselineRuntime({
        lineageStore: missingEventStore,
      })
    ).rejects.toThrow("cannot resolve the source M20 finalization event");
  });

  it("rejects a tampered finalization event even if the lineage state itself is valid", async () => {
    const { store, event } = await finalizeFixture();
    const state = await store.readState();
    const tampered = {
      ...event,
      committedAt: "2026-09-25T01:27:00+07:00",
    };
    const tamperedStore: NqaBaselineLineageStore = {
      readState: async () => state,
      getEvent: async () => tampered,
      listEvents: async () => [tampered],
      compareAndAppend: async () => "CONFLICT",
    };

    await expect(
      resolveNqaFinalizedBaselineRuntime({
        lineageStore: tamperedStore,
      })
    ).rejects.toThrow("finalization event fingerprint mismatch");
  });

  it("replays the same baseline and provenance after durable store restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m21-runtime-"));
    cleanup.push(root);
    const fixture = await buildCompletedGraduatedRolloutFixture();
    const predecessor = fixture.registryState.rollbackTarget!.policy;
    const durable = new JsonFileNqaBaselineLineageStore(root, predecessor);

    await finalizeNqaCandidateBaseline({
      activationStore: fixture.activationStore,
      expansionStore: fixture.expansionStore,
      lineageStore: durable,
      transactionId: "m21-finalize-durable",
      completionGate: fixture.completionGate,
      authorization: fixture.finalizationAuthorization,
      committedAt: "2026-09-25T01:26:00+07:00",
    });

    const beforeRestart = await resolveNqaFinalizedBaselineRuntime({
      lineageStore: durable,
    });
    const reopened = new JsonFileNqaBaselineLineageStore(root, predecessor);
    const afterRestart = await resolveNqaFinalizedBaselineRuntime({
      lineageStore: reopened,
    });

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.baselinePolicy).toEqual(
      fixture.registryState.activePolicy
    );
  });
});
