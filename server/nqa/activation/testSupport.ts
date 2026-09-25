import { buildNqaActivationReadiness } from "../candidatePolicy/readiness";
import { materializeNqaCandidatePolicy } from "../candidatePolicy/materialize";
import { revalidateNqaCandidatePolicy } from "../candidatePolicy/revalidate";
import {
  BASE_POLICY,
  buildPromotedFixture,
  makeSignedCurationExport,
} from "../candidatePolicy/testSupport";
import { buildNqaHumanPolicyAuthorization } from "./integrity";
import type {
  NqaActivationAuthorization,
  NqaRollbackAuthorization,
} from "./contracts";
import type { NqaPolicyActivationStore } from "./store";

export { BASE_POLICY };

export function buildReadyActivationFixture() {
  const { promotionGate } = buildPromotedFixture();
  const materializedPolicy = materializeNqaCandidatePolicy({
    promotionGate,
    basePolicy: BASE_POLICY,
  });
  const shadowRevalidation = revalidateNqaCandidatePolicy({
    promotionGate,
    materializedPolicy,
    curationExport: makeSignedCurationExport({
      runId: "m17-fresh-shadow",
    }),
  });
  const readiness = buildNqaActivationReadiness({
    promotionGate,
    materializedPolicy,
    shadowRevalidation,
  });
  if (readiness.decision !== "READY_FOR_EXPLICIT_ACTIVATION_REVIEW") {
    throw new Error("M17 test fixture expected M16 activation readiness.");
  }
  return {
    promotionGate,
    materializedPolicy,
    shadowRevalidation,
    readiness,
  };
}

export async function buildActivationAuthorization(input: {
  store: NqaPolicyActivationStore;
  readinessFingerprint: string;
  targetPolicyFingerprint: string;
  authorizationId?: string;
  authorizerId?: string;
  approvedAt?: string;
  validUntil?: string;
}): Promise<NqaActivationAuthorization> {
  const state = await input.store.readState();
  return buildNqaHumanPolicyAuthorization({
    authorizationId: input.authorizationId ?? "approve-activation-001",
    authorizerId: input.authorizerId ?? "human-reviewer-a",
    action: "ACTIVATE",
    approvalStatement: "I_APPROVE_NQA_POLICY_ACTIVATION",
    expectedRegistryRevision: state.revision,
    expectedActivePolicyFingerprint: state.activePolicyFingerprint,
    targetPolicyFingerprint: input.targetPolicyFingerprint,
    readinessArtifactFingerprint: input.readinessFingerprint,
    sourceActivationTransactionId: null,
    approvedAt: input.approvedAt ?? "2026-09-24T22:00:00+07:00",
    validUntil: input.validUntil ?? "2026-09-24T22:10:00+07:00",
  }) as NqaActivationAuthorization;
}

export async function buildRollbackAuthorization(input: {
  store: NqaPolicyActivationStore;
  sourceActivationTransactionId: string;
  targetPolicyFingerprint: string;
  authorizationId?: string;
  authorizerId?: string;
  approvedAt?: string;
  validUntil?: string;
}): Promise<NqaRollbackAuthorization> {
  const state = await input.store.readState();
  return buildNqaHumanPolicyAuthorization({
    authorizationId: input.authorizationId ?? "approve-rollback-001",
    authorizerId: input.authorizerId ?? "human-reviewer-a",
    action: "ROLLBACK",
    approvalStatement: "I_APPROVE_NQA_POLICY_ROLLBACK",
    expectedRegistryRevision: state.revision,
    expectedActivePolicyFingerprint: state.activePolicyFingerprint,
    targetPolicyFingerprint: input.targetPolicyFingerprint,
    readinessArtifactFingerprint: null,
    sourceActivationTransactionId: input.sourceActivationTransactionId,
    approvedAt: input.approvedAt ?? "2026-09-24T22:02:00+07:00",
    validUntil: input.validUntil ?? "2026-09-24T22:12:00+07:00",
  }) as NqaRollbackAuthorization;
}
