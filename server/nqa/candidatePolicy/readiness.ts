import { hashCanonicalJson } from "../core";
import type { NqaPromotionGate } from "../calibration/contracts";
import {
  NQA_ACTIVATION_READINESS_VERSION,
  NqaActivationReadinessCriteriaSchema,
  NqaActivationReadinessSchema,
  NqaCandidateShadowRevalidationSchema,
  type NqaActivationReadiness,
  type NqaActivationReadinessCriteria,
  type NqaActivationReadinessFailureReason,
  type NqaCandidateShadowRevalidation,
  type NqaMaterializedCandidatePolicy,
} from "./contracts";
import {
  verifyMaterializedCandidateArtifact,
  verifyNqaPromotionArtifact,
} from "./integrity";

export const DEFAULT_NQA_ACTIVATION_READINESS_CRITERIA =
  Object.freeze<NqaActivationReadinessCriteria>({
    requireDistinctShadowDataset: true,
    requireShadowPromote: true,
    requireInactiveCandidate: true,
  });

function verifyShadowArtifact(
  input: NqaCandidateShadowRevalidation
): NqaCandidateShadowRevalidation {
  const shadow = NqaCandidateShadowRevalidationSchema.parse(input);
  const { artifactFingerprint, ...payload } = shadow;
  const expected = hashCanonicalJson({
    scope: "nqa:candidate-shadow-revalidation:v1",
    ...payload,
  });
  if (artifactFingerprint !== expected) {
    throw new Error("M16 shadow revalidation artifact fingerprint mismatch.");
  }
  return shadow;
}

function addReason(
  reasons: NqaActivationReadinessFailureReason[],
  reason: NqaActivationReadinessFailureReason
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function buildNqaActivationReadiness(input: {
  promotionGate: NqaPromotionGate;
  materializedPolicy: NqaMaterializedCandidatePolicy;
  shadowRevalidation: NqaCandidateShadowRevalidation;
}): NqaActivationReadiness {
  const promotion = verifyNqaPromotionArtifact(input.promotionGate);
  const materialized = verifyMaterializedCandidateArtifact(
    input.materializedPolicy
  );
  const shadow = verifyShadowArtifact(input.shadowRevalidation);
  const criteria = NqaActivationReadinessCriteriaSchema.parse(
    DEFAULT_NQA_ACTIVATION_READINESS_CRITERIA
  );

  const failureReasons: NqaActivationReadinessFailureReason[] = [];
  const linkageMatches =
    materialized.sourcePromotionArtifactFingerprint ===
      promotion.artifactFingerprint &&
    shadow.sourcePromotionArtifactFingerprint ===
      promotion.artifactFingerprint &&
    shadow.materializedPolicyArtifactFingerprint ===
      materialized.artifactFingerprint &&
    shadow.materializedPolicyFingerprint === materialized.policyFingerprint;

  if (!linkageMatches) {
    addReason(failureReasons, "ARTIFACT_LINKAGE_MISMATCH");
  }
  if (promotion.decision !== "PROMOTE" || promotion.failureReasons.length > 0) {
    addReason(failureReasons, "M15_PROMOTION_NOT_PROMOTE");
  }
  if (criteria.requireInactiveCandidate && materialized.state !== "INACTIVE") {
    addReason(failureReasons, "CANDIDATE_NOT_INACTIVE");
  }
  if (
    criteria.requireDistinctShadowDataset &&
    !shadow.datasetIsDistinctFromPromotion
  ) {
    addReason(failureReasons, "SHADOW_DATASET_NOT_DISTINCT");
  }
  if (criteria.requireShadowPromote && shadow.gateDecision !== "PROMOTE") {
    addReason(failureReasons, "SHADOW_GATE_NOT_PROMOTE");
  }

  const payload = {
    readinessVersion: NQA_ACTIVATION_READINESS_VERSION,
    sourcePromotionArtifactFingerprint: promotion.artifactFingerprint,
    materializedPolicyArtifactFingerprint: materialized.artifactFingerprint,
    shadowRevalidationArtifactFingerprint: shadow.artifactFingerprint,
    candidatePolicyVersion: materialized.candidatePolicyVersion,
    candidatePolicyFingerprint: materialized.policyFingerprint,
    criteria,
    shadowGateDecision: shadow.gateDecision,
    shadowGateFailureReasons: shadow.gateFailureReasons,
    failureReasons,
    decision:
      failureReasons.length === 0
        ? ("READY_FOR_EXPLICIT_ACTIVATION_REVIEW" as const)
        : ("HOLD" as const),
  };

  return NqaActivationReadinessSchema.parse({
    ...payload,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:activation-readiness:v1",
      ...payload,
    }),
  });
}
