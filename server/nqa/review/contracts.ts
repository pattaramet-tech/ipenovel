import { z } from "zod";

import { NqaDecisionSchema, NqaReasonCodeSchema } from "../contracts";
import {
  NqaShadowCaseIdSchema,
  NqaShadowGroundTruthSchema,
  NqaShadowMachineResultSchema,
  NqaShadowRunIdSchema,
} from "../shadow/contracts";

export const NQA_REVIEW_ACTION_VERSION = "nqa-review-action-v1" as const;
export const NQA_CURATION_EXPORT_VERSION = "nqa-curation-export-v1" as const;

export const NqaReviewStatusSchema = z.enum([
  "PENDING",
  "PROPOSED",
  "CONFIRMED",
  "DISPUTED",
  "RESOLVED",
]);
export type NqaReviewStatus = z.infer<typeof NqaReviewStatusSchema>;

export const NqaReviewActionTypeSchema = z.enum([
  "PROPOSE",
  "CONFIRM",
  "DISPUTE",
  "RESOLVE",
]);
export type NqaReviewActionType = z.infer<typeof NqaReviewActionTypeSchema>;

export const NqaReviewLabelSchema = z
  .object({
    decision: NqaDecisionSchema,
    reasonCodes: z.array(NqaReasonCodeSchema).max(40),
  })
  .strict();
export type NqaReviewLabel = z.infer<typeof NqaReviewLabelSchema>;

export const NqaReviewEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("M13_EVIDENCE"),
      evidenceId: z.string().min(1).max(200),
      boundedSummary: z.string().max(500).nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SOURCE_HASH"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      boundedSummary: z.string().max(500).nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("TRANSLATION_HASH"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      boundedSummary: z.string().max(500).nullable().default(null),
    })
    .strict(),
]);
export type NqaReviewEvidence = z.infer<typeof NqaReviewEvidenceSchema>;

export const NqaReviewActionSchema = z
  .object({
    actionVersion: z.literal(NQA_REVIEW_ACTION_VERSION),
    actionId: z.string().regex(/^[A-Za-z0-9._-]{1,160}$/),
    runId: NqaShadowRunIdSchema,
    caseId: NqaShadowCaseIdSchema,
    subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    previousActionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    actionType: NqaReviewActionTypeSchema,
    reviewerId: z.string().min(1).max(200),
    label: NqaReviewLabelSchema,
    evidence: z.array(NqaReviewEvidenceSchema).min(1).max(20),
    boundedNote: z.string().max(1000).nullable().default(null),
    createdAt: z.string().min(1).max(100),
  })
  .strict();
export type NqaReviewAction = z.infer<typeof NqaReviewActionSchema>;

export type NqaReviewState = {
  runId: string;
  caseId: string;
  subjectFingerprint: string;
  status: NqaReviewStatus;
  candidateLabel: NqaReviewLabel | null;
  finalGroundTruth: z.infer<typeof NqaShadowGroundTruthSchema> | null;
  actionCount: number;
  lastActionHash: string | null;
  lastActionAt: string | null;
  reviewers: string[];
};

export const NqaReviewQueueReasonSchema = z.enum([
  "DISPUTED_LABEL",
  "PENDING_CONFIRMATION",
  "MACHINE_REVIEW",
  "UNLABELED",
]);
export type NqaReviewQueueReason = z.infer<typeof NqaReviewQueueReasonSchema>;

export type NqaReviewQueueItem = {
  runId: string;
  caseId: string;
  row: number;
  chapter: number;
  inputFingerprint: string | null;
  subjectFingerprint: string;
  status: NqaReviewStatus;
  queueReason: NqaReviewQueueReason;
  priority: number;
  machineDecision: z.infer<typeof NqaDecisionSchema>;
  machineReasonCodes: z.infer<typeof NqaReasonCodeSchema>[];
  candidateLabel: NqaReviewLabel | null;
  finalGroundTruth: z.infer<typeof NqaShadowGroundTruthSchema> | null;
  actionCount: number;
  evidence: Array<{
    stage: string;
    evidenceId: string;
    sourceHash: string | null;
    translationHash: string | null;
    boundedSummary: string;
  }>;
};

export const NqaCuratedCaseSchema = z
  .object({
    caseId: NqaShadowCaseIdSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    inputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    baselineGroundTruth: NqaShadowGroundTruthSchema.nullable(),
    machineSnapshot: NqaShadowMachineResultSchema,
    reviewStatus: NqaReviewStatusSchema,
    candidateLabel: NqaReviewLabelSchema.nullable(),
    finalGroundTruth: NqaShadowGroundTruthSchema.nullable(),
    actionTrail: z.array(
      z
        .object({
          sequence: z.number().int().positive(),
          actionHash: z.string().regex(/^[a-f0-9]{64}$/),
          previousActionHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          actionType: NqaReviewActionTypeSchema,
          reviewerId: z.string().min(1).max(200),
          label: NqaReviewLabelSchema,
          evidence: z.array(NqaReviewEvidenceSchema).min(1).max(20),
          boundedNote: z.string().max(1000).nullable(),
          createdAt: z.string().min(1).max(100),
        })
        .strict()
    ),
  })
  .strict();
export type NqaCuratedCase = z.infer<typeof NqaCuratedCaseSchema>;

export const NqaCurationExportSchema = z
  .object({
    exportVersion: z.literal(NQA_CURATION_EXPORT_VERSION),
    runId: NqaShadowRunIdSchema,
    batchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    caseCount: z.number().int().nonnegative(),
    finalLabelCount: z.number().int().nonnegative(),
    unresolvedCount: z.number().int().nonnegative(),
    cases: z.array(NqaCuratedCaseSchema),
    datasetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NqaCurationExport = z.infer<typeof NqaCurationExportSchema>;
