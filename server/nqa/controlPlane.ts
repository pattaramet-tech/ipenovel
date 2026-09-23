import { z } from "zod";

export const NQA_PERMISSION_TIERS = [
  "READ",
  "QA_OPERATE",
  "REMEDIATION",
  "PRODUCTION_MUTATION",
] as const;

export type NqaPermissionTier = (typeof NQA_PERMISSION_TIERS)[number];

export type CapabilityDefinition = {
  requiredPermission: NqaPermissionTier;
  effect: "READ_ONLY" | "QA_STATE_WRITE";
  description: string;
};

export const NQA_CAPABILITIES = {
  "nqa.intake.get_row": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Read one configured Sheet intake row.",
  },
  "nqa.intake.scan_range": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Read a bounded Sheet intake range.",
  },
  "nqa.intake.validate_contract": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Validate a typed intake contract.",
  },
  "nqa.intake.get_manifest": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Read a revision-aware NQA manifest.",
  },
  "nqa.novel.resolve_identity": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Resolve exact, alias, or structured identity candidates.",
  },
  "nqa.chapter.resolve": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Resolve a chapter mapping without production mutation.",
  },
  "nqa.chapter.extract": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Extract a bounded chapter snapshot.",
  },
  "nqa.result.get": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Read immutable QA results.",
  },
  "nqa.evidence.get": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Read bounded QA evidence.",
  },
  "nqa.review.list": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "List review queue entries.",
  },
  "nqa.review.inspect": {
    requiredPermission: "READ",
    effect: "READ_ONLY",
    description: "Inspect one review queue entry.",
  },
  "nqa.qa.run_deterministic": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Run deterministic QA and write QA-only evidence.",
  },
  "nqa.qa.run_semantic": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Run semantic QA and write QA-only evidence.",
  },
  "nqa.qa.run_regression": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Run frozen regression fixtures.",
  },
  "nqa.qa.deep_review_prepare": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Prepare bounded evidence for deep review.",
  },
  "nqa.cache.rebuild_changed": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Refresh changed QA cache entries only.",
  },
  "nqa.manifest.refresh": {
    requiredPermission: "QA_OPERATE",
    effect: "QA_STATE_WRITE",
    description: "Refresh the read-only production manifest mirror.",
  },
} as const satisfies Record<string, CapabilityDefinition>;

export type NqaCapability = keyof typeof NQA_CAPABILITIES;

export const NQA_V1_ENABLED_PERMISSION_TIERS = [
  "READ",
  "QA_OPERATE",
] as const satisfies readonly NqaPermissionTier[];

export const NqaCapabilitySchema = z.custom<NqaCapability>(
  value => typeof value === "string" && value in NQA_CAPABILITIES,
  "Unknown NQA capability"
);

export const NqaMcpRequestSchema = z
  .object({
    requestId: z.string().min(1),
    correlationId: z.string().min(1),
    actorId: z.string().min(1),
    capability: z.string().min(1),
    target: z
      .object({
        row: z.number().int().positive().nullable().optional(),
        novelId: z.string().min(1).nullable().optional(),
        bundleId: z.string().min(1).nullable().optional(),
        chapter: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    idempotencyKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    inputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    requestedAt: z.string().min(1),
  })
  .strict();

export type NqaMcpRequest = z.infer<typeof NqaMcpRequestSchema>;

export type AuthorizationDecision =
  | {
      allowed: true;
      capability: NqaCapability;
      requiredPermission: NqaPermissionTier;
      reason: "ALLOW";
    }
  | {
      allowed: false;
      capability: string;
      requiredPermission: NqaPermissionTier | null;
      reason: "UNKNOWN_CAPABILITY" | "TIER_DISABLED" | "MISSING_PERMISSION";
    };

export function authorizeNqaCapability(input: {
  capability: string;
  actorPermissions: readonly NqaPermissionTier[];
  enabledPermissionTiers?: readonly NqaPermissionTier[];
}): AuthorizationDecision {
  const definition = (
    NQA_CAPABILITIES as Record<string, CapabilityDefinition | undefined>
  )[input.capability];

  if (!definition) {
    return {
      allowed: false,
      capability: input.capability,
      requiredPermission: null,
      reason: "UNKNOWN_CAPABILITY",
    };
  }

  const enabled =
    input.enabledPermissionTiers ?? NQA_V1_ENABLED_PERMISSION_TIERS;

  if (!enabled.includes(definition.requiredPermission)) {
    return {
      allowed: false,
      capability: input.capability,
      requiredPermission: definition.requiredPermission,
      reason: "TIER_DISABLED",
    };
  }

  if (!input.actorPermissions.includes(definition.requiredPermission)) {
    return {
      allowed: false,
      capability: input.capability,
      requiredPermission: definition.requiredPermission,
      reason: "MISSING_PERMISSION",
    };
  }

  return {
    allowed: true,
    capability: input.capability as NqaCapability,
    requiredPermission: definition.requiredPermission,
    reason: "ALLOW",
  };
}

export type NqaAuditRecord = {
  auditVersion: "nqa-audit-v1";
  requestId: string;
  correlationId: string;
  actorId: string;
  capability: string;
  permissionDecision: "ALLOW" | "DENY";
  permissionReason: AuthorizationDecision["reason"];
  target: NqaMcpRequest["target"];
  idempotencyKey: string | null;
  inputFingerprint: string | null;
  outcome: "AUTHORIZED" | "REJECTED";
  createdAt: string;
};

export interface NqaAuditSink {
  append(record: NqaAuditRecord): Promise<void> | void;
}

export class InMemoryNqaAuditSink implements NqaAuditSink {
  readonly records: NqaAuditRecord[] = [];

  append(record: NqaAuditRecord): void {
    this.records.push({ ...record, target: { ...record.target } });
  }
}

export async function authorizeAndAudit(input: {
  request: NqaMcpRequest;
  actorPermissions: readonly NqaPermissionTier[];
  sink: NqaAuditSink;
  enabledPermissionTiers?: readonly NqaPermissionTier[];
  now?: () => string;
}): Promise<AuthorizationDecision> {
  const request = NqaMcpRequestSchema.parse(input.request);
  const decision = authorizeNqaCapability({
    capability: request.capability,
    actorPermissions: input.actorPermissions,
    enabledPermissionTiers: input.enabledPermissionTiers,
  });

  await input.sink.append({
    auditVersion: "nqa-audit-v1",
    requestId: request.requestId,
    correlationId: request.correlationId,
    actorId: request.actorId,
    capability: request.capability,
    permissionDecision: decision.allowed ? "ALLOW" : "DENY",
    permissionReason: decision.reason,
    target: request.target,
    idempotencyKey: request.idempotencyKey ?? null,
    inputFingerprint: request.inputFingerprint ?? null,
    outcome: decision.allowed ? "AUTHORIZED" : "REJECTED",
    createdAt: input.now?.() ?? new Date().toISOString(),
  });

  return decision;
}
