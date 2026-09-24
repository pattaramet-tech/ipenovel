import { hashCanonicalJson } from "../core";
import {
  NQA_PROMOTION_GATE_VERSION,
  NqaCalibrationReportSchema,
  NqaPromotionCriteriaSchema,
  NqaPromotionGateSchema,
  type NqaCalibrationProfileReport,
  type NqaCalibrationReport,
  type NqaPromotionCriteria,
  type NqaPromotionFailureReason,
  type NqaPromotionGate,
} from "./contracts";

export const DEFAULT_NQA_PROMOTION_CRITERIA: NqaPromotionCriteria = {
  minEligibleCases: 50,
  minPassTruthCases: 15,
  minFailTruthCases: 10,
  requireZeroVersionMismatch: true,
  requireBaselineHistoricalReplayMatch: true,
  maxCandidateFalsePassRate: 0.02,
  maxCandidatePassAgainstNonPassRate: 0.05,
  maxFalsePassCountIncrease: 0,
  requireNoNewFalsePassCases: true,
  maxCandidateFalseFailRate: 0.1,
  maxFalseFailCountIncrease: 0,
  maxCandidateReviewRate: 0.35,
  minCandidateExactMatchRate: 0.7,
};

function findReport(
  calibration: NqaCalibrationReport,
  profileId: string
): NqaCalibrationProfileReport {
  const report = calibration.profileReports.find(
    item => item.profile.profileId === profileId
  );
  if (!report) {
    throw new Error("Calibration profile not found: " + profileId);
  }
  return report;
}

function expectedProfileFingerprint(
  report: NqaCalibrationProfileReport
): string {
  return hashCanonicalJson({
    scope: "nqa:alignment-threshold-profile:v1",
    profile: report.profile,
  });
}

function addReason(
  reasons: NqaPromotionFailureReason[],
  reason: NqaPromotionFailureReason
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function setDifference(
  left: readonly string[],
  right: readonly string[]
): string[] {
  const rightSet = new Set(right);
  return left.filter(value => !rightSet.has(value)).sort();
}

function exceeds(rate: number | null, maximum: number): boolean {
  return rate === null || rate > maximum;
}

function below(rate: number | null, minimum: number): boolean {
  return rate === null || rate < minimum;
}

export function buildNqaPromotionGate(input: {
  calibration: NqaCalibrationReport;
  baselineProfileId: string;
  candidateProfileId: string;
  criteria?: Partial<NqaPromotionCriteria>;
}): NqaPromotionGate {
  const calibration = NqaCalibrationReportSchema.parse(input.calibration);
  const criteria = NqaPromotionCriteriaSchema.parse({
    ...DEFAULT_NQA_PROMOTION_CRITERIA,
    ...input.criteria,
  });
  const baseline = findReport(calibration, input.baselineProfileId);
  const candidate = findReport(calibration, input.candidateProfileId);

  if (
    baseline.profileFingerprint !== expectedProfileFingerprint(baseline) ||
    candidate.profileFingerprint !== expectedProfileFingerprint(candidate)
  ) {
    throw new Error("Calibration profile fingerprint mismatch.");
  }

  if (
    baseline.profile.sourcePolicyVersion !==
      candidate.profile.sourcePolicyVersion ||
    baseline.profile.rerankerVersion !== candidate.profile.rerankerVersion
  ) {
    throw new Error("Baseline and candidate provenance must match.");
  }

  const failureReasons: NqaPromotionFailureReason[] = [];
  const passTruthCases = candidate.metrics.truthCounts.PASS;
  const failTruthCases = candidate.metrics.truthCounts.FAIL;
  const newlyIntroducedFalsePassCaseIds = setDifference(
    candidate.falsePassCaseIds,
    baseline.falsePassCaseIds
  );
  const resolvedFalsePassCaseIds = setDifference(
    baseline.falsePassCaseIds,
    candidate.falsePassCaseIds
  );

  if (calibration.eligibleCaseCount < criteria.minEligibleCases) {
    addReason(failureReasons, "INSUFFICIENT_ELIGIBLE_CASES");
  }
  if (passTruthCases < criteria.minPassTruthCases) {
    addReason(failureReasons, "INSUFFICIENT_PASS_TRUTH_CASES");
  }
  if (failTruthCases < criteria.minFailTruthCases) {
    addReason(failureReasons, "INSUFFICIENT_FAIL_TRUTH_CASES");
  }
  if (
    criteria.requireZeroVersionMismatch &&
    calibration.exclusions.versionMismatch > 0
  ) {
    addReason(failureReasons, "VERSION_MISMATCH_CASES_PRESENT");
  }
  if (
    criteria.requireBaselineHistoricalReplayMatch &&
    baseline.metrics.historicalAlignmentMatchRate !== 1
  ) {
    addReason(failureReasons, "BASELINE_REPLAY_MISMATCH");
  }
  if (
    exceeds(candidate.metrics.falsePassRate, criteria.maxCandidateFalsePassRate)
  ) {
    addReason(failureReasons, "CANDIDATE_FALSE_PASS_RATE_EXCEEDED");
  }
  if (
    exceeds(
      candidate.metrics.passAgainstNonPassRate,
      criteria.maxCandidatePassAgainstNonPassRate
    )
  ) {
    addReason(failureReasons, "CANDIDATE_PASS_AGAINST_NON_PASS_RATE_EXCEEDED");
  }
  if (
    candidate.metrics.falsePassCount >
    baseline.metrics.falsePassCount + criteria.maxFalsePassCountIncrease
  ) {
    addReason(failureReasons, "FALSE_PASS_COUNT_REGRESSION");
  }
  if (
    criteria.requireNoNewFalsePassCases &&
    newlyIntroducedFalsePassCaseIds.length > 0
  ) {
    addReason(failureReasons, "NEW_FALSE_PASS_CASE_INTRODUCED");
  }
  if (
    exceeds(candidate.metrics.falseFailRate, criteria.maxCandidateFalseFailRate)
  ) {
    addReason(failureReasons, "CANDIDATE_FALSE_FAIL_RATE_EXCEEDED");
  }
  if (
    candidate.metrics.falseFailCount >
    baseline.metrics.falseFailCount + criteria.maxFalseFailCountIncrease
  ) {
    addReason(failureReasons, "FALSE_FAIL_COUNT_REGRESSION");
  }
  if (exceeds(candidate.metrics.reviewRate, criteria.maxCandidateReviewRate)) {
    addReason(failureReasons, "CANDIDATE_REVIEW_RATE_EXCEEDED");
  }
  if (
    below(candidate.metrics.exactMatchRate, criteria.minCandidateExactMatchRate)
  ) {
    addReason(failureReasons, "CANDIDATE_EXACT_MATCH_RATE_BELOW_MINIMUM");
  }

  const payload = {
    promotionGateVersion: NQA_PROMOTION_GATE_VERSION,
    calibrationDatasetFingerprint: calibration.calibrationDatasetFingerprint,
    sourceDatasetFingerprint: calibration.sourceDatasetFingerprint,
    baselineProfileId: baseline.profile.profileId,
    candidateProfileId: candidate.profile.profileId,
    baselineProfile: structuredClone(baseline.profile),
    candidateProfile: structuredClone(candidate.profile),
    baselineProfileFingerprint: baseline.profileFingerprint,
    candidateProfileFingerprint: candidate.profileFingerprint,
    criteria,
    baselineMetrics: baseline.metrics,
    candidateMetrics: candidate.metrics,
    newlyIntroducedFalsePassCaseIds,
    resolvedFalsePassCaseIds,
    failureReasons,
    decision:
      failureReasons.length === 0 ? ("PROMOTE" as const) : ("HOLD" as const),
  };

  return NqaPromotionGateSchema.parse({
    ...payload,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:promotion-gate:v1",
      ...payload,
    }),
  });
}
