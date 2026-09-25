import { hashCanonicalJson } from "../core";
import type { NqaPolicyRegistryState } from "../activation/contracts";
import type { NqaControlledRolloutScope } from "../rollout/contracts";
import {
  normalizeNqaRolloutTargets,
  verifyNqaControlledRolloutScope,
} from "../rollout/resolver";
import type {
  NqaProductionSoakGate,
  NqaScopeExpansionEvent,
  NqaScopeExpansionState,
} from "../soak/contracts";
import { verifyNqaProductionSoakGate } from "../soak/gate";
import {
  buildNqaScopeExpansionState,
  verifyNqaScopeExpansionEvent,
  verifyNqaScopeExpansionState,
} from "../soak/integrity";
import { validateNqaScopeExpansionTransition } from "../soak/store";
import {
  NQA_ROLLOUT_COMPLETION_GATE_VERSION,
  NqaRolloutCompletionCriteriaSchema,
  NqaRolloutCompletionGateSchema,
  type NqaRolloutCompletionCriteria,
  type NqaRolloutCompletionGate,
} from "./contracts";

function targetKey(target: { row: number; chapter: number }): string {
  return target.row + ":" + target.chapter;
}

function verifyExpansionHistory(input: {
  initialScope: NqaControlledRolloutScope;
  expansionState: NqaScopeExpansionState;
  expansionEvents: readonly NqaScopeExpansionEvent[];
}): {
  orderedEvents: NqaScopeExpansionEvent[];
  historyMatches: boolean;
  passingExpansionSoaks: number;
} {
  const initialScope = verifyNqaControlledRolloutScope(input.initialScope);
  const state = verifyNqaScopeExpansionState(input.expansionState);
  const events = input.expansionEvents.map(verifyNqaScopeExpansionEvent);
  const ordered = [...events].sort(
    (left, right) =>
      left.resultingState.revision - right.resultingState.revision
  );
  const inputOrderMatches = events.every(
    (event, index) =>
      event.eventFingerprint === ordered[index]?.eventFingerprint
  );

  let replayState = buildNqaScopeExpansionState({
    revision: 0,
    currentScope: initialScope,
    lastTransactionId: null,
  });
  let passingExpansionSoaks = 0;
  let historyMatches = inputOrderMatches;

  for (const event of ordered) {
    try {
      validateNqaScopeExpansionTransition({
        previous: replayState,
        event,
      });
    } catch {
      historyMatches = false;
    }
    if (
      event.sourceSoakGate.decision === "READY_FOR_SCOPE_EXPANSION_REVIEW" &&
      event.sourceSoakGate.failureReasons.length === 0
    ) {
      passingExpansionSoaks += 1;
    }
    replayState = event.resultingState;
  }

  if (state.stateFingerprint !== replayState.stateFingerprint) {
    historyMatches = false;
  }

  return {
    orderedEvents: ordered,
    historyMatches,
    passingExpansionSoaks,
  };
}

export function evaluateNqaRolloutCompletion(input: {
  registryState: NqaPolicyRegistryState;
  initialScope: NqaControlledRolloutScope;
  expansionState: NqaScopeExpansionState;
  expansionEvents: readonly NqaScopeExpansionEvent[];
  finalSoakGate: NqaProductionSoakGate;
  rolloutUniverse: readonly { row: number; chapter: number }[];
  criteria: NqaRolloutCompletionCriteria;
}): NqaRolloutCompletionGate {
  const initialScope = verifyNqaControlledRolloutScope(input.initialScope);
  const expansionState = verifyNqaScopeExpansionState(input.expansionState);
  const finalSoakGate = verifyNqaProductionSoakGate(input.finalSoakGate);
  const criteria = NqaRolloutCompletionCriteriaSchema.parse(input.criteria);
  const rolloutUniverse = normalizeNqaRolloutTargets(input.rolloutUniverse);
  const history = verifyExpansionHistory({
    initialScope,
    expansionState,
    expansionEvents: input.expansionEvents,
  });

  const currentScope = expansionState.currentScope;
  const currentKeys = new Set(currentScope.targets.map(targetKey));
  const universeKeys = new Set(rolloutUniverse.map(targetKey));
  const coveredTargets = rolloutUniverse.filter(target =>
    currentKeys.has(targetKey(target))
  );
  const terminalCoverage =
    rolloutUniverse.length === 0
      ? 0
      : coveredTargets.length / rolloutUniverse.length;

  const failureReasons: NqaRolloutCompletionGate["failureReasons"] = [];

  const registryMatches =
    Boolean(input.registryState.rollbackTarget) &&
    input.registryState.revision === currentScope.expectedRegistryRevision &&
    input.registryState.stateFingerprint ===
      currentScope.expectedRegistryStateFingerprint &&
    input.registryState.lastTransactionId ===
      currentScope.sourceActivationTransactionId &&
    input.registryState.activePolicyFingerprint ===
      currentScope.candidatePolicyFingerprint &&
    input.registryState.rollbackTarget!.policyFingerprint ===
      currentScope.baselinePolicyFingerprint;

  if (!registryMatches) failureReasons.push("REGISTRY_MISMATCH");
  if (!history.historyMatches)
    failureReasons.push("EXPANSION_HISTORY_MISMATCH");
  if (history.orderedEvents.length < criteria.minExpansionCycles) {
    failureReasons.push("INSUFFICIENT_EXPANSION_CYCLES");
  }
  if (history.passingExpansionSoaks !== history.orderedEvents.length) {
    failureReasons.push("EXPANSION_SOAK_NOT_READY");
  }
  if (
    finalSoakGate.decision !== "READY_FOR_SCOPE_EXPANSION_REVIEW" ||
    finalSoakGate.failureReasons.length > 0
  ) {
    failureReasons.push("FINAL_SOAK_NOT_READY");
  }
  if (
    finalSoakGate.scopeFingerprint !== currentScope.scopeFingerprint ||
    finalSoakGate.registryRevision !== input.registryState.revision ||
    finalSoakGate.registryStateFingerprint !==
      input.registryState.stateFingerprint ||
    finalSoakGate.candidatePolicyFingerprint !==
      currentScope.candidatePolicyFingerprint ||
    finalSoakGate.baselinePolicyFingerprint !==
      currentScope.baselinePolicyFingerprint
  ) {
    failureReasons.push("FINAL_SCOPE_MISMATCH");
  }
  if (currentScope.targets.length < criteria.minTerminalTargets) {
    failureReasons.push("TERMINAL_TARGET_COUNT_INSUFFICIENT");
  }
  if (terminalCoverage < criteria.minTerminalCoverage) {
    failureReasons.push("TERMINAL_COVERAGE_INSUFFICIENT");
  }

  for (const key of Array.from(currentKeys)) {
    if (!universeKeys.has(key)) {
      failureReasons.push("FINAL_SCOPE_MISMATCH");
      break;
    }
  }

  const rolloutUniverseFingerprint = hashCanonicalJson({
    scope: "nqa:rollout-universe:v1",
    targets: rolloutUniverse,
  });
  const expansionEventFingerprints = history.orderedEvents.map(
    event => event.eventFingerprint
  );
  const historyFingerprint = hashCanonicalJson({
    scope: "nqa:rollout-completion-history:v1",
    initialScopeFingerprint: initialScope.scopeFingerprint,
    expansionStateFingerprint: expansionState.stateFingerprint,
    expansionEventFingerprints,
    finalSoakArtifactFingerprint: finalSoakGate.artifactFingerprint,
    rolloutUniverseFingerprint,
  });

  const withoutFingerprint = {
    gateVersion: NQA_ROLLOUT_COMPLETION_GATE_VERSION,
    sourceActivationTransactionId: currentScope.sourceActivationTransactionId,
    registryRevision: input.registryState.revision,
    registryStateFingerprint: input.registryState.stateFingerprint,
    baselinePolicyFingerprint: currentScope.baselinePolicyFingerprint,
    candidatePolicyFingerprint: currentScope.candidatePolicyFingerprint,
    initialScope,
    currentExpansionState: expansionState,
    expansionEventFingerprints,
    finalSoakGate,
    finalSoakArtifactFingerprint: finalSoakGate.artifactFingerprint,
    rolloutUniverse,
    rolloutUniverseFingerprint,
    criteria,
    metrics: {
      expansionCycles: history.orderedEvents.length,
      passingExpansionSoaks: history.passingExpansionSoaks,
      terminalTargetCount: currentScope.targets.length,
      universeTargetCount: rolloutUniverse.length,
      terminalCoverage,
    },
    failureReasons: Array.from(new Set(failureReasons)),
    decision:
      failureReasons.length === 0
        ? ("READY_FOR_CANDIDATE_FINALIZATION_REVIEW" as const)
        : ("HOLD" as const),
    historyFingerprint,
  };

  return NqaRolloutCompletionGateSchema.parse({
    ...withoutFingerprint,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:rollout-completion-gate:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaRolloutCompletionGate(
  input: NqaRolloutCompletionGate
): NqaRolloutCompletionGate {
  const gate = NqaRolloutCompletionGateSchema.parse(input);
  const initialScope = verifyNqaControlledRolloutScope(gate.initialScope);
  const expansionState = verifyNqaScopeExpansionState(
    gate.currentExpansionState
  );
  const finalSoakGate = verifyNqaProductionSoakGate(gate.finalSoakGate);
  const rolloutUniverse = normalizeNqaRolloutTargets(gate.rolloutUniverse);

  if (gate.finalSoakArtifactFingerprint !== finalSoakGate.artifactFingerprint) {
    throw new Error("M20 final soak linkage fingerprint mismatch.");
  }

  const rolloutUniverseFingerprint = hashCanonicalJson({
    scope: "nqa:rollout-universe:v1",
    targets: rolloutUniverse,
  });
  if (gate.rolloutUniverseFingerprint !== rolloutUniverseFingerprint) {
    throw new Error("M20 rollout universe fingerprint mismatch.");
  }

  const historyFingerprint = hashCanonicalJson({
    scope: "nqa:rollout-completion-history:v1",
    initialScopeFingerprint: initialScope.scopeFingerprint,
    expansionStateFingerprint: expansionState.stateFingerprint,
    expansionEventFingerprints: gate.expansionEventFingerprints,
    finalSoakArtifactFingerprint: finalSoakGate.artifactFingerprint,
    rolloutUniverseFingerprint,
  });
  if (gate.historyFingerprint !== historyFingerprint) {
    throw new Error("M20 rollout completion history fingerprint mismatch.");
  }

  const expectedDecision =
    gate.failureReasons.length === 0
      ? "READY_FOR_CANDIDATE_FINALIZATION_REVIEW"
      : "HOLD";
  if (gate.decision !== expectedDecision) {
    throw new Error("M20 rollout completion decision semantics mismatch.");
  }

  const { artifactFingerprint, ...withoutFingerprint } = gate;
  const expected = hashCanonicalJson({
    scope: "nqa:rollout-completion-gate:v1",
    ...withoutFingerprint,
  });
  if (artifactFingerprint !== expected) {
    throw new Error("M20 rollout completion artifact fingerprint mismatch.");
  }
  return gate;
}
