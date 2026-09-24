import { z } from "zod";

import { NqaFullAlignmentPolicySchema } from "../candidatePolicy/contracts";
import {
  NqaRolloutTargetSchema,
  NqaControlledRolloutScopeSchema,
} from "../rollout/contracts";
import {
  NqaProductionSoakGateSchema,
  NqaScopeExpansionEventSchema,
  NqaScopeExpansionStateSchema,
} from "../soak/contracts";

export const NQA_ROLLOUT_COMPLETION_GATE_VERSION =
  "nqa-rollout-completion-gate-v1" as const;
export const NQA_FINALIZATION_AUTHORIZATION_VERSION =
  "nqa-candidate-finalization-authorization-v1" as const;
export const NQA_BASELINE_LINEAGE_STATE_VERSION =
  "nqa-baseline-lineage-state-v1" as const;
export const NQA_BASELINE_FINALIZATION_EVENT_VERSION =
  "nqa-baseline-finalization-event-v1" as const;

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,160}$/);

export const NqaRolloutCompletionCriteriaSchema = z
  .object({
    minExpansionCycles: z.number().int().nonnegative(),
    minTerminalTargets: z.number().int().positive(),
    minTerminalCoverage: z.number().finite().min(0).max(1),
  })
  .strict();

export type NqaRolloutCompletionCriteria = z.infer<
  typeof NqaRolloutCompletionCriteriaSchema
>;

export const NqaRolloutCompletionGateSchema = z
  .object({
    gateVersion: z.literal(NQA_ROLLOUT_COMPLETION_GATE_VERSION),
    sourceActivationTransactionId: IdSchema,
    registryRevision: z.number().int().positive(),
    registryStateFingerprint: FingerprintSchema,
    baselinePolicyFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    initialScope: NqaControlledRolloutScopeSchema,
    currentExpansionState: NqaScopeExpansionStateSchema,
    expansionEventFingerprints: z.array(FingerprintSchema).max(100),
    finalSoakGate: NqaProductionSoakGateSchema,
    finalSoakArtifactFingerprint: FingerprintSchema,
    rolloutUniverse: z.array(NqaRolloutTargetSchema).min(1).max(100),
    rolloutUniverseFingerprint: FingerprintSchema,
    criteria: NqaRolloutCompletionCriteriaSchema,
    metrics: z
      .object({
        expansionCycles: z.number().int().nonnegative(),
        passingExpansionSoaks: z.number().int().nonnegative(),
        terminalTargetCount: z.number().int().positive(),
        universeTargetCount: z.number().int().positive(),
        terminalCoverage: z.number().finite().min(0).max(1),
      })
      .strict(),
    failureReasons: z.array(
      z.enum([
        "INSUFFICIENT_EXPANSION_CYCLES",
        "TERMINAL_TARGET_COUNT_INSUFFICIENT",
        "TERMINAL_COVERAGE_INSUFFICIENT",
        "EXPANSION_HISTORY_MISMATCH",
        "EXPANSION_SOAK_NOT_READY",
        "FINAL_SOAK_NOT_READY",
        "FINAL_SCOPE_MISMATCH",
        "REGISTRY_MISMATCH",
      ])
    ),
    decision: z.enum(["HOLD", "READY_FOR_CANDIDATE_FINALIZATION_REVIEW"]),
    historyFingerprint: FingerprintSchema,
    artifactFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaRolloutCompletionGate = z.infer<
  typeof NqaRolloutCompletionGateSchema
>;

export const NqaCandidateFinalizationAuthorizationSchema = z
  .object({
    authorizationVersion: z.literal(NQA_FINALIZATION_AUTHORIZATION_VERSION),
    authorizationId: IdSchema,
    authorizerId: z.string().min(1).max(200),
    action: z.literal("FINALIZE_CANDIDATE_BASELINE"),
    approvalStatement: z.literal("I_APPROVE_NQA_CANDIDATE_FINALIZATION"),
    expectedRegistryRevision: z.number().int().positive(),
    expectedRegistryStateFingerprint: FingerprintSchema,
    sourceActivationTransactionId: IdSchema,
    expectedExpansionRevision: z.number().int().nonnegative(),
    expectedExpansionStateFingerprint: FingerprintSchema,
    completionArtifactFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    predecessorBaselinePolicyFingerprint: FingerprintSchema,
    approvedAt: z.string().min(1).max(100),
    validUntil: z.string().min(1).max(100),
    authorizationFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaCandidateFinalizationAuthorization = z.infer<
  typeof NqaCandidateFinalizationAuthorizationSchema
>;

export const NqaBaselineLineageStateSchema = z
  .object({
    stateVersion: z.literal(NQA_BASELINE_LINEAGE_STATE_VERSION),
    revision: z.number().int().nonnegative(),
    baselinePolicyVersion: z.string().min(1).max(200),
    baselinePolicyFingerprint: FingerprintSchema,
    baselinePolicy: NqaFullAlignmentPolicySchema,
    predecessorBaselinePolicyVersion: z.string().min(1).max(200).nullable(),
    predecessorBaselinePolicyFingerprint: FingerprintSchema.nullable(),
    predecessorBaselinePolicy: NqaFullAlignmentPolicySchema.nullable(),
    sourceFinalizationTransactionId: IdSchema.nullable(),
    sourceCompletionArtifactFingerprint: FingerprintSchema.nullable(),
    stateFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaBaselineLineageState = z.infer<
  typeof NqaBaselineLineageStateSchema
>;

export const NqaBaselineFinalizationEventSchema = z
  .object({
    eventVersion: z.literal(NQA_BASELINE_FINALIZATION_EVENT_VERSION),
    transactionId: IdSchema,
    humanAuthorization: NqaCandidateFinalizationAuthorizationSchema,
    sourceCompletionGate: NqaRolloutCompletionGateSchema,
    sourceActivationEventFingerprint: FingerprintSchema,
    sourceExpansionState: NqaScopeExpansionStateSchema,
    sourceExpansionEvents: z.array(NqaScopeExpansionEventSchema).max(100),
    previousLineageState: NqaBaselineLineageStateSchema,
    resultingLineageState: NqaBaselineLineageStateSchema,
    committedAt: z.string().min(1).max(100),
    eventFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaBaselineFinalizationEvent = z.infer<
  typeof NqaBaselineFinalizationEventSchema
>;

export const NqaBaselineFinalizationAppendResultSchema = z.enum([
  "COMMITTED",
  "CONFLICT",
  "EXISTS",
]);

export type NqaBaselineFinalizationAppendResult = z.infer<
  typeof NqaBaselineFinalizationAppendResultSchema
>;
