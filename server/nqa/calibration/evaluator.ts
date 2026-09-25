import type { NqaDecision } from "../contracts";
import { hashCanonicalJson } from "../core";
import {
  NQA_CURATION_EXPORT_VERSION,
  NqaCurationExportSchema,
  type NqaCuratedCase,
  type NqaCurationExport,
} from "../review/contracts";
import {
  NQA_CALIBRATION_VERSION,
  NqaAlignmentThresholdProfileSchema,
  NqaCalibrationReportSchema,
  type NqaAlignmentThresholdProfile,
  type NqaCalibrationCaseResult,
  type NqaCalibrationMetrics,
  type NqaCalibrationProfileReport,
  type NqaCalibrationReport,
} from "./contracts";

type EligibleCalibrationCase = {
  item: NqaCuratedCase;
  truthDecision: NqaDecision;
  originalAlignmentDecision: NqaDecision;
};

function counts(): Record<NqaDecision, number> {
  return { PASS: 0, REVIEW: 0, FAIL: 0 };
}

function matrix(): Record<NqaDecision, Record<NqaDecision, number>> {
  return {
    PASS: counts(),
    REVIEW: counts(),
    FAIL: counts(),
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function hasReplayableAlignmentEvidence(item: NqaCuratedCase): boolean {
  const scores = item.machineSnapshot.scores;
  return (
    item.machineSnapshot.stageDecisions.alignment !== null &&
    scores.sourceCoverage !== null &&
    scores.translationCoverage !== null &&
    scores.meanRerankScore !== null &&
    scores.lowScoreFraction !== null &&
    scores.sourceGapFraction !== null &&
    scores.translationGapFraction !== null
  );
}

function isHumanSettled(item: NqaCuratedCase): boolean {
  return (
    (item.reviewStatus === "CONFIRMED" || item.reviewStatus === "RESOLVED") &&
    item.finalGroundTruth?.status === "HUMAN_CONFIRMED"
  );
}

function replayAlignmentDecision(
  item: NqaCuratedCase,
  profile: NqaAlignmentThresholdProfile
): NqaDecision {
  const scores = item.machineSnapshot.scores;
  if (
    scores.sourceCoverage === null ||
    scores.translationCoverage === null ||
    scores.meanRerankScore === null ||
    scores.lowScoreFraction === null ||
    scores.sourceGapFraction === null ||
    scores.translationGapFraction === null
  ) {
    throw new Error("Alignment replay requires complete M10 score evidence.");
  }

  const threshold = profile.thresholds;
  if (
    scores.meanRerankScore >= threshold.minPassMeanScore &&
    scores.translationCoverage >= threshold.minPassTranslationCoverage &&
    scores.sourceCoverage >= threshold.minPassSourceCoverage &&
    scores.lowScoreFraction <= threshold.maxLowScoreFractionPass
  ) {
    return "PASS";
  }

  const sourceMajorGap = scores.sourceGapFraction >= threshold.majorGapFraction;
  const translationMajorGap =
    scores.translationGapFraction >= threshold.majorGapFraction;
  const scoreFail = scores.meanRerankScore < threshold.minReviewMeanScore;
  const translationCoverageFail =
    scores.translationCoverage < threshold.minReviewTranslationCoverage;
  const sourceCoverageFail =
    scores.sourceCoverage < threshold.minReviewSourceCoverage;

  return sourceMajorGap ||
    translationMajorGap ||
    scoreFail ||
    translationCoverageFail ||
    sourceCoverageFail
    ? "FAIL"
    : "REVIEW";
}

function evaluateProfile(
  cases: readonly EligibleCalibrationCase[],
  profile: NqaAlignmentThresholdProfile
): NqaCalibrationProfileReport {
  const truthCounts = counts();
  const predictedCounts = counts();
  const confusionMatrix = matrix();
  const caseResults: NqaCalibrationCaseResult[] = [];
  const falsePassCaseIds: string[] = [];
  const falseFailCaseIds: string[] = [];
  const passAgainstNonPassCaseIds: string[] = [];
  const reviewCaseIds: string[] = [];

  let exactMatchCount = 0;
  let historicalAlignmentMatchCount = 0;
  let falsePassEligibleCount = 0;
  let falseFailEligibleCount = 0;
  let passAgainstNonPassEligibleCount = 0;

  for (const entry of cases) {
    const truth = entry.truthDecision;
    const predicted = replayAlignmentDecision(entry.item, profile);

    truthCounts[truth] += 1;
    predictedCounts[predicted] += 1;
    confusionMatrix[truth][predicted] += 1;

    if (truth === predicted) exactMatchCount += 1;
    if (entry.originalAlignmentDecision === predicted) {
      historicalAlignmentMatchCount += 1;
    }

    if (truth === "FAIL") {
      falsePassEligibleCount += 1;
      if (predicted === "PASS") falsePassCaseIds.push(entry.item.caseId);
    }

    if (truth === "PASS") {
      falseFailEligibleCount += 1;
      if (predicted === "FAIL") falseFailCaseIds.push(entry.item.caseId);
    }

    if (truth !== "PASS") {
      passAgainstNonPassEligibleCount += 1;
      if (predicted === "PASS") {
        passAgainstNonPassCaseIds.push(entry.item.caseId);
      }
    }

    if (predicted === "REVIEW") reviewCaseIds.push(entry.item.caseId);

    caseResults.push({
      caseId: entry.item.caseId,
      row: entry.item.row,
      chapter: entry.item.chapter,
      truthDecision: truth,
      originalMachineDecision: entry.item.machineSnapshot.decision,
      originalAlignmentDecision: entry.originalAlignmentDecision,
      replayDecision: predicted,
    });
  }

  caseResults.sort(
    (left, right) =>
      left.row - right.row ||
      left.chapter - right.chapter ||
      left.caseId.localeCompare(right.caseId)
  );
  falsePassCaseIds.sort();
  falseFailCaseIds.sort();
  passAgainstNonPassCaseIds.sort();
  reviewCaseIds.sort();

  const metrics: NqaCalibrationMetrics = {
    evaluatedCases: cases.length,
    truthCounts,
    predictedCounts,
    exactMatchCount,
    exactMatchRate: rate(exactMatchCount, cases.length),
    historicalAlignmentMatchCount,
    historicalAlignmentMatchRate: rate(
      historicalAlignmentMatchCount,
      cases.length
    ),
    falsePassCount: falsePassCaseIds.length,
    falsePassEligibleCount,
    falsePassRate: rate(falsePassCaseIds.length, falsePassEligibleCount),
    falseFailCount: falseFailCaseIds.length,
    falseFailEligibleCount,
    falseFailRate: rate(falseFailCaseIds.length, falseFailEligibleCount),
    passAgainstNonPassCount: passAgainstNonPassCaseIds.length,
    passAgainstNonPassEligibleCount,
    passAgainstNonPassRate: rate(
      passAgainstNonPassCaseIds.length,
      passAgainstNonPassEligibleCount
    ),
    reviewCount: reviewCaseIds.length,
    reviewRate: rate(reviewCaseIds.length, cases.length),
    confusionMatrix,
  };

  return {
    profile,
    profileFingerprint: hashCanonicalJson({
      scope: "nqa:alignment-threshold-profile:v1",
      profile,
    }),
    metrics,
    falsePassCaseIds,
    falseFailCaseIds,
    passAgainstNonPassCaseIds,
    reviewCaseIds,
    cases: caseResults,
  };
}

export function runNqaAlignmentCalibration(input: {
  curationExport: NqaCurationExport;
  profiles: readonly NqaAlignmentThresholdProfile[];
}): NqaCalibrationReport {
  const source = NqaCurationExportSchema.parse(input.curationExport);
  if (source.exportVersion !== NQA_CURATION_EXPORT_VERSION) {
    throw new Error("Unsupported M14 curation export version.");
  }
  if (input.profiles.length === 0) {
    throw new Error("Calibration requires at least one threshold profile.");
  }

  const profiles = input.profiles.map(profile =>
    NqaAlignmentThresholdProfileSchema.parse(profile)
  );
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.profileId)) {
      throw new Error("Calibration profile IDs must be unique.");
    }
    profileIds.add(profile.profileId);
  }

  const requiredSourcePolicyVersion = profiles[0].sourcePolicyVersion;
  const requiredRerankerVersion = profiles[0].rerankerVersion;
  for (const profile of profiles) {
    if (
      profile.sourcePolicyVersion !== requiredSourcePolicyVersion ||
      profile.rerankerVersion !== requiredRerankerVersion
    ) {
      throw new Error(
        "All calibration profiles must share one M10 policy/reranker provenance."
      );
    }
  }

  const exclusions = {
    unresolvedOrUnsettled: 0,
    nonHumanConfirmed: 0,
    missingAlignmentEvidence: 0,
    versionMismatch: 0,
  };
  const eligible: EligibleCalibrationCase[] = [];
  let humanConfirmedCaseCount = 0;

  for (const item of source.cases) {
    if (!isHumanSettled(item)) {
      if (item.finalGroundTruth === null) {
        exclusions.unresolvedOrUnsettled += 1;
      } else {
        exclusions.nonHumanConfirmed += 1;
      }
      continue;
    }

    humanConfirmedCaseCount += 1;

    if (!hasReplayableAlignmentEvidence(item)) {
      exclusions.missingAlignmentEvidence += 1;
      continue;
    }

    if (
      item.machineSnapshot.policyVersions.alignment !==
        requiredSourcePolicyVersion ||
      item.machineSnapshot.providerVersions.reranker !== requiredRerankerVersion
    ) {
      exclusions.versionMismatch += 1;
      continue;
    }

    eligible.push({
      item,
      truthDecision: item.finalGroundTruth!.decision,
      originalAlignmentDecision: item.machineSnapshot.stageDecisions.alignment!,
    });
  }

  eligible.sort(
    (left, right) =>
      left.item.row - right.item.row ||
      left.item.chapter - right.item.chapter ||
      left.item.caseId.localeCompare(right.item.caseId)
  );

  const calibrationDatasetFingerprint = hashCanonicalJson({
    scope: "nqa:alignment-calibration-dataset:v1",
    sourceDatasetFingerprint: source.datasetFingerprint,
    requiredSourcePolicyVersion,
    requiredRerankerVersion,
    cases: eligible.map(entry => ({
      caseId: entry.item.caseId,
      row: entry.item.row,
      chapter: entry.item.chapter,
      subjectFingerprint: entry.item.subjectFingerprint,
      truthDecision: entry.truthDecision,
      originalAlignmentDecision: entry.originalAlignmentDecision,
      scores: entry.item.machineSnapshot.scores,
      alignmentPolicyVersion:
        entry.item.machineSnapshot.policyVersions.alignment,
      rerankerVersion: entry.item.machineSnapshot.providerVersions.reranker,
    })),
  });

  const profileReports = [...profiles]
    .sort((left, right) => left.profileId.localeCompare(right.profileId))
    .map(profile => evaluateProfile(eligible, profile));

  return NqaCalibrationReportSchema.parse({
    calibrationVersion: NQA_CALIBRATION_VERSION,
    sourceExportVersion: source.exportVersion,
    sourceDatasetFingerprint: source.datasetFingerprint,
    calibrationDatasetFingerprint,
    requiredSourcePolicyVersion,
    requiredRerankerVersion,
    sourceCaseCount: source.caseCount,
    humanConfirmedCaseCount,
    eligibleCaseCount: eligible.length,
    excludedCaseCount: source.caseCount - eligible.length,
    exclusions,
    eligibleCaseIds: eligible.map(entry => entry.item.caseId),
    profileReports,
  });
}
