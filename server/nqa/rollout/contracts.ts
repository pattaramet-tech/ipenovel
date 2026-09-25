import { z } from "zod";

import { NqaFullAlignmentPolicySchema } from "../candidatePolicy/contracts";

export const NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION =
  "nqa-controlled-rollout-scope-v1" as const;
export const NQA_DUAL_RUN_RECORD_VERSION = "nqa-dual-run-record-v1" as const;

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,160}$/);

export const NqaRolloutTargetSchema = z
  .object({
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
  })
  .strict();

export const NqaControlledRolloutScopeSchema = z
  .object({
    scopeVersion: z.literal(NQA_CONTROLLED_ROLLOUT_SCOPE_VERSION),
    scopeId: IdSchema,
    approvedBy: z.string().min(1).max(200),
    approvalStatement: z.literal("I_APPROVE_NQA_CONTROLLED_ROLLOUT_SCOPE"),
    approvedAt: z.string().min(1).max(100),
    sourceActivationTransactionId: IdSchema,
    expectedRegistryRevision: z.number().int().positive(),
    expectedRegistryStateFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    baselinePolicyFingerprint: FingerprintSchema,
    targets: z.array(NqaRolloutTargetSchema).min(1).max(100),
    scopeFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaControlledRolloutScope = z.infer<
  typeof NqaControlledRolloutScopeSchema
>;

export const NqaRuntimePolicyResolutionSchema = z
  .object({
    mode: z.enum([
      "BASELINE_ONLY",
      "CONTROLLED_CANDIDATE",
      "ROLLED_BACK_BASELINE",
    ]),
    selectedPolicy: z.enum(["BASELINE", "CANDIDATE"]),
    inScope: z.boolean(),
    dualRun: z.boolean(),
    registryRevision: z.number().int().nonnegative(),
    registryStateFingerprint: FingerprintSchema,
    sourceActivationTransactionId: IdSchema.nullable(),
    baselinePolicyFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema.nullable(),
    primaryPolicy: NqaFullAlignmentPolicySchema,
    baselinePolicy: NqaFullAlignmentPolicySchema,
    candidatePolicy: NqaFullAlignmentPolicySchema.nullable(),
    scopeId: IdSchema.nullable(),
    scopeFingerprint: FingerprintSchema.nullable(),
  })
  .strict();

export type NqaRuntimePolicyResolution = z.infer<
  typeof NqaRuntimePolicyResolutionSchema
>;

const NqaMonitoredSemanticSnapshotSchema = z
  .object({
    decision: z.enum(["PASS", "REVIEW", "FAIL"]),
    reasonCodes: z.array(z.string().min(1).max(100)).max(30),
    alignment: z
      .object({
        decision: z.enum(["PASS", "REVIEW", "FAIL"]),
        reasonCodes: z.array(z.string().min(1).max(100)).max(30),
        policyVersion: z.string().min(1).max(200),
        providerId: z.string().min(1).max(200),
        modelVersion: z.string().min(1).max(300),
        metrics: z
          .object({
            alignedPairCount: z.number().int().nonnegative(),
            sourceCoverage: z.number(),
            translationCoverage: z.number(),
            meanRerankScore: z.number().nullable(),
            minRerankScore: z.number().nullable(),
            lowScoreFraction: z.number(),
            sourceGapFraction: z.number(),
            translationGapFraction: z.number(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const NqaDualRunMonitoringRecordSchema = z
  .object({
    recordVersion: z.literal(NQA_DUAL_RUN_RECORD_VERSION),
    recordId: IdSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    scopeId: IdSchema,
    scopeFingerprint: FingerprintSchema,
    registryRevision: z.number().int().positive(),
    registryStateFingerprint: FingerprintSchema,
    sourceActivationTransactionId: IdSchema,
    baselinePolicyFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    baseline: NqaMonitoredSemanticSnapshotSchema,
    candidate: NqaMonitoredSemanticSnapshotSchema,
    comparison: z
      .object({
        decisionChanged: z.boolean(),
        candidateMorePermissive: z.boolean(),
        candidateMoreStrict: z.boolean(),
      })
      .strict(),
    health: z.enum(["HEALTHY", "REVIEW_REQUIRED", "BLOCK_EXPANSION"]),
    observedAt: z.string().min(1).max(100),
    recordFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaDualRunMonitoringRecord = z.infer<
  typeof NqaDualRunMonitoringRecordSchema
>;

export const NqaRolloutMonitoringSummarySchema = z
  .object({
    scopeId: IdSchema,
    scopeFingerprint: FingerprintSchema,
    targetCount: z.number().int().positive(),
    monitoredTargetCount: z.number().int().nonnegative(),
    recordCount: z.number().int().nonnegative(),
    healthyCount: z.number().int().nonnegative(),
    reviewRequiredCount: z.number().int().nonnegative(),
    blockExpansionCount: z.number().int().nonnegative(),
    decision: z.enum(["HOLD", "READY_FOR_MANUAL_EXPANSION_REVIEW"]),
    failureReasons: z.array(
      z.enum([
        "INCOMPLETE_SCOPE_COVERAGE",
        "REVIEW_REQUIRED",
        "BLOCK_EXPANSION",
      ])
    ),
    datasetFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaRolloutMonitoringSummary = z.infer<
  typeof NqaRolloutMonitoringSummarySchema
>;
