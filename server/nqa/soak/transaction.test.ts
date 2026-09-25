import { describe, expect, it } from "vitest";

import { rollbackActivatedFixture } from "../rollout/testSupport";
import { evaluateNqaProductionSoak } from "./gate";
import { buildNqaScopeExpansionAuthorization } from "./integrity";
import { InMemoryNqaScopeExpansionStore } from "./store";
import { expandNqaControlledRolloutScope } from "./transaction";
import { buildHealthySoakFixture, TEST_SOAK_CRITERIA } from "./testSupport";

describe("NQA M19 explicit scope expansion transaction", () => {
  it("expands only through a fresh human-authorized monotonic transaction", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const expansionStore = new InMemoryNqaScopeExpansionStore(activation.scope);
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-expand-approval-001",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-scope-expanded-001",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });

    const event = await expandNqaControlledRolloutScope({
      activationStore: activation.store,
      expansionStore,
      transactionId: "m19-expand-001",
      sourceSoakGate: gate,
      authorization,
      proposedTargets,
      committedAt: "2026-09-24T23:06:00+07:00",
    });

    expect(event.addedTargets).toEqual([{ row: 4, chapter: 199 }]);
    expect(event.resultingState).toMatchObject({
      revision: 1,
      lastTransactionId: "m19-expand-001",
      currentScope: {
        scopeId: "m19-scope-expanded-001",
        targets: proposedTargets,
      },
    });

    const reused = await expandNqaControlledRolloutScope({
      activationStore: activation.store,
      expansionStore,
      transactionId: "m19-expand-001",
      sourceSoakGate: gate,
      authorization,
      proposedTargets,
      committedAt: "2026-09-24T23:06:00+07:00",
    });
    expect(reused.eventFingerprint).toBe(event.eventFingerprint);
  });

  it("rejects target removal even with a correctly fingerprinted new authorization", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const expansionStore = new InMemoryNqaScopeExpansionStore(activation.scope);
    const proposedTargets = [activation.scope.targets[0]];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-remove-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-invalid-removal",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore,
        transactionId: "m19-remove",
        sourceSoakGate: gate,
        authorization,
        proposedTargets,
        committedAt: "2026-09-24T23:06:00+07:00",
      })
    ).rejects.toThrow("cannot remove existing targets");
  });

  it("rejects an unhealthy soak even when a human authorization exists", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();
    const holdGate = evaluateNqaProductionSoak({
      state,
      scope: activation.scope,
      monitoringRecords: records,
      operationalSamples: samples,
      windowStart: "2026-09-24T22:00:00+07:00",
      windowEnd: "2026-09-24T23:00:00+07:00",
      criteria: {
        ...TEST_SOAK_CRITERIA,
        minOperationalSamples: 100,
      },
    });
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: holdGate,
      authorizationId: "m19-hold-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-hold-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore: new InMemoryNqaScopeExpansionStore(activation.scope),
        transactionId: "m19-hold",
        sourceSoakGate: holdGate,
        authorization,
        proposedTargets,
        committedAt: "2026-09-24T23:06:00+07:00",
      })
    ).rejects.toThrow("passing production soak gate");
  });

  it("fails closed if M17 has rolled back after the soak evidence was produced", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-stale-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-stale-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });
    await rollbackActivatedFixture({
      store: activation.store,
      transactionId: activation.transactionId,
    });

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore: new InMemoryNqaScopeExpansionStore(activation.scope),
        transactionId: "m19-stale",
        sourceSoakGate: gate,
        authorization,
        proposedTargets,
        committedAt: "2026-09-24T23:06:00+07:00",
      })
    ).rejects.toThrow("stale or incompatible");
  });

  it("rejects expansion beyond the M18 100-target hard bound", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const proposedTargets = Array.from({ length: 101 }, (_, index) => ({
      row: index + 1,
      chapter: 197,
    }));
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-too-large-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-too-large-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore: new InMemoryNqaScopeExpansionStore(activation.scope),
        transactionId: "m19-too-large",
        sourceSoakGate: gate,
        authorization,
        proposedTargets,
        committedAt: "2026-09-24T23:06:00+07:00",
      })
    ).rejects.toThrow();
  });

  it("rejects tampered human authorization before expansion", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-tampered-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-tampered-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:15:00+07:00",
    });
    const tampered = {
      ...authorization,
      proposedScopeId: "m19-tampered-different",
    };

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore: new InMemoryNqaScopeExpansionStore(activation.scope),
        transactionId: "m19-tampered",
        sourceSoakGate: gate,
        authorization: tampered,
        proposedTargets,
        committedAt: "2026-09-24T23:06:00+07:00",
      })
    ).rejects.toThrow("authorization fingerprint mismatch");
  });

  it("rejects an authorization outside its explicit validity window", async () => {
    const { activation, state, gate } = await buildHealthySoakFixture();
    const proposedTargets = [
      ...activation.scope.targets,
      { row: 4, chapter: 199 },
    ];
    const authorization = buildNqaScopeExpansionAuthorization({
      state,
      sourceScope: activation.scope,
      soakGate: gate,
      authorizationId: "m19-expired-approval",
      authorizerId: "human-rollout-operator",
      proposedScopeId: "m19-expired-scope",
      proposedTargets,
      approvedAt: "2026-09-24T23:05:00+07:00",
      validUntil: "2026-09-24T23:06:00+07:00",
    });

    await expect(
      expandNqaControlledRolloutScope({
        activationStore: activation.store,
        expansionStore: new InMemoryNqaScopeExpansionStore(activation.scope),
        transactionId: "m19-expired",
        sourceSoakGate: gate,
        authorization,
        proposedTargets,
        committedAt: "2026-09-24T23:07:00+07:00",
      })
    ).rejects.toThrow("outside its validity window");
  });
});
