import { hashCanonicalJson } from "../core";
import {
  NqaPromotionGateSchema,
  type NqaAlignmentThresholdProfile,
  type NqaPromotionGate,
} from "../calibration/contracts";
import {
  NqaCurationExportSchema,
  type NqaCurationExport,
} from "../review/contracts";
import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  NqaMaterializedCandidatePolicySchema,
  type NqaMaterializedCandidatePolicy,
} from "./contracts";

export function replayableThresholdsFromPolicy(
  policy: NqaAlignmentPolicy
): NqaAlignmentThresholdProfile["thresholds"] {
  return {
    minPassMeanScore: policy.minPassMeanScore,
    minPassTranslationCoverage: policy.minPassTranslationCoverage,
    minPassSourceCoverage: policy.minPassSourceCoverage,
    minReviewMeanScore: policy.minReviewMeanScore,
    minReviewTranslationCoverage: policy.minReviewTranslationCoverage,
    minReviewSourceCoverage: policy.minReviewSourceCoverage,
    majorGapFraction: policy.majorGapFraction,
    maxLowScoreFractionPass: policy.maxLowScoreFractionPass,
  };
}

export function hashNqaAlignmentPolicy(policy: NqaAlignmentPolicy): string {
  return hashCanonicalJson({
    scope: "nqa:alignment-policy-artifact:v1",
    policy,
  });
}

export function verifyNqaPromotionArtifact(
  input: NqaPromotionGate
): NqaPromotionGate {
  const promotion = NqaPromotionGateSchema.parse(input);
  const { artifactFingerprint, ...payload } = promotion;
  const expectedArtifactFingerprint = hashCanonicalJson({
    scope: "nqa:promotion-gate:v1",
    ...payload,
  });
  if (artifactFingerprint !== expectedArtifactFingerprint) {
    throw new Error("M15 promotion artifact fingerprint mismatch.");
  }

  const baselineProfileFingerprint = hashCanonicalJson({
    scope: "nqa:alignment-threshold-profile:v1",
    profile: promotion.baselineProfile,
  });
  const candidateProfileFingerprint = hashCanonicalJson({
    scope: "nqa:alignment-threshold-profile:v1",
    profile: promotion.candidateProfile,
  });
  if (
    baselineProfileFingerprint !== promotion.baselineProfileFingerprint ||
    candidateProfileFingerprint !== promotion.candidateProfileFingerprint
  ) {
    throw new Error("M15 promotion profile fingerprint mismatch.");
  }

  return promotion;
}

export function verifyNqaCurationExportArtifact(
  input: NqaCurationExport
): NqaCurationExport {
  const source = NqaCurationExportSchema.parse(input);
  const { datasetFingerprint, ...payload } = source;
  const expected = hashCanonicalJson({
    scope: "nqa:curation-export:v1",
    ...payload,
  });
  if (datasetFingerprint !== expected) {
    throw new Error("M14 curation export fingerprint mismatch.");
  }
  return source;
}

export function verifyMaterializedCandidateArtifact(
  input: NqaMaterializedCandidatePolicy
): NqaMaterializedCandidatePolicy {
  const materialized = NqaMaterializedCandidatePolicySchema.parse(input);
  if (
    materialized.policy.version !== materialized.candidatePolicyVersion ||
    materialized.policyFingerprint !==
      hashNqaAlignmentPolicy(materialized.policy)
  ) {
    throw new Error("M16 materialized candidate policy fingerprint mismatch.");
  }

  const { artifactFingerprint, ...payload } = materialized;
  const expected = hashCanonicalJson({
    scope: "nqa:candidate-policy-materialization:v1",
    ...payload,
  });
  if (artifactFingerprint !== expected) {
    throw new Error("M16 materialization artifact fingerprint mismatch.");
  }
  return materialized;
}
