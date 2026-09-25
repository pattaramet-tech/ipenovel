import { z } from "zod";

import { NqaDecisionSchema } from "../contracts";
import { NqaShadowCaseIdSchema } from "../shadow/contracts";

export const NQA_CALIBRATION_VERSION = "nqa-calibration-v1" as const;
export const NQA_PROMOTION_GATE_VERSION = "nqa-promotion-gate-v1" as const;

export const NqaReplayableAlignmentThresholdsSchema = z
  .object({
    minPassMeanScore: z.number(),
    minPassTranslationCoverage: z.number().min(0).max(1),
    minPassSourceCoverage: z.number().min(0).max(1),
    minReviewMeanScore: z.number(),
    minReviewTranslationCoverage: z.number().min(0).max(1),
    minReviewSourceCoverage: z.number().min(0).max(1),
    majorGapFraction: z.number().min(0).max(1),
    maxLowScoreFractionPass: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minReviewMeanScore > value.minPassMeanScore) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minReviewMeanScore must not exceed minPassMeanScore.",
      });
    }
    if (value.minReviewTranslationCoverage > value.minPassTranslationCoverage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "minReviewTranslationCoverage must not exceed minPassTranslationCoverage.",
      });
    }
    if (value.minReviewSourceCoverage > value.minPassSourceCoverage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "minReviewSourceCoverage must not exceed minPassSourceCoverage.",
      });
    }
  });

export type NqaReplayableAlignmentThresholds = z.infer<
  typeof NqaReplayableAlignmentThresholdsSchema
>;

export const NqaAlignmentThresholdProfileSchema = z
  .object({
    profileId: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
    sourcePolicyVersion: z.string().min(1).max(200),
    rerankerVersion: z.string().min(1).max(300),
    thresholds: NqaReplayableAlignmentThresholdsSchema,
  })
  .strict();

export type NqaAlignmentThresholdProfile = z.infer<
  typeof NqaAlignmentThresholdProfileSchema
>;

export const NqaCalibrationConfusionMatrixSchema = z.record(
  NqaDecisionSchema,
  z.record(NqaDecisionSchema, z.number().int().nonnegative())
);

export const NqaCalibrationMetricsSchema = z
  .object({
    evaluatedCases: z.number().int().nonnegative(),
    truthCounts: z.record(NqaDecisionSchema, z.number().int().nonnegative()),
    predictedCounts: z.record(
      NqaDecisionSchema,
      z.number().int().nonnegative()
    ),
    exactMatchCount: z.number().int().nonnegative(),
    exactMatchRate: z.number().min(0).max(1).nullable(),
    historicalAlignmentMatchCount: z.number().int().nonnegative(),
    historicalAlignmentMatchRate: z.number().min(0).max(1).nullable(),
    falsePassCount: z.number().int().nonnegative(),
    falsePassEligibleCount: z.number().int().nonnegative(),
    falsePassRate: z.number().min(0).max(1).nullable(),
    falseFailCount: z.number().int().nonnegative(),
    falseFailEligibleCount: z.number().int().nonnegative(),
    falseFailRate: z.number().min(0).max(1).nullable(),
    passAgainstNonPassCount: z.number().int().nonnegative(),
    passAgainstNonPassEligibleCount: z.number().int().nonnegative(),
    passAgainstNonPassRate: z.number().min(0).max(1).nullable(),
    reviewCount: z.number().int().nonnegative(),
    reviewRate: z.number().min(0).max(1).nullable(),
    confusionMatrix: NqaCalibrationConfusionMatrixSchema,
  })
  .strict();

export type NqaCalibrationMetrics = z.infer<typeof NqaCalibrationMetricsSchema>;

export const NqaCalibrationCaseResultSchema = z
  .object({
    caseId: NqaShadowCaseIdSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    truthDecision: NqaDecisionSchema,
    originalMachineDecision: NqaDecisionSchema,
    originalAlignmentDecision: NqaDecisionSchema,
    replayDecision: NqaDecisionSchema,
  })
  .strict();

export type NqaCalibrationCaseResult = z.infer<
  typeof NqaCalibrationCaseResultSchema
>;

export const NqaCalibrationProfileReportSchema = z
  .object({
    profile: NqaAlignmentThresholdProfileSchema,
    profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    metrics: NqaCalibrationMetricsSchema,
    falsePassCaseIds: z.array(NqaShadowCaseIdSchema),
    falseFailCaseIds: z.array(NqaShadowCaseIdSchema),
    passAgainstNonPassCaseIds: z.array(NqaShadowCaseIdSchema),
    reviewCaseIds: z.array(NqaShadowCaseIdSchema),
    cases: z.array(NqaCalibrationCaseResultSchema),
  })
  .strict();

export type NqaCalibrationProfileReport = z.infer<
  typeof NqaCalibrationProfileReportSchema
>;

export const NqaCalibrationExclusionCountsSchema = z
  .object({
    unresolvedOrUnsettled: z.number().int().nonnegative(),
    nonHumanConfirmed: z.number().int().nonnegative(),
    missingAlignmentEvidence: z.number().int().nonnegative(),
    versionMismatch: z.number().int().nonnegative(),
  })
  .strict();

export const NqaCalibrationReportSchema = z
  .object({
    calibrationVersion: z.literal(NQA_CALIBRATION_VERSION),
    sourceExportVersion: z.string().min(1).max(200),
    sourceDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    calibrationDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    requiredSourcePolicyVersion: z.string().min(1).max(200),
    requiredRerankerVersion: z.string().min(1).max(300),
    sourceCaseCount: z.number().int().nonnegative(),
    humanConfirmedCaseCount: z.number().int().nonnegative(),
    eligibleCaseCount: z.number().int().nonnegative(),
    excludedCaseCount: z.number().int().nonnegative(),
    exclusions: NqaCalibrationExclusionCountsSchema,
    eligibleCaseIds: z.array(NqaShadowCaseIdSchema),
    profileReports: z.array(NqaCalibrationProfileReportSchema).min(1),
  })
  .strict();

export type NqaCalibrationReport = z.infer<typeof NqaCalibrationReportSchema>;

export const NqaPromotionCriteriaSchema = z
  .object({
    minEligibleCases: z.number().int().positive(),
    minPassTruthCases: z.number().int().nonnegative(),
    minFailTruthCases: z.number().int().nonnegative(),
    requireZeroVersionMismatch: z.boolean(),
    requireBaselineHistoricalReplayMatch: z.boolean(),
    maxCandidateFalsePassRate: z.number().min(0).max(1),
    maxCandidatePassAgainstNonPassRate: z.number().min(0).max(1),
    maxFalsePassCountIncrease: z.number().int().nonnegative(),
    requireNoNewFalsePassCases: z.boolean(),
    maxCandidateFalseFailRate: z.number().min(0).max(1),
    maxFalseFailCountIncrease: z.number().int().nonnegative(),
    maxCandidateReviewRate: z.number().min(0).max(1),
    minCandidateExactMatchRate: z.number().min(0).max(1),
  })
  .strict();

export type NqaPromotionCriteria = z.infer<typeof NqaPromotionCriteriaSchema>;

export const NqaPromotionFailureReasonSchema = z.enum([
  "INSUFFICIENT_ELIGIBLE_CASES",
  "INSUFFICIENT_PASS_TRUTH_CASES",
  "INSUFFICIENT_FAIL_TRUTH_CASES",
  "VERSION_MISMATCH_CASES_PRESENT",
  "BASELINE_REPLAY_MISMATCH",
  "CANDIDATE_FALSE_PASS_RATE_EXCEEDED",
  "CANDIDATE_PASS_AGAINST_NON_PASS_RATE_EXCEEDED",
  "FALSE_PASS_COUNT_REGRESSION",
  "NEW_FALSE_PASS_CASE_INTRODUCED",
  "CANDIDATE_FALSE_FAIL_RATE_EXCEEDED",
  "FALSE_FAIL_COUNT_REGRESSION",
  "CANDIDATE_REVIEW_RATE_EXCEEDED",
  "CANDIDATE_EXACT_MATCH_RATE_BELOW_MINIMUM",
]);
export type NqaPromotionFailureReason = z.infer<
  typeof NqaPromotionFailureReasonSchema
>;

export const NqaPromotionGateSchema = z
  .object({
    promotionGateVersion: z.literal(NQA_PROMOTION_GATE_VERSION),
    calibrationDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    baselineProfileId: z.string().min(1).max(120),
    candidateProfileId: z.string().min(1).max(120),
    baselineProfile: NqaAlignmentThresholdProfileSchema,
    candidateProfile: NqaAlignmentThresholdProfileSchema,
    baselineProfileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    candidateProfileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    criteria: NqaPromotionCriteriaSchema,
    baselineMetrics: NqaCalibrationMetricsSchema,
    candidateMetrics: NqaCalibrationMetricsSchema,
    newlyIntroducedFalsePassCaseIds: z.array(NqaShadowCaseIdSchema),
    resolvedFalsePassCaseIds: z.array(NqaShadowCaseIdSchema),
    failureReasons: z.array(NqaPromotionFailureReasonSchema),
    decision: z.enum(["PROMOTE", "HOLD"]),
    artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NqaPromotionGate = z.infer<typeof NqaPromotionGateSchema>;
