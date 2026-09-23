import { z } from "zod";

import { NQA_PERMISSION_TIERS, type NqaPermissionTier } from "../controlPlane";

export const NQA_GATEWAY_ERROR_CODES = [
  "UNAUTHENTICATED",
  "INVALID_REQUEST",
  "UNKNOWN_CAPABILITY",
  "TIER_DISABLED",
  "MISSING_PERMISSION",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "HANDLER_NOT_REGISTERED",
  "EXECUTION_FAILED",
] as const;

export const NqaGatewayErrorCodeSchema = z.enum(NQA_GATEWAY_ERROR_CODES);
export type NqaGatewayErrorCode = z.infer<typeof NqaGatewayErrorCodeSchema>;

const NqaPermissionTierSchema = z.enum(NQA_PERMISSION_TIERS);

export const NqaGatewayPrincipalSchema = z
  .object({
    principalId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    permissions: z.array(NqaPermissionTierSchema).max(16),
    authenticated: z.boolean(),
  })
  .strict();

export type NqaGatewayPrincipal = z.infer<typeof NqaGatewayPrincipalSchema>;
export const NqaGatewayTargetSchema = z
  .object({
    row: z.number().int().positive().nullable().optional(),
    novelId: z.string().min(1).max(100).nullable().optional(),
    bundleId: z.string().min(1).max(150).nullable().optional(),
    chapter: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const NqaGatewayRequestSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    correlationId: z.string().min(1).max(200),
    actorId: z.string().min(1).max(200),
    capability: z.string().min(1).max(200),
    target: NqaGatewayTargetSchema,
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
    requestedAt: z.string().min(1).max(100),
  })
  .strict();

export type NqaGatewayRequest = z.infer<typeof NqaGatewayRequestSchema>;

export const NqaGatewayAuthorizationSchema = z
  .object({
    allowed: z.boolean(),
    requiredPermission: NqaPermissionTierSchema.nullable(),
    reason: z.string().min(1).max(100),
  })
  .strict();

export type NqaGatewayAuthorization = z.infer<
  typeof NqaGatewayAuthorizationSchema
>;
const NqaGatewayResponseBaseSchema = z
  .object({
    requestId: z.string().min(1),
    correlationId: z.string().min(1),
    capability: z.string().min(1),
    authorization: NqaGatewayAuthorizationSchema,
    auditRef: z.string().min(1),
  })
  .strict();

export const NqaGatewaySuccessResponseSchema =
  NqaGatewayResponseBaseSchema.extend({
    status: z.enum(["OK", "REUSED"]),
    result: z.unknown(),
    error: z.null(),
  }).strict();

export const NqaGatewayErrorResponseSchema =
  NqaGatewayResponseBaseSchema.extend({
    status: z.literal("ERROR"),
    result: z.null(),
    error: z
      .object({
        code: NqaGatewayErrorCodeSchema,
        message: z.string().min(1).max(500),
      })
      .strict(),
  }).strict();

export const NqaGatewayResponseSchema = z.union([
  NqaGatewaySuccessResponseSchema,
  NqaGatewayErrorResponseSchema,
]);

export type NqaGatewayResponse = z.infer<typeof NqaGatewayResponseSchema>;

export type NqaAuthenticatedPrincipal = NqaGatewayPrincipal & {
  authenticated: true;
  permissions: NqaPermissionTier[];
};
