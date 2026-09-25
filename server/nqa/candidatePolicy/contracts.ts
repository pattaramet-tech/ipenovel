import { z } from "zod";

import {
  NqaCalibrationMetricsSchema,
  NqaPromotionCriteriaSchema,
  NqaPromotionFailureReasonSchema,
} from "../calibration/contracts";

export const NQA_CANDIDATE_POLICY_MATERIALIZATION_VERSION =
  "nqa-candidate-policy-v1" as const;
export const NQA_SHADOW_REVALIDATION_VERSION =
  "nqa-candidate-shadow-revalidation-v1" as const;
export const NQA_ACTIVATION_READINESS_VERSION =
  "nqa-activation-readiness-v1" as const;

export const NqaFullAlignmentPolicySchema = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
    targetChunkChars: z.number().int().positive(),
    maxChunkChars: z.number().int().positive(),
    denseTopK: z.number().int().positive(),
    maxRerankPairs: z.number().int().positive(),
    minPassMeanScore: z.number(),
    minPassTranslationCoverage: z.number().min(0).max(1),
    minPassSourceCoverage: z.number().min(0).max(1),
    minReviewMeanScore: z.number(),
    minReviewTranslationCoverage: z.number().min(0).max(1),
    minReviewSourceCoverage: z.number().min(0).max(1),
    majorGapFraction: z.number().min(0).max(1),
    lowScoreThreshold: z.number(),
    maxLowScoreFractionPass: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxChunkChars < value.targetChunkChars) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "maxChunkChars must be greater than or equal to targetChunkChars.",
      });
    }
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

export type NqaFullAlignmentPolicy = z.infer<
  typeof NqaFullAlignmentPolicySchema
>;

export const NqaMaterializedCandidatePolicySchema = z
  .object({
    materializationVersion: z.literal(
      NQA_CANDIDATE_POLICY_MATERIALIZATION_VERSION
    ),
    state: z.literal("INACTIVE"),
    candidatePolicyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
    sourcePolicyVersion: z.string().min(1).max(200),
    rerankerVersion: z.string().min(1).max(300),
    sourcePromotionArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCalibrationDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCandidateProfileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    basePolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    policy: NqaFullAlignmentPolicySchema,
    artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NqaMaterializedCandidatePolicy = z.infer<
  typeof NqaMaterializedCandidatePolicySchema
>;

export const NqaCandidateShadowRevalidationSchema = z
  .object({
    revalidationVersion: z.literal(NQA_SHADOW_REVALIDATION_VERSION),
    sourcePromotionArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materializedPolicyArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materializedPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    originalPromotionDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    shadowSourceDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    shadowCalibrationDatasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    datasetIsDistinctFromPromotion: z.boolean(),
    criteria: NqaPromotionCriteriaSchema,
    baselineMetrics: NqaCalibrationMetricsSchema,
    candidateMetrics: NqaCalibrationMetricsSchema,
    gateFailureReasons: z.array(NqaPromotionFailureReasonSchema),
    gateDecision: z.enum(["PROMOTE", "HOLD"]),
    artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NqaCandidateShadowRevalidation = z.infer<
  typeof NqaCandidateShadowRevalidationSchema
>;

export const NqaActivationReadinessCriteriaSchema = z
  .object({
    requireDistinctShadowDataset: z.boolean(),
    requireShadowPromote: z.boolean(),
    requireInactiveCandidate: z.boolean(),
  })
  .strict();

export type NqaActivationReadinessCriteria = z.infer<
  typeof NqaActivationReadinessCriteriaSchema
>;

export const NqaActivationReadinessFailureReasonSchema = z.enum([
  "M15_PROMOTION_NOT_PROMOTE",
  "CANDIDATE_NOT_INACTIVE",
  "SHADOW_DATASET_NOT_DISTINCT",
  "SHADOW_GATE_NOT_PROMOTE",
  "ARTIFACT_LINKAGE_MISMATCH",
]);

export type NqaActivationReadinessFailureReason = z.infer<
  typeof NqaActivationReadinessFailureReasonSchema
>;

export const NqaActivationReadinessSchema = z
  .object({
    readinessVersion: z.literal(NQA_ACTIVATION_READINESS_VERSION),
    sourcePromotionArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    materializedPolicyArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    shadowRevalidationArtifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    candidatePolicyVersion: z.string().min(1).max(200),
    candidatePolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    criteria: NqaActivationReadinessCriteriaSchema,
    shadowGateDecision: z.enum(["PROMOTE", "HOLD"]),
    shadowGateFailureReasons: z.array(NqaPromotionFailureReasonSchema),
    failureReasons: z.array(NqaActivationReadinessFailureReasonSchema),
    decision: z.enum(["READY_FOR_EXPLICIT_ACTIVATION_REVIEW", "HOLD"]),
    artifactFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type NqaActivationReadiness = z.infer<
  typeof NqaActivationReadinessSchema
>;
