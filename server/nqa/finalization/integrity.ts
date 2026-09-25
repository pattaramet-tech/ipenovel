import { hashCanonicalJson } from "../core";
import type { NqaPolicyRegistryState } from "../activation/contracts";
import { verifyNqaPolicyRegistryState } from "../activation/integrity";
import {
  verifyNqaScopeExpansionEvent,
  verifyNqaScopeExpansionState,
} from "../soak/integrity";
import {
  NQA_BASELINE_FINALIZATION_EVENT_VERSION,
  NQA_BASELINE_LINEAGE_STATE_VERSION,
  NQA_FINALIZATION_AUTHORIZATION_VERSION,
  NqaBaselineFinalizationEventSchema,
  NqaBaselineLineageStateSchema,
  NqaCandidateFinalizationAuthorizationSchema,
  type NqaBaselineFinalizationEvent,
  type NqaBaselineLineageState,
  type NqaCandidateFinalizationAuthorization,
  type NqaRolloutCompletionGate,
} from "./contracts";
import { verifyNqaRolloutCompletionGate } from "./completion";
import type { NqaScopeExpansionState } from "../soak/contracts";

export function hashNqaBaselinePolicy(policy: unknown): string {
  return hashCanonicalJson({
    scope: "nqa:alignment-policy-artifact:v1",
    policy,
  });
}

export function buildNqaCandidateFinalizationAuthorization(input: {
  registryState: NqaPolicyRegistryState;
  expansionState: NqaScopeExpansionState;
  completionGate: NqaRolloutCompletionGate;
  authorizationId: string;
  authorizerId: string;
  approvedAt: string;
  validUntil: string;
}): NqaCandidateFinalizationAuthorization {
  const registryState = verifyNqaPolicyRegistryState(input.registryState);
  const expansionState = verifyNqaScopeExpansionState(input.expansionState);
  const completionGate = verifyNqaRolloutCompletionGate(input.completionGate);
  if (!registryState.rollbackTarget) {
    throw new Error(
      "M20 finalization authorization requires an active candidate rollback target."
    );
  }

  const withoutFingerprint = {
    authorizationVersion: NQA_FINALIZATION_AUTHORIZATION_VERSION,
    authorizationId: input.authorizationId,
    authorizerId: input.authorizerId,
    action: "FINALIZE_CANDIDATE_BASELINE" as const,
    approvalStatement: "I_APPROVE_NQA_CANDIDATE_FINALIZATION" as const,
    expectedRegistryRevision: registryState.revision,
    expectedRegistryStateFingerprint: registryState.stateFingerprint,
    sourceActivationTransactionId:
      expansionState.currentScope.sourceActivationTransactionId,
    expectedExpansionRevision: expansionState.revision,
    expectedExpansionStateFingerprint: expansionState.stateFingerprint,
    completionArtifactFingerprint: completionGate.artifactFingerprint,
    candidatePolicyFingerprint: registryState.activePolicyFingerprint,
    predecessorBaselinePolicyFingerprint:
      registryState.rollbackTarget.policyFingerprint,
    approvedAt: input.approvedAt,
    validUntil: input.validUntil,
  };

  return NqaCandidateFinalizationAuthorizationSchema.parse({
    ...withoutFingerprint,
    authorizationFingerprint: hashCanonicalJson({
      scope: "nqa:candidate-finalization-authorization:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaCandidateFinalizationAuthorization(
  input: NqaCandidateFinalizationAuthorization
): NqaCandidateFinalizationAuthorization {
  const authorization =
    NqaCandidateFinalizationAuthorizationSchema.parse(input);
  const { authorizationFingerprint, ...withoutFingerprint } = authorization;
  if (
    authorizationFingerprint !==
    hashCanonicalJson({
      scope: "nqa:candidate-finalization-authorization:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error(
      "M20 candidate finalization authorization fingerprint mismatch."
    );
  }
  return authorization;
}

export function verifyNqaCandidateFinalizationAuthorizationWindow(input: {
  authorization: NqaCandidateFinalizationAuthorization;
  committedAt: string;
}): void {
  const authorization = verifyNqaCandidateFinalizationAuthorization(
    input.authorization
  );
  const approvedAt = Date.parse(authorization.approvedAt);
  const validUntil = Date.parse(authorization.validUntil);
  const committedAt = Date.parse(input.committedAt);
  if (
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(validUntil) ||
    !Number.isFinite(committedAt) ||
    approvedAt > validUntil ||
    committedAt < approvedAt ||
    committedAt > validUntil
  ) {
    throw new Error(
      "M20 candidate finalization authorization is outside its validity window."
    );
  }
}

export function buildNqaBaselineLineageState(input: {
  revision: number;
  baselinePolicy: NqaPolicyRegistryState["activePolicy"];
  predecessorBaselinePolicy?: NqaPolicyRegistryState["activePolicy"] | null;
  sourceFinalizationTransactionId: string | null;
  sourceCompletionArtifactFingerprint: string | null;
}): NqaBaselineLineageState {
  const baselinePolicyFingerprint = hashNqaBaselinePolicy(input.baselinePolicy);
  const predecessor = input.predecessorBaselinePolicy ?? null;
  const withoutFingerprint = {
    stateVersion: NQA_BASELINE_LINEAGE_STATE_VERSION,
    revision: input.revision,
    baselinePolicyVersion: input.baselinePolicy.version,
    baselinePolicyFingerprint,
    baselinePolicy: structuredClone(input.baselinePolicy),
    predecessorBaselinePolicyVersion: predecessor?.version ?? null,
    predecessorBaselinePolicyFingerprint: predecessor
      ? hashNqaBaselinePolicy(predecessor)
      : null,
    predecessorBaselinePolicy: predecessor
      ? structuredClone(predecessor)
      : null,
    sourceFinalizationTransactionId: input.sourceFinalizationTransactionId,
    sourceCompletionArtifactFingerprint:
      input.sourceCompletionArtifactFingerprint,
  };

  return NqaBaselineLineageStateSchema.parse({
    ...withoutFingerprint,
    stateFingerprint: hashCanonicalJson({
      scope: "nqa:baseline-lineage-state:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaBaselineLineageState(
  input: NqaBaselineLineageState
): NqaBaselineLineageState {
  const state = NqaBaselineLineageStateSchema.parse(input);
  if (
    state.baselinePolicyVersion !== state.baselinePolicy.version ||
    state.baselinePolicyFingerprint !==
      hashNqaBaselinePolicy(state.baselinePolicy)
  ) {
    throw new Error("M20 baseline lineage policy fingerprint mismatch.");
  }
  if (state.predecessorBaselinePolicy) {
    if (
      state.predecessorBaselinePolicyVersion !==
        state.predecessorBaselinePolicy.version ||
      state.predecessorBaselinePolicyFingerprint !==
        hashNqaBaselinePolicy(state.predecessorBaselinePolicy)
    ) {
      throw new Error("M20 predecessor baseline policy fingerprint mismatch.");
    }
  } else if (
    state.predecessorBaselinePolicyVersion !== null ||
    state.predecessorBaselinePolicyFingerprint !== null
  ) {
    throw new Error(
      "M20 predecessor baseline lineage fields are inconsistent."
    );
  }

  const { stateFingerprint, ...withoutFingerprint } = state;
  if (
    stateFingerprint !==
    hashCanonicalJson({
      scope: "nqa:baseline-lineage-state:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M20 baseline lineage state fingerprint mismatch.");
  }
  return state;
}

export function verifyNqaBaselineFinalizationEvent(
  input: NqaBaselineFinalizationEvent
): NqaBaselineFinalizationEvent {
  const event = NqaBaselineFinalizationEventSchema.parse(input);
  verifyNqaCandidateFinalizationAuthorization(event.humanAuthorization);
  verifyNqaRolloutCompletionGate(event.sourceCompletionGate);
  verifyNqaScopeExpansionState(event.sourceExpansionState);
  event.sourceExpansionEvents.forEach(verifyNqaScopeExpansionEvent);
  verifyNqaBaselineLineageState(event.previousLineageState);
  verifyNqaBaselineLineageState(event.resultingLineageState);

  if (event.eventVersion !== NQA_BASELINE_FINALIZATION_EVENT_VERSION) {
    throw new Error("M20 baseline finalization event version mismatch.");
  }
  if (
    event.resultingLineageState.revision !==
      event.previousLineageState.revision + 1 ||
    event.resultingLineageState.sourceFinalizationTransactionId !==
      event.transactionId ||
    event.resultingLineageState.sourceCompletionArtifactFingerprint !==
      event.sourceCompletionGate.artifactFingerprint
  ) {
    throw new Error("M20 baseline finalization revision sequence is invalid.");
  }

  const { eventFingerprint, ...withoutFingerprint } = event;
  if (
    eventFingerprint !==
    hashCanonicalJson({
      scope: "nqa:baseline-finalization-event:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M20 baseline finalization event fingerprint mismatch.");
  }
  return event;
}
