import { z } from "zod";

import {
  NqaActivationReadinessSchema,
  NqaFullAlignmentPolicySchema,
} from "../candidatePolicy/contracts";

export const NQA_HUMAN_POLICY_AUTHORIZATION_VERSION =
  "nqa-human-policy-authorization-v1" as const;
export const NQA_POLICY_REGISTRY_STATE_VERSION =
  "nqa-policy-registry-state-v1" as const;
export const NQA_POLICY_TRANSACTION_EVENT_VERSION =
  "nqa-policy-transaction-event-v1" as const;

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,160}$/);

const NqaHumanPolicyAuthorizationBaseSchema = z
  .object({
    authorizationVersion: z.literal(NQA_HUMAN_POLICY_AUTHORIZATION_VERSION),
    authorizationId: IdSchema,
    authorizerId: z.string().min(1).max(200),
    expectedRegistryRevision: z.number().int().nonnegative(),
    expectedActivePolicyFingerprint: FingerprintSchema,
    targetPolicyFingerprint: FingerprintSchema,
    approvedAt: z.string().min(1).max(100),
    validUntil: z.string().min(1).max(100),
    authorizationFingerprint: FingerprintSchema,
  })
  .strict();

export const NqaActivationAuthorizationSchema =
  NqaHumanPolicyAuthorizationBaseSchema.extend({
    action: z.literal("ACTIVATE"),
    approvalStatement: z.literal("I_APPROVE_NQA_POLICY_ACTIVATION"),
    readinessArtifactFingerprint: FingerprintSchema,
    sourceActivationTransactionId: z.null(),
  }).strict();

export const NqaRollbackAuthorizationSchema =
  NqaHumanPolicyAuthorizationBaseSchema.extend({
    action: z.literal("ROLLBACK"),
    approvalStatement: z.literal("I_APPROVE_NQA_POLICY_ROLLBACK"),
    readinessArtifactFingerprint: z.null(),
    sourceActivationTransactionId: IdSchema,
  }).strict();

export const NqaHumanPolicyAuthorizationSchema = z.discriminatedUnion(
  "action",
  [NqaActivationAuthorizationSchema, NqaRollbackAuthorizationSchema]
);

export type NqaHumanPolicyAuthorization = z.infer<
  typeof NqaHumanPolicyAuthorizationSchema
>;
export type NqaActivationAuthorization = z.infer<
  typeof NqaActivationAuthorizationSchema
>;
export type NqaRollbackAuthorization = z.infer<
  typeof NqaRollbackAuthorizationSchema
>;

export const NqaPolicyRollbackTargetSchema = z
  .object({
    policyVersion: z.string().min(1).max(200),
    policyFingerprint: FingerprintSchema,
    policy: NqaFullAlignmentPolicySchema,
    sourceActivationTransactionId: IdSchema,
    sourceReadinessArtifactFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaPolicyRollbackTarget = z.infer<
  typeof NqaPolicyRollbackTargetSchema
>;

export const NqaPolicyRegistryStateSchema = z
  .object({
    stateVersion: z.literal(NQA_POLICY_REGISTRY_STATE_VERSION),
    revision: z.number().int().nonnegative(),
    activePolicyVersion: z.string().min(1).max(200),
    activePolicyFingerprint: FingerprintSchema,
    activePolicy: NqaFullAlignmentPolicySchema,
    rollbackTarget: NqaPolicyRollbackTargetSchema.nullable(),
    lastTransactionId: IdSchema.nullable(),
    stateFingerprint: FingerprintSchema,
  })
  .strict();

export type NqaPolicyRegistryState = z.infer<
  typeof NqaPolicyRegistryStateSchema
>;

const NqaPolicyTransactionEventBaseSchema = z
  .object({
    eventVersion: z.literal(NQA_POLICY_TRANSACTION_EVENT_VERSION),
    transactionId: IdSchema,
    humanAuthorization: NqaHumanPolicyAuthorizationSchema,
    previousRevision: z.number().int().nonnegative(),
    nextRevision: z.number().int().positive(),
    previousStateFingerprint: FingerprintSchema,
    previousActivePolicyVersion: z.string().min(1).max(200),
    previousActivePolicyFingerprint: FingerprintSchema,
    resultingState: NqaPolicyRegistryStateSchema,
    committedAt: z.string().min(1).max(100),
    eventFingerprint: FingerprintSchema,
  })
  .strict();

export const NqaActivationTransactionEventSchema =
  NqaPolicyTransactionEventBaseSchema.extend({
    kind: z.literal("ACTIVATE"),
    sourceReadiness: NqaActivationReadinessSchema,
    sourceMaterializedPolicyArtifactFingerprint: FingerprintSchema,
    rolledBackActivationTransactionId: z.null(),
  }).strict();

export const NqaRollbackTransactionEventSchema =
  NqaPolicyTransactionEventBaseSchema.extend({
    kind: z.literal("ROLLBACK"),
    sourceReadiness: z.null(),
    sourceMaterializedPolicyArtifactFingerprint: z.null(),
    rolledBackActivationTransactionId: IdSchema,
  }).strict();

export const NqaPolicyTransactionEventSchema = z.discriminatedUnion("kind", [
  NqaActivationTransactionEventSchema,
  NqaRollbackTransactionEventSchema,
]);

export type NqaPolicyTransactionEvent = z.infer<
  typeof NqaPolicyTransactionEventSchema
>;
export type NqaActivationTransactionEvent = z.infer<
  typeof NqaActivationTransactionEventSchema
>;
export type NqaRollbackTransactionEvent = z.infer<
  typeof NqaRollbackTransactionEventSchema
>;

export const NqaActivationStoreAppendResultSchema = z.enum([
  "COMMITTED",
  "CONFLICT",
  "EXISTS",
]);
export type NqaActivationStoreAppendResult = z.infer<
  typeof NqaActivationStoreAppendResultSchema
>;
