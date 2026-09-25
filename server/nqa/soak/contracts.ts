import { z } from "zod";

import {
  NqaControlledRolloutScopeSchema,
  NqaRolloutTargetSchema,
} from "../rollout/contracts";

export const NQA_OPERATIONAL_SAMPLE_VERSION =
  "nqa-operational-sample-v1" as const;
export const NQA_SOAK_GATE_VERSION = "nqa-production-soak-gate-v1" as const;
export const NQA_SCOPE_EXPANSION_AUTHORIZATION_VERSION =
  "nqa-scope-expansion-authorization-v1" as const;
export const NQA_SCOPE_EXPANSION_STATE_VERSION =
  "nqa-scope-expansion-state-v1" as const;
export const NQA_SCOPE_EXPANSION_EVENT_VERSION =
  "nqa-scope-expansion-event-v1" as const;

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,160}$/);

export const NqaOperationalSampleSchema = z
  .object({
    sampleVersion: z.literal(NQA_OPERATIONAL_SAMPLE_VERSION),
    sampleId: IdSchema,
    scopeId: IdSchema,
    scopeFingerprint: FingerprintSchema,
    row: z.number().int().positive(),
    chapter: z.number().int().positive(),
    status: z.enum(["SUCCESS", "ERROR"]),
    durationMs: z.number().finite().nonnegative(),
    monitoringRecordId: IdSchema.nullable(),
    monitoringRecordFingerprint: FingerprintSchema.nullable(),
    errorCode: z.string().min(1).max(100).nullable(),
    observedAt: z.string().min(1).max(100),
    sampleFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaOperationalSample = z.infer<typeof NqaOperationalSampleSchema>;

export const NqaSoakCriteriaSchema = z
  .object({
    minWindowMinutes: z.number().finite().positive(),
    minOperationalSamples: z.number().int().positive(),
    minSuccessfulSamples: z.number().int().positive(),
    minTargetCoverage: z.number().finite().min(0).max(1),
    maxErrorRate: z.number().finite().min(0).max(1),
    maxP95LatencyMs: z.number().finite().positive(),
    requireZeroReviewRequired: z.boolean(),
    requireZeroBlockExpansion: z.boolean(),
  })
  .strict();

export type NqaSoakCriteria = z.infer<typeof NqaSoakCriteriaSchema>;

export const NqaProductionSoakGateSchema = z
  .object({
    gateVersion: z.literal(NQA_SOAK_GATE_VERSION),
    scopeId: IdSchema,
    scopeFingerprint: FingerprintSchema,
    sourceActivationTransactionId: IdSchema,
    registryRevision: z.number().int().positive(),
    registryStateFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    baselinePolicyFingerprint: FingerprintSchema,
    windowStart: z.string().min(1).max(100),
    windowEnd: z.string().min(1).max(100),
    windowMinutes: z.number().finite().nonnegative(),
    criteria: NqaSoakCriteriaSchema,
    metrics: z
      .object({
        operationalSamples: z.number().int().nonnegative(),
        successfulSamples: z.number().int().nonnegative(),
        errorSamples: z.number().int().nonnegative(),
        linkedMonitoringRecords: z.number().int().nonnegative(),
        monitoredTargets: z.number().int().nonnegative(),
        targetCoverage: z.number().finite().min(0).max(1),
        errorRate: z.number().finite().min(0).max(1),
        p95LatencyMs: z.number().finite().nullable(),
        healthyCount: z.number().int().nonnegative(),
        reviewRequiredCount: z.number().int().nonnegative(),
        blockExpansionCount: z.number().int().nonnegative(),
      })
      .strict(),
    failureReasons: z.array(
      z.enum([
        "SOAK_WINDOW_TOO_SHORT",
        "INSUFFICIENT_OPERATIONAL_SAMPLES",
        "INSUFFICIENT_SUCCESSFUL_SAMPLES",
        "INCOMPLETE_TARGET_COVERAGE",
        "ERROR_RATE_EXCEEDED",
        "LATENCY_EXCEEDED",
        "MISSING_MONITORING_LINKAGE",
        "REVIEW_REQUIRED",
        "BLOCK_EXPANSION",
      ])
    ),
    decision: z.enum(["HOLD", "READY_FOR_SCOPE_EXPANSION_REVIEW"]),
    evidenceFingerprint: FingerprintSchema,
    artifactFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaProductionSoakGate = z.infer<typeof NqaProductionSoakGateSchema>;

export const NqaScopeExpansionAuthorizationSchema = z
  .object({
    authorizationVersion: z.literal(NQA_SCOPE_EXPANSION_AUTHORIZATION_VERSION),
    authorizationId: IdSchema,
    authorizerId: z.string().min(1).max(200),
    action: z.literal("EXPAND_SCOPE"),
    approvalStatement: z.literal("I_APPROVE_NQA_SCOPE_EXPANSION"),
    expectedRegistryRevision: z.number().int().positive(),
    expectedRegistryStateFingerprint: FingerprintSchema,
    sourceActivationTransactionId: IdSchema,
    sourceScopeId: IdSchema,
    sourceScopeFingerprint: FingerprintSchema,
    soakArtifactFingerprint: FingerprintSchema,
    candidatePolicyFingerprint: FingerprintSchema,
    baselinePolicyFingerprint: FingerprintSchema,
    proposedScopeId: IdSchema,
    proposedTargetsFingerprint: FingerprintSchema,
    approvedAt: z.string().min(1).max(100),
    validUntil: z.string().min(1).max(100),
    authorizationFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaScopeExpansionAuthorization = z.infer<
  typeof NqaScopeExpansionAuthorizationSchema
>;

export const NqaScopeExpansionStateSchema = z
  .object({
    stateVersion: z.literal(NQA_SCOPE_EXPANSION_STATE_VERSION),
    revision: z.number().int().nonnegative(),
    currentScope: NqaControlledRolloutScopeSchema,
    lastTransactionId: IdSchema.nullable(),
    stateFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaScopeExpansionState = z.infer<
  typeof NqaScopeExpansionStateSchema
>;

export const NqaScopeExpansionEventSchema = z
  .object({
    eventVersion: z.literal(NQA_SCOPE_EXPANSION_EVENT_VERSION),
    transactionId: IdSchema,
    humanAuthorization: NqaScopeExpansionAuthorizationSchema,
    sourceScope: NqaControlledRolloutScopeSchema,
    sourceSoakGate: NqaProductionSoakGateSchema,
    addedTargets: z.array(NqaRolloutTargetSchema).min(1).max(100),
    previousRevision: z.number().int().nonnegative(),
    previousStateFingerprint: FingerprintSchema,
    resultingState: NqaScopeExpansionStateSchema,
    committedAt: z.string().min(1).max(100),
    eventFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaScopeExpansionEvent = z.infer<
  typeof NqaScopeExpansionEventSchema
>;

export const NqaScopeExpansionAppendResultSchema = z.enum([
  "COMMITTED",
  "CONFLICT",
  "EXISTS",
]);
export type NqaScopeExpansionAppendResult = z.infer<
  typeof NqaScopeExpansionAppendResultSchema
>;
