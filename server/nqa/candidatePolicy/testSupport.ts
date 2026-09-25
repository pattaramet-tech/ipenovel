import { hashCanonicalJson } from "../core";
import {
  buildNqaPromotionGate,
  runNqaAlignmentCalibration,
  type NqaAlignmentThresholdProfile,
  type NqaPromotionGate,
} from "../calibration";
import {
  BASELINE_PROFILE,
  TEST_POLICY_VERSION,
  TEST_RERANKER_VERSION,
  makeCuratedCase,
} from "../calibration/testSupport";
import type { NqaCurationExport, NqaCuratedCase } from "../review/contracts";
import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";

export {
  BASELINE_PROFILE,
  TEST_POLICY_VERSION,
  TEST_RERANKER_VERSION,
  makeCuratedCase,
};

export const BASE_POLICY: NqaAlignmentPolicy = {
  version: TEST_POLICY_VERSION,
  targetChunkChars: 1200,
  maxChunkChars: 1800,
  denseTopK: 4,
  maxRerankPairs: 160,
  minPassMeanScore: 0.7,
  minPassTranslationCoverage: 0.85,
  minPassSourceCoverage: 0.8,
  minReviewMeanScore: 0.45,
  minReviewTranslationCoverage: 0.6,
  minReviewSourceCoverage: 0.55,
  majorGapFraction: 0.3,
  lowScoreThreshold: 0.45,
  maxLowScoreFractionPass: 0.3,
};

export const SAFE_CANDIDATE_PROFILE: NqaAlignmentThresholdProfile = {
  ...BASELINE_PROFILE,
  profileId: "candidate-safe",
  thresholds: {
    ...BASELINE_PROFILE.thresholds,
    minPassMeanScore: 0.75,
  },
};

export const STRICT_TEST_CRITERIA = {
  minEligibleCases: 4,
  minPassTruthCases: 2,
  minFailTruthCases: 2,
  requireZeroVersionMismatch: true,
  requireBaselineHistoricalReplayMatch: true,
  maxCandidateFalsePassRate: 0,
  maxCandidatePassAgainstNonPassRate: 0,
  maxFalsePassCountIncrease: 0,
  requireNoNewFalsePassCases: true,
  maxCandidateFalseFailRate: 0,
  maxFalseFailCountIncrease: 0,
  maxCandidateReviewRate: 0,
  minCandidateExactMatchRate: 1,
};

export function balancedCases(): NqaCuratedCase[] {
  return [
    makeCuratedCase({
      caseId: "pass-a",
      row: 1,
      truth: "PASS",
      meanRerankScore: 0.85,
      sourceCoverage: 0.95,
      translationCoverage: 0.95,
    }),
    makeCuratedCase({
      caseId: "pass-b",
      row: 2,
      truth: "PASS",
      meanRerankScore: 0.82,
      sourceCoverage: 0.9,
      translationCoverage: 0.9,
    }),
    makeCuratedCase({
      caseId: "fail-a",
      row: 3,
      truth: "FAIL",
      meanRerankScore: 0.3,
      sourceCoverage: 0.4,
      translationCoverage: 0.4,
      sourceGapFraction: 0.6,
      translationGapFraction: 0.6,
    }),
    makeCuratedCase({
      caseId: "fail-b",
      row: 4,
      truth: "FAIL",
      meanRerankScore: 0.35,
      sourceCoverage: 0.45,
      translationCoverage: 0.45,
      sourceGapFraction: 0.55,
      translationGapFraction: 0.55,
    }),
  ];
}

export function makeSignedCurationExport(input: {
  cases?: NqaCuratedCase[];
  runId: string;
  batchSeed?: string;
}): NqaCurationExport {
  const cases = input.cases ?? balancedCases();
  const finalLabelCount = cases.filter(
    item => item.finalGroundTruth !== null
  ).length;
  const payload = {
    exportVersion: "nqa-curation-export-v1" as const,
    runId: input.runId,
    batchFingerprint: hashCanonicalJson({
      scope: "nqa:test-batch:v1",
      seed: input.batchSeed ?? input.runId,
    }),
    caseCount: cases.length,
    finalLabelCount,
    unresolvedCount: cases.length - finalLabelCount,
    cases,
  };
  return {
    ...payload,
    datasetFingerprint: hashCanonicalJson({
      scope: "nqa:curation-export:v1",
      ...payload,
    }),
  };
}

export function buildPromotedFixture(): {
  promotionGate: NqaPromotionGate;
  promotionExport: NqaCurationExport;
} {
  const promotionExport = makeSignedCurationExport({
    runId: "m15-original",
  });
  const calibration = runNqaAlignmentCalibration({
    curationExport: promotionExport,
    profiles: [BASELINE_PROFILE, SAFE_CANDIDATE_PROFILE],
  });
  const promotionGate = buildNqaPromotionGate({
    calibration,
    baselineProfileId: BASELINE_PROFILE.profileId,
    candidateProfileId: SAFE_CANDIDATE_PROFILE.profileId,
    criteria: STRICT_TEST_CRITERIA,
  });
  if (promotionGate.decision !== "PROMOTE") {
    throw new Error("Test fixture expected a PROMOTE gate.");
  }
  return { promotionGate, promotionExport };
}
