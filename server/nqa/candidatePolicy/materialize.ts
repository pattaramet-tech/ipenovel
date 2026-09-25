import { hashCanonicalJson } from "../core";
import type { NqaPromotionGate } from "../calibration/contracts";
import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  NQA_CANDIDATE_POLICY_MATERIALIZATION_VERSION,
  NqaFullAlignmentPolicySchema,
  NqaMaterializedCandidatePolicySchema,
  type NqaMaterializedCandidatePolicy,
} from "./contracts";
import {
  hashNqaAlignmentPolicy,
  replayableThresholdsFromPolicy,
  verifyNqaPromotionArtifact,
} from "./integrity";

function sameThresholds(
  left: Record<string, number>,
  right: Record<string, number>
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key]
    )
  );
}

export function materializeNqaCandidatePolicy(input: {
  promotionGate: NqaPromotionGate;
  basePolicy: NqaAlignmentPolicy;
  candidatePolicyVersion?: string;
}): NqaMaterializedCandidatePolicy {
  const promotion = verifyNqaPromotionArtifact(input.promotionGate);
  if (promotion.decision !== "PROMOTE" || promotion.failureReasons.length > 0) {
    throw new Error("M16 requires an M15 PROMOTE artifact.");
  }

  const basePolicy = NqaFullAlignmentPolicySchema.parse(input.basePolicy);
  if (
    basePolicy.version !== promotion.baselineProfile.sourcePolicyVersion ||
    basePolicy.version !== promotion.candidateProfile.sourcePolicyVersion
  ) {
    throw new Error("M16 base policy version does not match M15 provenance.");
  }

  const baseThresholds = replayableThresholdsFromPolicy(basePolicy);
  if (!sameThresholds(baseThresholds, promotion.baselineProfile.thresholds)) {
    throw new Error(
      "M16 base policy thresholds do not match the M15 baseline profile."
    );
  }

  const candidatePolicyVersion =
    input.candidatePolicyVersion ??
    `nqa-alignment-candidate-${promotion.candidateProfileFingerprint.slice(
      0,
      12
    )}`;
  if (candidatePolicyVersion === basePolicy.version) {
    throw new Error("M16 candidate policy version must be new.");
  }

  const policy = NqaFullAlignmentPolicySchema.parse({
    ...basePolicy,
    ...promotion.candidateProfile.thresholds,
    version: candidatePolicyVersion,
  });

  const payload = {
    materializationVersion: NQA_CANDIDATE_POLICY_MATERIALIZATION_VERSION,
    state: "INACTIVE" as const,
    candidatePolicyVersion,
    sourcePolicyVersion: basePolicy.version,
    rerankerVersion: promotion.candidateProfile.rerankerVersion,
    sourcePromotionArtifactFingerprint: promotion.artifactFingerprint,
    sourceCalibrationDatasetFingerprint:
      promotion.calibrationDatasetFingerprint,
    sourceCandidateProfileFingerprint: promotion.candidateProfileFingerprint,
    basePolicyFingerprint: hashNqaAlignmentPolicy(basePolicy),
    policyFingerprint: hashNqaAlignmentPolicy(policy),
    policy,
  };

  const artifact = NqaMaterializedCandidatePolicySchema.parse({
    ...payload,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:candidate-policy-materialization:v1",
      ...payload,
    }),
  });
  Object.freeze(artifact.policy);
  Object.freeze(artifact);
  return artifact;
}
