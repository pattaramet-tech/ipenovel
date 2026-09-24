import { hashCanonicalJson } from "../core";
import type { NqaPolicyRegistryState } from "../activation/contracts";
import {
  normalizeNqaRolloutTargets,
  verifyNqaControlledRolloutScope,
} from "../rollout/resolver";
import {
  NQA_SCOPE_EXPANSION_AUTHORIZATION_VERSION,
  NQA_SCOPE_EXPANSION_EVENT_VERSION,
  NQA_SCOPE_EXPANSION_STATE_VERSION,
  NqaScopeExpansionAuthorizationSchema,
  NqaScopeExpansionEventSchema,
  NqaScopeExpansionStateSchema,
  type NqaProductionSoakGate,
  type NqaScopeExpansionAuthorization,
  type NqaScopeExpansionEvent,
  type NqaScopeExpansionState,
} from "./contracts";
import { verifyNqaProductionSoakGate } from "./gate";

export function hashNqaRolloutTargets(
  targets: readonly { row: number; chapter: number }[]
): string {
  return hashCanonicalJson({
    scope: "nqa:rollout-target-set:v1",
    targets: normalizeNqaRolloutTargets(targets),
  });
}

export function buildNqaScopeExpansionAuthorization(input: {
  state: NqaPolicyRegistryState;
  sourceScope: NqaScopeExpansionState["currentScope"];
  soakGate: NqaProductionSoakGate;
  authorizationId: string;
  authorizerId: string;
  proposedScopeId: string;
  proposedTargets: readonly { row: number; chapter: number }[];
  approvedAt: string;
  validUntil: string;
}): NqaScopeExpansionAuthorization {
  const sourceScope = verifyNqaControlledRolloutScope(input.sourceScope);
  const soakGate = verifyNqaProductionSoakGate(input.soakGate);

  const withoutFingerprint = {
    authorizationVersion: NQA_SCOPE_EXPANSION_AUTHORIZATION_VERSION,
    authorizationId: input.authorizationId,
    authorizerId: input.authorizerId,
    action: "EXPAND_SCOPE" as const,
    approvalStatement: "I_APPROVE_NQA_SCOPE_EXPANSION" as const,
    expectedRegistryRevision: input.state.revision,
    expectedRegistryStateFingerprint: input.state.stateFingerprint,
    sourceActivationTransactionId: sourceScope.sourceActivationTransactionId,
    sourceScopeId: sourceScope.scopeId,
    sourceScopeFingerprint: sourceScope.scopeFingerprint,
    soakArtifactFingerprint: soakGate.artifactFingerprint,
    candidatePolicyFingerprint: sourceScope.candidatePolicyFingerprint,
    baselinePolicyFingerprint: sourceScope.baselinePolicyFingerprint,
    proposedScopeId: input.proposedScopeId,
    proposedTargetsFingerprint: hashNqaRolloutTargets(input.proposedTargets),
    approvedAt: input.approvedAt,
    validUntil: input.validUntil,
  };

  return NqaScopeExpansionAuthorizationSchema.parse({
    ...withoutFingerprint,
    authorizationFingerprint: hashCanonicalJson({
      scope: "nqa:scope-expansion-authorization:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaScopeExpansionAuthorization(
  input: NqaScopeExpansionAuthorization
): NqaScopeExpansionAuthorization {
  const authorization = NqaScopeExpansionAuthorizationSchema.parse(input);
  const { authorizationFingerprint, ...withoutFingerprint } = authorization;
  if (
    authorizationFingerprint !==
    hashCanonicalJson({
      scope: "nqa:scope-expansion-authorization:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M19 scope expansion authorization fingerprint mismatch.");
  }
  return authorization;
}

export function verifyNqaScopeExpansionAuthorizationWindow(input: {
  authorization: NqaScopeExpansionAuthorization;
  committedAt: string;
}): void {
  const authorization = verifyNqaScopeExpansionAuthorization(
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
      "M19 scope expansion authorization is outside its validity window."
    );
  }
}

export function buildNqaScopeExpansionState(input: {
  revision: number;
  currentScope: NqaScopeExpansionState["currentScope"];
  lastTransactionId: string | null;
}): NqaScopeExpansionState {
  const currentScope = verifyNqaControlledRolloutScope(input.currentScope);
  const withoutFingerprint = {
    stateVersion: NQA_SCOPE_EXPANSION_STATE_VERSION,
    revision: input.revision,
    currentScope,
    lastTransactionId: input.lastTransactionId,
  };
  return NqaScopeExpansionStateSchema.parse({
    ...withoutFingerprint,
    stateFingerprint: hashCanonicalJson({
      scope: "nqa:scope-expansion-state:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaScopeExpansionState(
  input: NqaScopeExpansionState
): NqaScopeExpansionState {
  const state = NqaScopeExpansionStateSchema.parse(input);
  verifyNqaControlledRolloutScope(state.currentScope);
  const { stateFingerprint, ...withoutFingerprint } = state;
  if (
    stateFingerprint !==
    hashCanonicalJson({
      scope: "nqa:scope-expansion-state:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M19 scope expansion state fingerprint mismatch.");
  }
  return state;
}

function targetKey(target: { row: number; chapter: number }): string {
  return target.row + ":" + target.chapter;
}

export function validateNqaMonotonicScopeExpansion(input: {
  previousScope: NqaScopeExpansionState["currentScope"];
  nextScope: NqaScopeExpansionState["currentScope"];
}): void {
  const previous = verifyNqaControlledRolloutScope(input.previousScope);
  const next = verifyNqaControlledRolloutScope(input.nextScope);
  if (
    previous.sourceActivationTransactionId !==
      next.sourceActivationTransactionId ||
    previous.expectedRegistryRevision !== next.expectedRegistryRevision ||
    previous.expectedRegistryStateFingerprint !==
      next.expectedRegistryStateFingerprint ||
    previous.candidatePolicyFingerprint !== next.candidatePolicyFingerprint ||
    previous.baselinePolicyFingerprint !== next.baselinePolicyFingerprint
  ) {
    throw new Error("M19 scope expansion cannot alter rollout policy linkage.");
  }

  const previousKeys = new Set(previous.targets.map(targetKey));
  const nextKeys = new Set(next.targets.map(targetKey));
  for (const key of Array.from(previousKeys)) {
    if (!nextKeys.has(key)) {
      throw new Error("M19 scope expansion cannot remove existing targets.");
    }
  }
  if (nextKeys.size <= previousKeys.size) {
    throw new Error("M19 scope expansion must add at least one new target.");
  }
}

export function verifyNqaScopeExpansionEvent(
  input: NqaScopeExpansionEvent
): NqaScopeExpansionEvent {
  const event = NqaScopeExpansionEventSchema.parse(input);
  verifyNqaScopeExpansionAuthorization(event.humanAuthorization);
  verifyNqaProductionSoakGate(event.sourceSoakGate);
  verifyNqaScopeExpansionState(event.resultingState);
  if (event.eventVersion !== NQA_SCOPE_EXPANSION_EVENT_VERSION) {
    throw new Error("M19 scope expansion event version mismatch.");
  }
  if (
    event.resultingState.revision !== event.previousRevision + 1 ||
    event.resultingState.lastTransactionId !== event.transactionId
  ) {
    throw new Error("M19 scope expansion event revision sequence is invalid.");
  }
  const { eventFingerprint, ...withoutFingerprint } = event;
  if (
    eventFingerprint !==
    hashCanonicalJson({
      scope: "nqa:scope-expansion-event:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M19 scope expansion event fingerprint mismatch.");
  }
  return event;
}

export function assertNqaScopeExpansionMatchesRegistry(input: {
  state: NqaPolicyRegistryState;
  scope: NqaScopeExpansionState["currentScope"];
}): void {
  const scope = verifyNqaControlledRolloutScope(input.scope);
  if (
    !input.state.rollbackTarget ||
    input.state.revision !== scope.expectedRegistryRevision ||
    input.state.stateFingerprint !== scope.expectedRegistryStateFingerprint ||
    input.state.lastTransactionId !== scope.sourceActivationTransactionId ||
    input.state.activePolicyFingerprint !== scope.candidatePolicyFingerprint ||
    input.state.rollbackTarget.policyFingerprint !==
      scope.baselinePolicyFingerprint
  ) {
    throw new Error(
      "M19 scope expansion is stale or incompatible with M17 registry state."
    );
  }
}
