import { hashCanonicalJson } from "../core";
import {
  NqaActivationReadinessSchema,
  NqaMaterializedCandidatePolicySchema,
  type NqaActivationReadiness,
  type NqaMaterializedCandidatePolicy,
} from "../candidatePolicy/contracts";
import { verifyMaterializedCandidateArtifact } from "../candidatePolicy/integrity";
import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  NQA_HUMAN_POLICY_AUTHORIZATION_VERSION,
  NQA_POLICY_REGISTRY_STATE_VERSION,
  NqaHumanPolicyAuthorizationSchema,
  NqaPolicyRegistryStateSchema,
  NqaPolicyTransactionEventSchema,
  type NqaHumanPolicyAuthorization,
  type NqaPolicyRegistryState,
  type NqaPolicyTransactionEvent,
} from "./contracts";

export function hashNqaRegistryPolicy(policy: NqaAlignmentPolicy): string {
  return hashCanonicalJson({
    scope: "nqa:alignment-policy-artifact:v1",
    policy,
  });
}

function statePayload(
  state: Omit<NqaPolicyRegistryState, "stateFingerprint">
): unknown {
  return {
    scope: "nqa:active-policy-registry-state:v1",
    ...state,
  };
}

export function buildNqaPolicyRegistryState(input: {
  revision: number;
  activePolicy: NqaAlignmentPolicy;
  rollbackTarget: NqaPolicyRegistryState["rollbackTarget"];
  lastTransactionId: string | null;
}): NqaPolicyRegistryState {
  const activePolicyFingerprint = hashNqaRegistryPolicy(input.activePolicy);
  const withoutFingerprint: Omit<NqaPolicyRegistryState, "stateFingerprint"> = {
    stateVersion: NQA_POLICY_REGISTRY_STATE_VERSION,
    revision: input.revision,
    activePolicyVersion: input.activePolicy.version,
    activePolicyFingerprint,
    activePolicy: structuredClone(input.activePolicy),
    rollbackTarget: input.rollbackTarget
      ? structuredClone(input.rollbackTarget)
      : null,
    lastTransactionId: input.lastTransactionId,
  };
  return NqaPolicyRegistryStateSchema.parse({
    ...withoutFingerprint,
    stateFingerprint: hashCanonicalJson(statePayload(withoutFingerprint)),
  });
}

export function verifyNqaPolicyRegistryState(
  input: NqaPolicyRegistryState
): NqaPolicyRegistryState {
  const state = NqaPolicyRegistryStateSchema.parse(input);
  if (
    state.activePolicyVersion !== state.activePolicy.version ||
    state.activePolicyFingerprint !== hashNqaRegistryPolicy(state.activePolicy)
  ) {
    throw new Error("NQA active-policy registry policy fingerprint mismatch.");
  }
  if (
    state.rollbackTarget &&
    (state.rollbackTarget.policyVersion !==
      state.rollbackTarget.policy.version ||
      state.rollbackTarget.policyFingerprint !==
        hashNqaRegistryPolicy(state.rollbackTarget.policy))
  ) {
    throw new Error("NQA rollback-target policy fingerprint mismatch.");
  }

  const { stateFingerprint, ...withoutFingerprint } = state;
  if (
    stateFingerprint !== hashCanonicalJson(statePayload(withoutFingerprint))
  ) {
    throw new Error("NQA active-policy registry state fingerprint mismatch.");
  }
  return state;
}

function authorizationPayload(
  authorization: Omit<NqaHumanPolicyAuthorization, "authorizationFingerprint">
): unknown {
  return {
    scope: "nqa:human-policy-authorization:v1",
    ...authorization,
  };
}

export function buildNqaHumanPolicyAuthorization(
  input:
    | Omit<
        Extract<NqaHumanPolicyAuthorization, { action: "ACTIVATE" }>,
        "authorizationVersion" | "authorizationFingerprint"
      >
    | Omit<
        Extract<NqaHumanPolicyAuthorization, { action: "ROLLBACK" }>,
        "authorizationVersion" | "authorizationFingerprint"
      >
): NqaHumanPolicyAuthorization {
  const withoutFingerprint = {
    authorizationVersion: NQA_HUMAN_POLICY_AUTHORIZATION_VERSION,
    ...input,
  } as Omit<NqaHumanPolicyAuthorization, "authorizationFingerprint">;
  return NqaHumanPolicyAuthorizationSchema.parse({
    ...withoutFingerprint,
    authorizationFingerprint: hashCanonicalJson(
      authorizationPayload(withoutFingerprint)
    ),
  });
}

export function verifyNqaHumanPolicyAuthorization(
  input: NqaHumanPolicyAuthorization
): NqaHumanPolicyAuthorization {
  const authorization = NqaHumanPolicyAuthorizationSchema.parse(input);
  const { authorizationFingerprint, ...withoutFingerprint } = authorization;
  if (
    authorizationFingerprint !==
    hashCanonicalJson(authorizationPayload(withoutFingerprint))
  ) {
    throw new Error("NQA human policy authorization fingerprint mismatch.");
  }
  return authorization;
}

export function verifyNqaActivationReadinessArtifact(
  input: NqaActivationReadiness
): NqaActivationReadiness {
  const readiness = NqaActivationReadinessSchema.parse(input);
  const { artifactFingerprint, ...payload } = readiness;
  const expected = hashCanonicalJson({
    scope: "nqa:activation-readiness:v1",
    ...payload,
  });
  if (artifactFingerprint !== expected) {
    throw new Error("M16 activation-readiness artifact fingerprint mismatch.");
  }
  if (
    readiness.decision !== "READY_FOR_EXPLICIT_ACTIVATION_REVIEW" ||
    readiness.failureReasons.length > 0
  ) {
    throw new Error("M17 requires M16 activation readiness.");
  }
  if (
    !readiness.criteria.requireDistinctShadowDataset ||
    !readiness.criteria.requireShadowPromote ||
    !readiness.criteria.requireInactiveCandidate
  ) {
    throw new Error("M16 activation-readiness guards are not fully enabled.");
  }
  return readiness;
}

export function verifyNqaActivationCandidateLinkage(input: {
  readiness: NqaActivationReadiness;
  materializedPolicy: NqaMaterializedCandidatePolicy;
}): {
  readiness: NqaActivationReadiness;
  materializedPolicy: NqaMaterializedCandidatePolicy;
} {
  const readiness = verifyNqaActivationReadinessArtifact(input.readiness);
  const materializedPolicy = verifyMaterializedCandidateArtifact(
    NqaMaterializedCandidatePolicySchema.parse(input.materializedPolicy)
  );
  if (
    readiness.materializedPolicyArtifactFingerprint !==
      materializedPolicy.artifactFingerprint ||
    readiness.candidatePolicyFingerprint !==
      materializedPolicy.policyFingerprint ||
    readiness.candidatePolicyVersion !==
      materializedPolicy.candidatePolicyVersion
  ) {
    throw new Error("M17 readiness/candidate linkage mismatch.");
  }
  return { readiness, materializedPolicy };
}

export function verifyNqaAuthorizationWindow(input: {
  authorization: NqaHumanPolicyAuthorization;
  committedAt: string;
}): void {
  const approvedAt = Date.parse(input.authorization.approvedAt);
  const validUntil = Date.parse(input.authorization.validUntil);
  const committedAt = Date.parse(input.committedAt);
  if (
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(validUntil) ||
    !Number.isFinite(committedAt) ||
    approvedAt > validUntil ||
    committedAt < approvedAt ||
    committedAt > validUntil
  ) {
    throw new Error("NQA human authorization is outside its validity window.");
  }
}

export function verifyNqaPolicyTransactionEvent(
  input: NqaPolicyTransactionEvent
): NqaPolicyTransactionEvent {
  const event = NqaPolicyTransactionEventSchema.parse(input);
  verifyNqaHumanPolicyAuthorization(event.humanAuthorization);
  verifyNqaPolicyRegistryState(event.resultingState);

  if (event.nextRevision !== event.previousRevision + 1) {
    throw new Error("NQA policy transaction revision sequence is invalid.");
  }
  if (
    event.resultingState.revision !== event.nextRevision ||
    event.resultingState.lastTransactionId !== event.transactionId
  ) {
    throw new Error("NQA policy transaction resulting state is invalid.");
  }

  const { eventFingerprint, ...payload } = event;
  const expected = hashCanonicalJson({
    scope: "nqa:policy-transaction-event:v1",
    ...payload,
  });
  if (eventFingerprint !== expected) {
    throw new Error("NQA policy transaction event fingerprint mismatch.");
  }
  return event;
}
