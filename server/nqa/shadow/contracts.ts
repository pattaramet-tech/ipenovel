import { z } from "zod";

import {
  GoldLabelStatusSchema,
  NqaDecisionSchema,
  NqaReasonCodeSchema,
  type NqaDecision,
  type NqaReasonCode,
} from "../contracts";

export const NQA_SHADOW_BATCH_VERSION = "nqa-shadow-batch-v1" as const;
export const NQA_SHADOW_CHECKPOINT_VERSION =
  "nqa-shadow-checkpoint-v1" as const;
export const NQA_SHADOW_RECORD_VERSION = "nqa-shadow-record-v1" as const;

export const NqaShadowRunIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
export const NqaShadowCaseIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,160}$/);

export const NqaShadowGroundTruthSchema = z
  .object({
    decision: NqaDecisionSchema,
    reasonCodes: z.array(NqaReasonCodeSchema).max(40),
    status: GoldLabelStatusSchema,
    labeledBy: z.string().min(1).max(200).nullable().default(null),
    labeledAt: z.string().min(1).max(100).nullable().default(null),
    notes: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();

export type NqaShadowGroundTruth = z.infer<typeof NqaShadowGroundTruthSchema>;

export const NqaShadowCaseSchema = z
  .object({
    caseId: NqaShadowCaseIdSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    inputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    tags: z.array(z.string().min(1).max(100)).max(20).default([]),
    groundTruth: NqaShadowGroundTruthSchema.nullable().default(null),
  })
  .strict();

export type NqaShadowCase = z.infer<typeof NqaShadowCaseSchema>;

export const NqaShadowStageDecisionsSchema = z
  .object({
    deterministic: NqaDecisionSchema,
    globalSearch: NqaDecisionSchema.nullable(),
    alignment: NqaDecisionSchema.nullable(),
    adjudication: NqaDecisionSchema.nullable(),
    structure: NqaDecisionSchema.nullable(),
  })
  .strict();

export type NqaShadowStageDecisions = z.infer<
  typeof NqaShadowStageDecisionsSchema
>;

export const NqaShadowScoresSchema = z
  .object({
    expectedRank: z.number().int().positive().nullable(),
    expectedSimilarity: z.number().min(-1).max(1).nullable(),
    expectedLeadOverAlternate: z.number().min(-2).max(2).nullable(),
    sourceCoverage: z.number().min(0).max(1).nullable(),
    translationCoverage: z.number().min(0).max(1).nullable(),
    meanRerankScore: z.number().nullable(),
    minRerankScore: z.number().nullable(),
    lowScoreFraction: z.number().min(0).max(1).nullable(),
    sourceGapFraction: z.number().min(0).max(1).nullable(),
    translationGapFraction: z.number().min(0).max(1).nullable(),
    structuredStrongMismatchCount: z.number().int().nonnegative().nullable(),
    structuredStrongMatchCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type NqaShadowScores = z.infer<typeof NqaShadowScoresSchema>;

export const NqaShadowEvidenceSummarySchema = z
  .object({
    stage: z.enum([
      "M08_DETERMINISTIC",
      "M09_GLOBAL_SEARCH",
      "M10_ALIGNMENT",
      "M11_ADJUDICATION",
      "M12_STRUCTURE",
    ]),
    evidenceId: z.string().min(1).max(200),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    translationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    boundedSummary: z.string().max(1000),
  })
  .strict();

export type NqaShadowEvidenceSummary = z.infer<
  typeof NqaShadowEvidenceSummarySchema
>;

export const NqaShadowMachineResultSchema = z
  .object({
    decision: NqaDecisionSchema,
    reasonCodes: z.array(NqaReasonCodeSchema).max(80),
    stageDecisions: NqaShadowStageDecisionsSchema,
    scores: NqaShadowScoresSchema,
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    translationHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    providerVersions: z
      .object({
        embedding: z.string().min(1).max(300).nullable(),
        reranker: z.string().min(1).max(300).nullable(),
        adjudication: z.string().min(1).max(300).nullable(),
        structure: z.string().min(1).max(300).nullable(),
      })
      .strict(),
    policyVersions: z
      .object({
        deterministic: z.string().min(1).max(200),
        semantic: z.string().min(1).max(200),
        alignment: z.string().min(1).max(200).nullable(),
        adjudication: z.string().min(1).max(200).nullable(),
        structure: z.string().min(1).max(200).nullable(),
      })
      .strict(),
    evidence: z.array(NqaShadowEvidenceSummarySchema).max(40),
  })
  .strict();

export type NqaShadowMachineResult = z.infer<
  typeof NqaShadowMachineResultSchema
>;

export const NqaShadowRecordSchema = z
  .object({
    recordVersion: z.literal(NQA_SHADOW_RECORD_VERSION),
    runId: NqaShadowRunIdSchema,
    batchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    caseId: NqaShadowCaseIdSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    inputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    tags: z.array(z.string().min(1).max(100)).max(20),
    groundTruth: NqaShadowGroundTruthSchema.nullable(),
    machine: NqaShadowMachineResultSchema,
    evaluatedAt: z.string().min(1).max(100),
    updatedAt: z.string().min(1).max(100),
  })
  .strict();

export type NqaShadowRecord = z.infer<typeof NqaShadowRecordSchema>;

export const NqaShadowCheckpointSchema = z
  .object({
    checkpointVersion: z.literal(NQA_SHADOW_CHECKPOINT_VERSION),
    runId: NqaShadowRunIdSchema,
    batchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    completedCaseIds: z.array(NqaShadowCaseIdSchema),
    updatedAt: z.string().min(1).max(100),
  })
  .strict();

export type NqaShadowCheckpoint = z.infer<typeof NqaShadowCheckpointSchema>;

export type NqaShadowDecisionCounts = Record<NqaDecision, number>;
export type NqaShadowReasonCounts = Partial<Record<NqaReasonCode, number>>;
export type NqaShadowConfusionMatrix = Record<
  NqaDecision,
  Record<NqaDecision, number>
>;

export type NqaShadowMetrics = {
  batchVersion: typeof NQA_SHADOW_BATCH_VERSION;
  totalCases: number;
  completedCases: number;
  pendingCases: number;
  machineDecisionCounts: NqaShadowDecisionCounts;
  finalLabeledCases: number;
  pendingHumanLabelCases: number;
  exactMatchCount: number;
  exactMatchRate: number | null;
  falsePassCount: number;
  falsePassEligibleCount: number;
  falsePassRate: number | null;
  falseFailCount: number;
  falseFailEligibleCount: number;
  falseFailRate: number | null;
  reviewCount: number;
  reviewRate: number | null;
  reviewOnFinalLabelCount: number;
  reviewOnFinalLabelRate: number | null;
  reasonCodeCounts: NqaShadowReasonCounts;
  confusionMatrix: NqaShadowConfusionMatrix;
};

export type NqaShadowBatchResult = {
  runId: string;
  batchFingerprint: string;
  processedCaseIds: string[];
  reusedCaseIds: string[];
  remainingCaseIds: string[];
  checkpoint: NqaShadowCheckpoint;
  metrics: NqaShadowMetrics;
};
