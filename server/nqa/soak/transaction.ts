import { hashCanonicalJson } from "../core";
import type { NqaPolicyActivationStore } from "../activation/store";
import {
  buildNqaControlledRolloutScope,
  normalizeNqaRolloutTargets,
  verifyNqaControlledRolloutScope,
} from "../rollout/resolver";
import {
  NQA_SCOPE_EXPANSION_EVENT_VERSION,
  NqaScopeExpansionEventSchema,
  type NqaScopeExpansionAuthorization,
  type NqaScopeExpansionEvent,
} from "./contracts";
import {
  assertNqaScopeExpansionMatchesRegistry,
  buildNqaScopeExpansionState,
  hashNqaRolloutTargets,
  validateNqaMonotonicScopeExpansion,
  verifyNqaScopeExpansionAuthorization,
  verifyNqaScopeExpansionAuthorizationWindow,
  verifyNqaScopeExpansionEvent,
} from "./integrity";
import { verifyNqaProductionSoakGate } from "./gate";
import type { NqaScopeExpansionStore } from "./store";

async function resolveIdempotentExpansion(input: {
  store: NqaScopeExpansionStore;
  transactionId: string;
  authorizationFingerprint: string;
  proposedScopeId: string;
  proposedTargetsFingerprint: string;
}): Promise<NqaScopeExpansionEvent | null> {
  const existing = await input.store.getEvent(input.transactionId);
  if (!existing) return null;
  const verified = verifyNqaScopeExpansionEvent(existing);
  if (
    verified.humanAuthorization.authorizationFingerprint !==
      input.authorizationFingerprint ||
    verified.resultingState.currentScope.scopeId !== input.proposedScopeId ||
    hashNqaRolloutTargets(verified.resultingState.currentScope.targets) !==
      input.proposedTargetsFingerprint
  ) {
    throw new Error(
      "M19 expansion transactionId already exists with different intent."
    );
  }
  return verified;
}

export async function expandNqaControlledRolloutScope(input: {
  activationStore: NqaPolicyActivationStore;
  expansionStore: NqaScopeExpansionStore;
  transactionId: string;
  sourceSoakGate: Parameters<typeof verifyNqaProductionSoakGate>[0];
  authorization: NqaScopeExpansionAuthorization;
  proposedTargets: readonly { row: number; chapter: number }[];
  committedAt: string;
}): Promise<NqaScopeExpansionEvent> {
  const authorization = verifyNqaScopeExpansionAuthorization(
    input.authorization
  );
  verifyNqaScopeExpansionAuthorizationWindow({
    authorization,
    committedAt: input.committedAt,
  });

  const sourceSoakGate = verifyNqaProductionSoakGate(input.sourceSoakGate);
  if (
    sourceSoakGate.decision !== "READY_FOR_SCOPE_EXPANSION_REVIEW" ||
    sourceSoakGate.failureReasons.length > 0
  ) {
    throw new Error(
      "M19 scope expansion requires a passing production soak gate."
    );
  }

  const normalizedTargets = normalizeNqaRolloutTargets(input.proposedTargets);
  const proposedTargetsFingerprint = hashNqaRolloutTargets(normalizedTargets);
  if (authorization.proposedTargetsFingerprint !== proposedTargetsFingerprint) {
    throw new Error("M19 expansion authorization target-set linkage mismatch.");
  }

  const existing = await resolveIdempotentExpansion({
    store: input.expansionStore,
    transactionId: input.transactionId,
    authorizationFingerprint: authorization.authorizationFingerprint,
    proposedScopeId: authorization.proposedScopeId,
    proposedTargetsFingerprint,
  });
  if (existing) return existing;

  const expansionState = await input.expansionStore.readState();
  const sourceScope = verifyNqaControlledRolloutScope(
    expansionState.currentScope
  );
  const registryState = await input.activationStore.readState();
  assertNqaScopeExpansionMatchesRegistry({
    state: registryState,
    scope: sourceScope,
  });

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
    sourceScope.sourceActivationTransactionId
  ) {
    mismatches.push("authorization.activationTransaction");
  }
  if (authorization.sourceScopeId !== sourceScope.scopeId) {
    mismatches.push("authorization.sourceScopeId");
  }
  if (authorization.sourceScopeFingerprint !== sourceScope.scopeFingerprint) {
    mismatches.push("authorization.sourceScopeFingerprint");
  }
  if (
    authorization.soakArtifactFingerprint !== sourceSoakGate.artifactFingerprint
  ) {
    mismatches.push("authorization.soakArtifactFingerprint");
  }
  if (
    authorization.candidatePolicyFingerprint !==
    sourceScope.candidatePolicyFingerprint
  ) {
    mismatches.push("authorization.candidatePolicyFingerprint");
  }
  if (
    authorization.baselinePolicyFingerprint !==
    sourceScope.baselinePolicyFingerprint
  ) {
    mismatches.push("authorization.baselinePolicyFingerprint");
  }
  if (sourceSoakGate.scopeFingerprint !== sourceScope.scopeFingerprint) {
    mismatches.push("soak.scopeFingerprint");
  }
  if (sourceSoakGate.registryRevision !== registryState.revision) {
    mismatches.push("soak.registryRevision");
  }
  if (
    sourceSoakGate.registryStateFingerprint !== registryState.stateFingerprint
  ) {
    mismatches.push("soak.registryStateFingerprint");
  }
  if (mismatches.length > 0) {
    throw new Error(
      "M19 expansion authorization/soak evidence does not match current rollout state: " +
        mismatches.join(", ")
    );
  }

  const nextScope = buildNqaControlledRolloutScope({
    state: registryState,
    scopeId: authorization.proposedScopeId,
    approvedBy: authorization.authorizerId,
    approvedAt: authorization.approvedAt,
    targets: normalizedTargets,
  });
  validateNqaMonotonicScopeExpansion({
    previousScope: sourceScope,
    nextScope,
  });

  const previousKeys = new Set(
    sourceScope.targets.map(target => target.row + ":" + target.chapter)
  );
  const addedTargets = nextScope.targets.filter(
    target => !previousKeys.has(target.row + ":" + target.chapter)
  );

  const resultingState = buildNqaScopeExpansionState({
    revision: expansionState.revision + 1,
    currentScope: nextScope,
    lastTransactionId: input.transactionId,
  });

  const withoutFingerprint = {
    eventVersion: NQA_SCOPE_EXPANSION_EVENT_VERSION,
    transactionId: input.transactionId,
    humanAuthorization: authorization,
    sourceScope,
    sourceSoakGate,
    addedTargets,
    previousRevision: expansionState.revision,
    previousStateFingerprint: expansionState.stateFingerprint,
    resultingState,
    committedAt: input.committedAt,
  };
  const event = NqaScopeExpansionEventSchema.parse({
    ...withoutFingerprint,
    eventFingerprint: hashCanonicalJson({
      scope: "nqa:scope-expansion-event:v1",
      ...withoutFingerprint,
    }),
  });

  const append = await input.expansionStore.compareAndAppend({
    expectedRevision: expansionState.revision,
    expectedStateFingerprint: expansionState.stateFingerprint,
    event,
  });
  if (append === "CONFLICT") {
    throw new Error(
      "M19 scope expansion transaction lost compare-and-swap race."
    );
  }
  if (append === "EXISTS") {
    const existing = await resolveIdempotentExpansion({
      store: input.expansionStore,
      transactionId: input.transactionId,
      authorizationFingerprint: authorization.authorizationFingerprint,
      proposedScopeId: authorization.proposedScopeId,
      proposedTargetsFingerprint,
    });
    if (!existing) {
      throw new Error(
        "M19 scope expansion transaction exists but cannot be resolved."
      );
    }
    return existing;
  }
  return event;
}
