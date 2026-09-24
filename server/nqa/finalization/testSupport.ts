import { resolveNqaRuntimeAlignmentPolicy } from "../rollout/resolver";
import { buildNqaDualRunMonitoringRecord } from "../rollout/monitoring";
import { buildNqaOperationalSample } from "../soak/telemetry";
import { evaluateNqaProductionSoak } from "../soak/gate";
import { buildNqaScopeExpansionAuthorization } from "../soak/integrity";
import { InMemoryNqaScopeExpansionStore } from "../soak/store";
import { expandNqaControlledRolloutScope } from "../soak/transaction";
import {
  buildHealthySoakFixture,
  semanticFixture,
  TEST_SOAK_CRITERIA,
} from "../soak/testSupport";
import type { NqaControlledRolloutScope } from "../rollout/contracts";
import type { NqaPolicyActivationStore } from "../activation/store";
import type { NqaPolicyRegistryState } from "../activation/contracts";
import { evaluateNqaRolloutCompletion } from "./completion";
import { buildNqaCandidateFinalizationAuthorization } from "./integrity";
import { InMemoryNqaBaselineLineageStore } from "./store";

async function buildHealthySoakForScope(input: {
  activationStore: NqaPolicyActivationStore;
  registryState: NqaPolicyRegistryState;
  scope: NqaControlledRolloutScope;
  prefix: string;
  windowStart: string;
  windowEnd: string;
  observedAtBase: string;
}) {
  const records = [];
  const samples = [];
  for (let index = 0; index < input.scope.targets.length; index += 1) {
    const target = input.scope.targets[index];
    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store: input.activationStore,
      scope: input.scope,
      row: target.row,
      chapter: target.chapter,
    });
    const observedAt =
      input.observedAtBase.slice(0, 14) +
      String(20 + index).padStart(2, "0") +
      ":00+07:00";
    const record = buildNqaDualRunMonitoringRecord({
      recordId: input.prefix + "-record-" + index,
      row: target.row,
      chapter: target.chapter,
      resolution,
      baseline: semanticFixture("PASS", resolution.baselinePolicy.version),
      candidate: semanticFixture("PASS", resolution.candidatePolicy!.version),
      observedAt,
    });
    records.push(record);
    samples.push(
      buildNqaOperationalSample({
        sampleId: input.prefix + "-sample-" + index,
        scopeId: input.scope.scopeId,
        scopeFingerprint: input.scope.scopeFingerprint,
        row: target.row,
        chapter: target.chapter,
        status: "SUCCESS",
        durationMs: 100 + index * 10,
        monitoringRecordId: record.recordId,
        monitoringRecordFingerprint: record.recordFingerprint,
        observedAt,
      })
    );
  }

  const gate = evaluateNqaProductionSoak({
    state: input.registryState,
    scope: input.scope,
    monitoringRecords: records,
    operationalSamples: samples,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    criteria: {
      ...TEST_SOAK_CRITERIA,
      minOperationalSamples: input.scope.targets.length,
      minSuccessfulSamples: input.scope.targets.length,
    },
  });
  return { records, samples, gate };
}

export async function buildCompletedGraduatedRolloutFixture() {
  const initial = await buildHealthySoakFixture({
    targets: [{ row: 2, chapter: 197 }],
  });
  const activationStore = initial.activation.store;
  const registryState = initial.state;
  const initialScope = initial.activation.scope;
  const expansionStore = new InMemoryNqaScopeExpansionStore(initialScope);

  const scope2Targets = [...initialScope.targets, { row: 3, chapter: 198 }];
  const auth1 = buildNqaScopeExpansionAuthorization({
    state: registryState,
    sourceScope: initialScope,
    soakGate: initial.gate,
    authorizationId: "m20-expand-auth-1",
    authorizerId: "human-rollout-operator",
    proposedScopeId: "m20-scope-2",
    proposedTargets: scope2Targets,
    approvedAt: "2026-09-24T23:05:00+07:00",
    validUntil: "2026-09-24T23:15:00+07:00",
  });
  const event1 = await expandNqaControlledRolloutScope({
    activationStore,
    expansionStore,
    transactionId: "m20-expand-1",
    sourceSoakGate: initial.gate,
    authorization: auth1,
    proposedTargets: scope2Targets,
    committedAt: "2026-09-24T23:06:00+07:00",
  });

  const scope2 = event1.resultingState.currentScope;
  const soak2 = await buildHealthySoakForScope({
    activationStore,
    registryState,
    scope: scope2,
    prefix: "m20-soak-2",
    windowStart: "2026-09-24T23:10:00+07:00",
    windowEnd: "2026-09-25T00:10:00+07:00",
    observedAtBase: "2026-09-24T23:20:00+07:00",
  });

  const scope3Targets = [...scope2.targets, { row: 4, chapter: 199 }];
  const auth2 = buildNqaScopeExpansionAuthorization({
    state: registryState,
    sourceScope: scope2,
    soakGate: soak2.gate,
    authorizationId: "m20-expand-auth-2",
    authorizerId: "human-rollout-operator",
    proposedScopeId: "m20-scope-3",
    proposedTargets: scope3Targets,
    approvedAt: "2026-09-25T00:12:00+07:00",
    validUntil: "2026-09-25T00:22:00+07:00",
  });
  const event2 = await expandNqaControlledRolloutScope({
    activationStore,
    expansionStore,
    transactionId: "m20-expand-2",
    sourceSoakGate: soak2.gate,
    authorization: auth2,
    proposedTargets: scope3Targets,
    committedAt: "2026-09-25T00:13:00+07:00",
  });

  const scope3 = event2.resultingState.currentScope;
  const finalSoak = await buildHealthySoakForScope({
    activationStore,
    registryState,
    scope: scope3,
    prefix: "m20-final-soak",
    windowStart: "2026-09-25T00:20:00+07:00",
    windowEnd: "2026-09-25T01:20:00+07:00",
    observedAtBase: "2026-09-25T00:20:00+07:00",
  });

  const expansionState = await expansionStore.readState();
  const expansionEvents = await expansionStore.listEvents();
  const completionGate = evaluateNqaRolloutCompletion({
    registryState,
    initialScope,
    expansionState,
    expansionEvents,
    finalSoakGate: finalSoak.gate,
    rolloutUniverse: scope3Targets,
    criteria: {
      minExpansionCycles: 2,
      minTerminalTargets: 3,
      minTerminalCoverage: 1,
    },
  });

  const predecessorBaseline = registryState.rollbackTarget!.policy;
  const lineageStore = new InMemoryNqaBaselineLineageStore(predecessorBaseline);
  const finalizationAuthorization = buildNqaCandidateFinalizationAuthorization({
    registryState,
    expansionState,
    completionGate,
    authorizationId: "m20-finalize-auth-1",
    authorizerId: "human-finalization-operator",
    approvedAt: "2026-09-25T01:25:00+07:00",
    validUntil: "2026-09-25T01:35:00+07:00",
  });

  return {
    initial,
    activationStore,
    registryState,
    initialScope,
    expansionStore,
    expansionState,
    expansionEvents,
    finalScope: scope3,
    finalSoak,
    completionGate,
    lineageStore,
    finalizationAuthorization,
  };
}
