import { hashCanonicalJson } from "../core";
import type {
  NqaActivationReadiness,
  NqaMaterializedCandidatePolicy,
} from "../candidatePolicy/contracts";
import {
  NQA_POLICY_TRANSACTION_EVENT_VERSION,
  NqaActivationTransactionEventSchema,
  NqaRollbackTransactionEventSchema,
  type NqaActivationAuthorization,
  type NqaActivationTransactionEvent,
  type NqaPolicyRegistryState,
  type NqaPolicyTransactionEvent,
  type NqaRollbackAuthorization,
  type NqaRollbackTransactionEvent,
} from "./contracts";
import {
  buildNqaPolicyRegistryState,
  verifyNqaActivationCandidateLinkage,
  verifyNqaAuthorizationWindow,
  verifyNqaHumanPolicyAuthorization,
  verifyNqaPolicyTransactionEvent,
} from "./integrity";
import type { NqaPolicyActivationStore } from "./store";

function eventFingerprint(
  event: Omit<NqaPolicyTransactionEvent, "eventFingerprint">
): string {
  return hashCanonicalJson({
    scope: "nqa:policy-transaction-event:v1",
    ...event,
  });
}

function assertAuthorizationMatchesState(input: {
  authorization: NqaActivationAuthorization | NqaRollbackAuthorization;
  state: NqaPolicyRegistryState;
  targetPolicyFingerprint: string;
  committedAt: string;
}): void {
  const authorization = verifyNqaHumanPolicyAuthorization(input.authorization);
  verifyNqaAuthorizationWindow({
    authorization,
    committedAt: input.committedAt,
  });
  if (
    authorization.expectedRegistryRevision !== input.state.revision ||
    authorization.expectedActivePolicyFingerprint !==
      input.state.activePolicyFingerprint ||
    authorization.targetPolicyFingerprint !== input.targetPolicyFingerprint
  ) {
    throw new Error(
      "NQA human authorization does not match current registry state."
    );
  }
}

async function resolveIdempotentEvent(input: {
  store: NqaPolicyActivationStore;
  transactionId: string;
  kind: "ACTIVATE" | "ROLLBACK";
  authorizationFingerprint: string;
  targetPolicyFingerprint: string;
}): Promise<NqaPolicyTransactionEvent | null> {
  const existing = await input.store.getEvent(input.transactionId);
  if (!existing) return null;
  const verified = verifyNqaPolicyTransactionEvent(existing);
  if (
    verified.kind !== input.kind ||
    verified.humanAuthorization.authorizationFingerprint !==
      input.authorizationFingerprint ||
    verified.resultingState.activePolicyFingerprint !==
      input.targetPolicyFingerprint
  ) {
    throw new Error("NQA transactionId already exists with different intent.");
  }
  return verified;
}

export async function activateNqaCandidatePolicy(input: {
  store: NqaPolicyActivationStore;
  transactionId: string;
  readiness: NqaActivationReadiness;
  materializedPolicy: NqaMaterializedCandidatePolicy;
  authorization: NqaActivationAuthorization;
  committedAt: string;
}): Promise<NqaActivationTransactionEvent> {
  const { readiness, materializedPolicy } = verifyNqaActivationCandidateLinkage(
    {
      readiness: input.readiness,
      materializedPolicy: input.materializedPolicy,
    }
  );
  const authorization = verifyNqaHumanPolicyAuthorization(input.authorization);
  if (authorization.action !== "ACTIVATE") {
    throw new Error("M17 activation requires ACTIVATE authorization.");
  }

  const idempotent = await resolveIdempotentEvent({
    store: input.store,
    transactionId: input.transactionId,
    kind: "ACTIVATE",
    authorizationFingerprint: authorization.authorizationFingerprint,
    targetPolicyFingerprint: materializedPolicy.policyFingerprint,
  });
  if (idempotent) {
    return NqaActivationTransactionEventSchema.parse(idempotent);
  }

  const state = await input.store.readState();
  if (
    state.activePolicyVersion !== materializedPolicy.sourcePolicyVersion ||
    state.activePolicyFingerprint !== materializedPolicy.basePolicyFingerprint
  ) {
    throw new Error(
      "M17 active registry state does not match candidate base policy."
    );
  }
  if (
    authorization.readinessArtifactFingerprint !== readiness.artifactFingerprint
  ) {
    throw new Error("M17 activation authorization readiness linkage mismatch.");
  }
  assertAuthorizationMatchesState({
    authorization,
    state,
    targetPolicyFingerprint: materializedPolicy.policyFingerprint,
    committedAt: input.committedAt,
  });

  const rollbackTarget = {
    policyVersion: state.activePolicyVersion,
    policyFingerprint: state.activePolicyFingerprint,
    policy: structuredClone(state.activePolicy),
    sourceActivationTransactionId: input.transactionId,
    sourceReadinessArtifactFingerprint: readiness.artifactFingerprint,
  };
  const nextState = buildNqaPolicyRegistryState({
    revision: state.revision + 1,
    activePolicy: materializedPolicy.policy,
    rollbackTarget,
    lastTransactionId: input.transactionId,
  });

  const withoutFingerprint = {
    eventVersion: NQA_POLICY_TRANSACTION_EVENT_VERSION,
    transactionId: input.transactionId,
    kind: "ACTIVATE" as const,
    humanAuthorization: authorization,
    previousRevision: state.revision,
    nextRevision: nextState.revision,
    previousStateFingerprint: state.stateFingerprint,
    previousActivePolicyVersion: state.activePolicyVersion,
    previousActivePolicyFingerprint: state.activePolicyFingerprint,
    resultingState: nextState,
    committedAt: input.committedAt,
    sourceReadiness: readiness,
    sourceMaterializedPolicyArtifactFingerprint:
      materializedPolicy.artifactFingerprint,
    rolledBackActivationTransactionId: null,
  };
  const event = NqaActivationTransactionEventSchema.parse({
    ...withoutFingerprint,
    eventFingerprint: eventFingerprint(withoutFingerprint),
  });

  const append = await input.store.compareAndAppend({
    expectedRevision: state.revision,
    expectedStateFingerprint: state.stateFingerprint,
    event,
  });
  if (append === "CONFLICT") {
    throw new Error("M17 activation transaction lost compare-and-swap race.");
  }
  if (append === "EXISTS") {
    const existing = await resolveIdempotentEvent({
      store: input.store,
      transactionId: input.transactionId,
      kind: "ACTIVATE",
      authorizationFingerprint: authorization.authorizationFingerprint,
      targetPolicyFingerprint: materializedPolicy.policyFingerprint,
    });
    if (!existing) {
      throw new Error(
        "M17 activation transaction exists but cannot be resolved."
      );
    }
    return NqaActivationTransactionEventSchema.parse(existing);
  }
  return event;
}

export async function rollbackNqaActivePolicy(input: {
  store: NqaPolicyActivationStore;
  transactionId: string;
  authorization: NqaRollbackAuthorization;
  committedAt: string;
}): Promise<NqaRollbackTransactionEvent> {
  const authorization = verifyNqaHumanPolicyAuthorization(input.authorization);
  if (authorization.action !== "ROLLBACK") {
    throw new Error("M17 rollback requires ROLLBACK authorization.");
  }

  const state = await input.store.readState();
  const rollbackTarget = state.rollbackTarget;
  if (!rollbackTarget) {
    const existing = await input.store.getEvent(input.transactionId);
    if (existing) {
      return NqaRollbackTransactionEventSchema.parse(
        await resolveIdempotentEvent({
          store: input.store,
          transactionId: input.transactionId,
          kind: "ROLLBACK",
          authorizationFingerprint: authorization.authorizationFingerprint,
          targetPolicyFingerprint: authorization.targetPolicyFingerprint,
        })
      );
    }
    throw new Error("M17 rollback target is not available.");
  }

  const idempotent = await resolveIdempotentEvent({
    store: input.store,
    transactionId: input.transactionId,
    kind: "ROLLBACK",
    authorizationFingerprint: authorization.authorizationFingerprint,
    targetPolicyFingerprint: rollbackTarget.policyFingerprint,
  });
  if (idempotent) {
    return NqaRollbackTransactionEventSchema.parse(idempotent);
  }

  if (
    authorization.sourceActivationTransactionId !==
    rollbackTarget.sourceActivationTransactionId
  ) {
    throw new Error("M17 rollback authorization activation linkage mismatch.");
  }
  assertAuthorizationMatchesState({
    authorization,
    state,
    targetPolicyFingerprint: rollbackTarget.policyFingerprint,
    committedAt: input.committedAt,
  });

  const nextState = buildNqaPolicyRegistryState({
    revision: state.revision + 1,
    activePolicy: rollbackTarget.policy,
    rollbackTarget: null,
    lastTransactionId: input.transactionId,
  });
  const withoutFingerprint = {
    eventVersion: NQA_POLICY_TRANSACTION_EVENT_VERSION,
    transactionId: input.transactionId,
    kind: "ROLLBACK" as const,
    humanAuthorization: authorization,
    previousRevision: state.revision,
    nextRevision: nextState.revision,
    previousStateFingerprint: state.stateFingerprint,
    previousActivePolicyVersion: state.activePolicyVersion,
    previousActivePolicyFingerprint: state.activePolicyFingerprint,
    resultingState: nextState,
    committedAt: input.committedAt,
    sourceReadiness: null,
    sourceMaterializedPolicyArtifactFingerprint: null,
    rolledBackActivationTransactionId:
      rollbackTarget.sourceActivationTransactionId,
  };
  const event = NqaRollbackTransactionEventSchema.parse({
    ...withoutFingerprint,
    eventFingerprint: eventFingerprint(withoutFingerprint),
  });

  const append = await input.store.compareAndAppend({
    expectedRevision: state.revision,
    expectedStateFingerprint: state.stateFingerprint,
    event,
  });
  if (append === "CONFLICT") {
    throw new Error("M17 rollback transaction lost compare-and-swap race.");
  }
  if (append === "EXISTS") {
    const existing = await resolveIdempotentEvent({
      store: input.store,
      transactionId: input.transactionId,
      kind: "ROLLBACK",
      authorizationFingerprint: authorization.authorizationFingerprint,
      targetPolicyFingerprint: rollbackTarget.policyFingerprint,
    });
    if (!existing) {
      throw new Error(
        "M17 rollback transaction exists but cannot be resolved."
      );
    }
    return NqaRollbackTransactionEventSchema.parse(existing);
  }
  return event;
}
