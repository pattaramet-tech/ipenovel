import { hashCanonicalJson } from "../core";
import {
  buildNqaPromotionGate,
  runNqaAlignmentCalibration,
} from "../calibration";
import type {
  NqaAlignmentThresholdProfile,
  NqaPromotionGate,
} from "../calibration/contracts";
import type { NqaCurationExport } from "../review/contracts";
import {
  NQA_SHADOW_REVALIDATION_VERSION,
  NqaCandidateShadowRevalidationSchema,
  type NqaCandidateShadowRevalidation,
  type NqaMaterializedCandidatePolicy,
} from "./contracts";
import {
  replayableThresholdsFromPolicy,
  verifyMaterializedCandidateArtifact,
  verifyNqaCurationExportArtifact,
  verifyNqaPromotionArtifact,
} from "./integrity";

function candidateReplayProfile(input: {
  promotion: NqaPromotionGate;
  materialized: NqaMaterializedCandidatePolicy;
}): NqaAlignmentThresholdProfile {
  return {
    profileId: input.promotion.candidateProfileId,
    sourcePolicyVersion: input.materialized.sourcePolicyVersion,
    rerankerVersion: input.materialized.rerankerVersion,
    thresholds: replayableThresholdsFromPolicy(input.materialized.policy),
  };
}

export function revalidateNqaCandidatePolicy(input: {
  promotionGate: NqaPromotionGate;
  materializedPolicy: NqaMaterializedCandidatePolicy;
  curationExport: NqaCurationExport;
}): NqaCandidateShadowRevalidation {
  const promotion = verifyNqaPromotionArtifact(input.promotionGate);
  if (promotion.decision !== "PROMOTE" || promotion.failureReasons.length > 0) {
    throw new Error(
      "M16 shadow revalidation requires an M15 PROMOTE artifact."
    );
  }

  const materialized = verifyMaterializedCandidateArtifact(
    input.materializedPolicy
  );
  if (
    materialized.sourcePromotionArtifactFingerprint !==
      promotion.artifactFingerprint ||
    materialized.sourceCandidateProfileFingerprint !==
      promotion.candidateProfileFingerprint ||
    materialized.sourceCalibrationDatasetFingerprint !==
      promotion.calibrationDatasetFingerprint
  ) {
    throw new Error(
      "M16 materialized candidate does not belong to M15 promotion."
    );
  }

  const source = verifyNqaCurationExportArtifact(input.curationExport);
  const candidateProfile = candidateReplayProfile({
    promotion,
    materialized,
  });
  const candidateProfileFingerprint = hashCanonicalJson({
    scope: "nqa:alignment-threshold-profile:v1",
    profile: candidateProfile,
  });
  if (candidateProfileFingerprint !== promotion.candidateProfileFingerprint) {
    throw new Error(
      "M16 materialized candidate thresholds do not match M15 promotion."
    );
  }

  const calibration = runNqaAlignmentCalibration({
    curationExport: source,
    profiles: [promotion.baselineProfile, candidateProfile],
  });
  const gate = buildNqaPromotionGate({
    calibration,
    baselineProfileId: promotion.baselineProfileId,
    candidateProfileId: promotion.candidateProfileId,
    criteria: promotion.criteria,
  });

  const payload = {
    revalidationVersion: NQA_SHADOW_REVALIDATION_VERSION,
    sourcePromotionArtifactFingerprint: promotion.artifactFingerprint,
    materializedPolicyArtifactFingerprint: materialized.artifactFingerprint,
    materializedPolicyFingerprint: materialized.policyFingerprint,
    originalPromotionDatasetFingerprint: promotion.sourceDatasetFingerprint,
    shadowSourceDatasetFingerprint: source.datasetFingerprint,
    shadowCalibrationDatasetFingerprint:
      calibration.calibrationDatasetFingerprint,
    datasetIsDistinctFromPromotion:
      source.datasetFingerprint !== promotion.sourceDatasetFingerprint,
    criteria: promotion.criteria,
    baselineMetrics: gate.baselineMetrics,
    candidateMetrics: gate.candidateMetrics,
    gateFailureReasons: gate.failureReasons,
    gateDecision: gate.decision,
  };

  return NqaCandidateShadowRevalidationSchema.parse({
    ...payload,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:candidate-shadow-revalidation:v1",
      ...payload,
    }),
  });
}
