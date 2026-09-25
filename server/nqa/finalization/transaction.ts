import { hashCanonicalJson } from "../core";
import type { NqaPolicyActivationStore } from "../activation/store";
import { verifyNqaPolicyTransactionEvent } from "../activation/integrity";
import type { NqaScopeExpansionStore } from "../soak/store";
import {
  verifyNqaScopeExpansionEvent,
  verifyNqaScopeExpansionState,
} from "../soak/integrity";
import {
  NQA_BASELINE_FINALIZATION_EVENT_VERSION,
  NqaBaselineFinalizationEventSchema,
  type NqaBaselineFinalizationEvent,
  type NqaCandidateFinalizationAuthorization,
  type NqaRolloutCompletionGate,
} from "./contracts";
import {
  buildNqaBaselineLineageState,
  verifyNqaBaselineFinalizationEvent,
  verifyNqaCandidateFinalizationAuthorization,
  verifyNqaCandidateFinalizationAuthorizationWindow,
} from "./integrity";
import { verifyNqaRolloutCompletionGate } from "./completion";
import type { NqaBaselineLineageStore } from "./store";

async function resolveIdempotentFinalization(input: {
  store: NqaBaselineLineageStore;
  transactionId: string;
  authorizationFingerprint: string;
  candidatePolicyFingerprint: string;
}): Promise<NqaBaselineFinalizationEvent | null> {
  const existing = await input.store.getEvent(input.transactionId);
  if (!existing) return null;
  const verified = verifyNqaBaselineFinalizationEvent(existing);
  if (
    verified.humanAuthorization.authorizationFingerprint !==
      input.authorizationFingerprint ||
    verified.resultingLineageState.baselinePolicyFingerprint !==
      input.candidatePolicyFingerprint
  ) {
    throw new Error(
      "M20 finalization transactionId already exists with different intent."
    );
  }
  return verified;
}

export async function finalizeNqaCandidateBaseline(input: {
  activationStore: NqaPolicyActivationStore;
  expansionStore: NqaScopeExpansionStore;
  lineageStore: NqaBaselineLineageStore;
  transactionId: string;
  completionGate: NqaRolloutCompletionGate;
  authorization: NqaCandidateFinalizationAuthorization;
  committedAt: string;
}): Promise<NqaBaselineFinalizationEvent> {
  const completionGate = verifyNqaRolloutCompletionGate(input.completionGate);
  if (
    completionGate.decision !== "READY_FOR_CANDIDATE_FINALIZATION_REVIEW" ||
    completionGate.failureReasons.length > 0
  ) {
    throw new Error(
      "M20 candidate finalization requires a passing rollout completion gate."
    );
  }

  const authorization = verifyNqaCandidateFinalizationAuthorization(
    input.authorization
  );
  verifyNqaCandidateFinalizationAuthorizationWindow({
    authorization,
    committedAt: input.committedAt,
  });

  const idempotent = await resolveIdempotentFinalization({
    store: input.lineageStore,
    transactionId: input.transactionId,
    authorizationFingerprint: authorization.authorizationFingerprint,
    candidatePolicyFingerprint: authorization.candidatePolicyFingerprint,
  });
  if (idempotent) return idempotent;

  const registryState = await input.activationStore.readState();
  const expansionState = verifyNqaScopeExpansionState(
    await input.expansionStore.readState()
  );
  const expansionEvents = (await input.expansionStore.listEvents()).map(
    verifyNqaScopeExpansionEvent
  );
  const lineageState = await input.lineageStore.readState();

  if (!registryState.rollbackTarget || !registryState.lastTransactionId) {
    throw new Error(
      "M20 finalization requires an active M17 candidate with rollback history."
    );
  }

  const activationEvent = await input.activationStore.getEvent(
    registryState.lastTransactionId
  );
  if (!activationEvent || activationEvent.kind !== "ACTIVATE") {
    throw new Error("M20 source M17 activation event is unavailable.");
  }
  const verifiedActivation = verifyNqaPolicyTransactionEvent(activationEvent);

  const expansionFingerprints = expansionEvents
    .sort(
      (left, right) =>
        left.resultingState.revision - right.resultingState.revision
    )
    .map(event => event.eventFingerprint);

  const mismatches: string[] = [];
  if (authorization.expectedRegistryRevision !== registryState.revision) {
    mismatches.push("authorization.registryRevision");
  }
  if (
    authorization.expectedRegistryStateFingerprint !==
    registryState.stateFingerprint
  ) {
    mismatches.push("authorization.registryStateFingerprint");
  }
  if (
    authorization.sourceActivationTransactionId !==
    registryState.lastTransactionId
  ) {
    mismatches.push("authorization.activationTransaction");
  }
  if (
    authorization.expectedExpansionRevision !== expansionState.revision ||
    authorization.expectedExpansionStateFingerprint !==
      expansionState.stateFingerprint
  ) {
    mismatches.push("authorization.expansionState");
  }
  if (
    authorization.completionArtifactFingerprint !==
    completionGate.artifactFingerprint
  ) {
    mismatches.push("authorization.completionArtifact");
  }
  if (
    authorization.candidatePolicyFingerprint !==
      registryState.activePolicyFingerprint ||
    completionGate.candidatePolicyFingerprint !==
      registryState.activePolicyFingerprint
  ) {
    mismatches.push("candidatePolicyFingerprint");
  }
  if (
    authorization.predecessorBaselinePolicyFingerprint !==
      registryState.rollbackTarget.policyFingerprint ||
    completionGate.baselinePolicyFingerprint !==
      registryState.rollbackTarget.policyFingerprint
  ) {
    mismatches.push("predecessorBaselinePolicyFingerprint");
  }
  if (
    completionGate.registryRevision !== registryState.revision ||
    completionGate.registryStateFingerprint !==
      registryState.stateFingerprint ||
    completionGate.currentExpansionState.stateFingerprint !==
      expansionState.stateFingerprint
  ) {
    mismatches.push("completion.currentState");
  }
  if (
    JSON.stringify(completionGate.expansionEventFingerprints) !==
    JSON.stringify(expansionFingerprints)
  ) {
    mismatches.push("completion.expansionHistory");
  }
  if (
    lineageState.baselinePolicyFingerprint !==
    registryState.rollbackTarget.policyFingerprint
  ) {
    mismatches.push("lineage.predecessorBaseline");
  }

  if (mismatches.length > 0) {
    throw new Error(
      "M20 finalization evidence does not match current rollout state: " +
        mismatches.join(", ")
    );
  }

  const resultingLineageState = buildNqaBaselineLineageState({
    revision: lineageState.revision + 1,
    baselinePolicy: registryState.activePolicy,
    predecessorBaselinePolicy: lineageState.baselinePolicy,
    sourceFinalizationTransactionId: input.transactionId,
    sourceCompletionArtifactFingerprint: completionGate.artifactFingerprint,
  });

  const withoutFingerprint = {
    eventVersion: NQA_BASELINE_FINALIZATION_EVENT_VERSION,
    transactionId: input.transactionId,
    humanAuthorization: authorization,
    sourceCompletionGate: completionGate,
    sourceActivationEventFingerprint: verifiedActivation.eventFingerprint,
    sourceExpansionState: expansionState,
    sourceExpansionEvents: expansionEvents,
    previousLineageState: lineageState,
    resultingLineageState,
    committedAt: input.committedAt,
  };
  const event = NqaBaselineFinalizationEventSchema.parse({
    ...withoutFingerprint,
    eventFingerprint: hashCanonicalJson({
      scope: "nqa:baseline-finalization-event:v1",
      ...withoutFingerprint,
    }),
  });

  const append = await input.lineageStore.compareAndAppend({
    expectedRevision: lineageState.revision,
    expectedStateFingerprint: lineageState.stateFingerprint,
    event,
  });

  if (append === "CONFLICT") {
    throw new Error(
      "M20 candidate finalization transaction lost compare-and-swap race."
    );
  }
  if (append === "EXISTS") {
    const existing = await resolveIdempotentFinalization({
      store: input.lineageStore,
      transactionId: input.transactionId,
      authorizationFingerprint: authorization.authorizationFingerprint,
      candidatePolicyFingerprint: authorization.candidatePolicyFingerprint,
    });
    if (!existing) {
      throw new Error(
        "M20 candidate finalization transaction exists but cannot be resolved."
      );
    }
    return existing;
  }

  return event;
}
