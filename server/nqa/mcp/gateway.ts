import {
  NQA_CAPABILITIES,
  NQA_V1_ENABLED_PERMISSION_TIERS,
  authorizeNqaCapability,
  type AuthorizationDecision,
  type NqaCapability,
  type NqaPermissionTier,
} from "../controlPlane";
import { hashCanonicalJson } from "../core";
import { type NqaGatewayAuditRecord, type NqaGatewayAuditSink } from "./audit";
import {
  NqaGatewayPrincipalSchema,
  NqaGatewayRequestSchema,
  type NqaAuthenticatedPrincipal,
  type NqaGatewayAuthorization,
  type NqaGatewayErrorCode,
  type NqaGatewayRequest,
  type NqaGatewayResponse,
} from "./contracts";
import type { NqaGatewayHandlerRegistry } from "./handlers";
import type { NqaIdempotencyStore } from "./idempotency";

const INVALID_ENVELOPE_VALUE = "invalid";

type GatewayDependencies = {
  handlers: NqaGatewayHandlerRegistry;
  idempotencyStore: NqaIdempotencyStore;
  auditSink: NqaGatewayAuditSink;
  enabledPermissionTiers?: readonly NqaPermissionTier[];
  now?: () => string;
};
function safeEnvelopeString(
  request: unknown,
  key: "requestId" | "correlationId" | "capability"
): string {
  if (!request || typeof request !== "object") {
    return INVALID_ENVELOPE_VALUE;
  }

  const value = (request as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    return INVALID_ENVELOPE_VALUE;
  }

  return value;
}

function deniedAuthorization(reason: string): NqaGatewayAuthorization {
  return {
    allowed: false,
    requiredPermission: null,
    reason,
  };
}

function authorizationFromDecision(
  decision: AuthorizationDecision
): NqaGatewayAuthorization {
  return {
    allowed: decision.allowed,
    requiredPermission: decision.requiredPermission,
    reason: decision.reason,
  };
}

function decisionErrorCode(
  decision: Exclude<AuthorizationDecision, { allowed: true }>
): NqaGatewayErrorCode {
  if (decision.reason === "TIER_DISABLED") {
    return "TIER_DISABLED";
  }
  if (decision.reason === "MISSING_PERMISSION") {
    return "MISSING_PERMISSION";
  }
  return "UNKNOWN_CAPABILITY";
}
function makeErrorResponse(input: {
  requestId: string;
  correlationId: string;
  capability: string;
  authorization: NqaGatewayAuthorization;
  auditRef: string;
  code: NqaGatewayErrorCode;
  message: string;
}): NqaGatewayResponse {
  return {
    requestId: input.requestId,
    correlationId: input.correlationId,
    capability: input.capability,
    authorization: input.authorization,
    auditRef: input.auditRef,
    status: "ERROR",
    result: null,
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

function trustedPrincipal(input: unknown): NqaAuthenticatedPrincipal | null {
  const parsed = NqaGatewayPrincipalSchema.safeParse(input);
  if (!parsed.success || parsed.data.authenticated !== true) {
    return null;
  }
  return parsed.data as NqaAuthenticatedPrincipal;
}

function requestFingerprint(input: {
  principal: NqaAuthenticatedPrincipal;
  request: NqaGatewayRequest;
}): string {
  return hashCanonicalJson({
    scope: "nqa:mcp-gateway-request:v1",
    principalId: input.principal.principalId,
    capability: input.request.capability,
    target: input.request.target,
    inputFingerprint: input.request.inputFingerprint ?? null,
  });
}
export class NqaMcpGateway {
  private readonly enabledPermissionTiers: readonly NqaPermissionTier[];
  private readonly now: () => string;

  constructor(private readonly dependencies: GatewayDependencies) {
    this.enabledPermissionTiers =
      dependencies.enabledPermissionTiers ?? NQA_V1_ENABLED_PERMISSION_TIERS;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private async audit(
    record: Omit<NqaGatewayAuditRecord, "auditVersion">
  ): Promise<string> {
    return await this.dependencies.auditSink.append({
      auditVersion: "nqa-gateway-audit-v1",
      ...record,
    });
  }

  async dispatch(input: {
    request: unknown;
    principal: unknown;
  }): Promise<NqaGatewayResponse> {
    const requestId = safeEnvelopeString(input.request, "requestId");
    const correlationId = safeEnvelopeString(input.request, "correlationId");
    const capability = safeEnvelopeString(input.request, "capability");
    const principal = trustedPrincipal(input.principal);

    if (!principal) {
      const auditRef = await this.audit({
        event: "AUTHENTICATION_REJECTED",
        requestId,
        correlationId,
        principalId: "anonymous",
        sessionId: "anonymous",
        capability,
        permissionDecision: "NOT_EVALUATED",
        permissionReason: "UNAUTHENTICATED",
        target: {},
        idempotencyKey: null,
        inputFingerprint: null,
        outcome: "REJECTED",
        errorCode: "UNAUTHENTICATED",
        createdAt: this.now(),
      });
      return makeErrorResponse({
        requestId,
        correlationId,
        capability,
        authorization: deniedAuthorization("UNAUTHENTICATED"),
        auditRef,
        code: "UNAUTHENTICATED",
        message: "Authenticated NQA gateway principal required.",
      });
    }

    const parsedRequest = NqaGatewayRequestSchema.safeParse(input.request);
    if (!parsedRequest.success) {
      const auditRef = await this.audit({
        event: "REQUEST_REJECTED",
        requestId,
        correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability,
        permissionDecision: "NOT_EVALUATED",
        permissionReason: "INVALID_REQUEST",
        target: {},
        idempotencyKey: null,
        inputFingerprint: null,
        outcome: "REJECTED",
        errorCode: "INVALID_REQUEST",
        createdAt: this.now(),
      });

      return makeErrorResponse({
        requestId,
        correlationId,
        capability,
        authorization: deniedAuthorization("INVALID_REQUEST"),
        auditRef,
        code: "INVALID_REQUEST",
        message: "NQA gateway request failed validation.",
      });
    }

    const request = parsedRequest.data;
    const decision = authorizeNqaCapability({
      capability: request.capability,
      actorPermissions: principal.permissions,
      enabledPermissionTiers: this.enabledPermissionTiers,
    });
    if (!decision.allowed) {
      const code = decisionErrorCode(decision);
      const auditRef = await this.audit({
        event: "AUTHORIZATION_REJECTED",
        requestId: request.requestId,
        correlationId: request.correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability: request.capability,
        permissionDecision: "DENY",
        permissionReason: decision.reason,
        target: request.target,
        idempotencyKey: request.idempotencyKey ?? null,
        inputFingerprint: request.inputFingerprint ?? null,
        outcome: "REJECTED",
        errorCode: code,
        createdAt: this.now(),
      });

      return makeErrorResponse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: request.capability,
        authorization: authorizationFromDecision(decision),
        auditRef,
        code,
        message: "NQA capability authorization denied.",
      });
    }

    const typedCapability = decision.capability as NqaCapability;
    const definition = NQA_CAPABILITIES[typedCapability];
    const handler = this.dependencies.handlers.get(typedCapability);

    if (!handler) {
      const auditRef = await this.audit({
        event: "HANDLER_REJECTED",
        requestId: request.requestId,
        correlationId: request.correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability: typedCapability,
        permissionDecision: "ALLOW",
        permissionReason: "ALLOW",
        target: request.target,
        idempotencyKey: request.idempotencyKey ?? null,
        inputFingerprint: request.inputFingerprint ?? null,
        outcome: "REJECTED",
        errorCode: "HANDLER_NOT_REGISTERED",
        createdAt: this.now(),
      });
      return makeErrorResponse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: typedCapability,
        authorization: authorizationFromDecision(decision),
        auditRef,
        code: "HANDLER_NOT_REGISTERED",
        message:
          "No NQA application handler is registered for this capability.",
      });
    }

    let idempotencyReserved = false;
    const isQaStateWrite = definition.effect === "QA_STATE_WRITE";

    if (isQaStateWrite && !request.idempotencyKey) {
      const auditRef = await this.audit({
        event: "REQUEST_REJECTED",
        requestId: request.requestId,
        correlationId: request.correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability: typedCapability,
        permissionDecision: "ALLOW",
        permissionReason: "ALLOW",
        target: request.target,
        idempotencyKey: null,
        inputFingerprint: request.inputFingerprint ?? null,
        outcome: "REJECTED",
        errorCode: "IDEMPOTENCY_KEY_REQUIRED",
        createdAt: this.now(),
      });

      return makeErrorResponse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: typedCapability,
        authorization: authorizationFromDecision(decision),
        auditRef,
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "QA state-write capability requires an idempotency key.",
      });
    }
    if (isQaStateWrite && request.idempotencyKey) {
      const fingerprint = requestFingerprint({ principal, request });
      const reservation = await this.dependencies.idempotencyStore.reserve({
        key: request.idempotencyKey,
        capability: typedCapability,
        requestFingerprint: fingerprint,
        principalId: principal.principalId,
        now: this.now(),
      });

      if (reservation.outcome === "EXISTS") {
        const sameRequest =
          reservation.entry.capability === typedCapability &&
          reservation.entry.requestFingerprint === fingerprint &&
          reservation.entry.principalId === principal.principalId;

        if (sameRequest && reservation.entry.status === "COMPLETED") {
          const auditRef = await this.audit({
            event: "IDEMPOTENCY_REUSED",
            requestId: request.requestId,
            correlationId: request.correlationId,
            principalId: principal.principalId,
            sessionId: principal.sessionId,
            capability: typedCapability,
            permissionDecision: "ALLOW",
            permissionReason: "ALLOW",
            target: request.target,
            idempotencyKey: request.idempotencyKey,
            inputFingerprint: request.inputFingerprint ?? null,
            outcome: "REUSED",
            errorCode: null,
            createdAt: this.now(),
          });

          return {
            requestId: request.requestId,
            correlationId: request.correlationId,
            capability: typedCapability,
            authorization: authorizationFromDecision(decision),
            auditRef,
            status: "REUSED",
            result: reservation.entry.result,
            error: null,
          };
        }
        const auditRef = await this.audit({
          event: "REQUEST_REJECTED",
          requestId: request.requestId,
          correlationId: request.correlationId,
          principalId: principal.principalId,
          sessionId: principal.sessionId,
          capability: typedCapability,
          permissionDecision: "ALLOW",
          permissionReason: "ALLOW",
          target: request.target,
          idempotencyKey: request.idempotencyKey,
          inputFingerprint: request.inputFingerprint ?? null,
          outcome: "REJECTED",
          errorCode: "IDEMPOTENCY_CONFLICT",
          createdAt: this.now(),
        });

        return makeErrorResponse({
          requestId: request.requestId,
          correlationId: request.correlationId,
          capability: typedCapability,
          authorization: authorizationFromDecision(decision),
          auditRef,
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "Idempotency key is already reserved for an incompatible or in-progress request.",
        });
      }

      idempotencyReserved = true;
    }

    await this.audit({
      event: "EXECUTION_STARTED",
      requestId: request.requestId,
      correlationId: request.correlationId,
      principalId: principal.principalId,
      sessionId: principal.sessionId,
      capability: typedCapability,
      permissionDecision: "ALLOW",
      permissionReason: "ALLOW",
      target: request.target,
      idempotencyKey: request.idempotencyKey ?? null,
      inputFingerprint: request.inputFingerprint ?? null,
      outcome: "STARTED",
      errorCode: null,
      createdAt: this.now(),
    });
    try {
      const result = await handler({
        principal,
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: typedCapability,
        target: request.target,
        inputFingerprint: request.inputFingerprint ?? null,
      });

      if (isQaStateWrite && idempotencyReserved && request.idempotencyKey) {
        await this.dependencies.idempotencyStore.complete({
          key: request.idempotencyKey,
          result,
          now: this.now(),
        });
      }

      const auditRef = await this.audit({
        event: "EXECUTION_SUCCEEDED",
        requestId: request.requestId,
        correlationId: request.correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability: typedCapability,
        permissionDecision: "ALLOW",
        permissionReason: "ALLOW",
        target: request.target,
        idempotencyKey: request.idempotencyKey ?? null,
        inputFingerprint: request.inputFingerprint ?? null,
        outcome: "SUCCEEDED",
        errorCode: null,
        createdAt: this.now(),
      });

      return {
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: typedCapability,
        authorization: authorizationFromDecision(decision),
        auditRef,
        status: "OK",
        result,
        error: null,
      };
    } catch {
      if (isQaStateWrite && idempotencyReserved && request.idempotencyKey) {
        await this.dependencies.idempotencyStore.fail({
          key: request.idempotencyKey,
          errorCode: "EXECUTION_FAILED",
          now: this.now(),
        });
      }

      const auditRef = await this.audit({
        event: "EXECUTION_FAILED",
        requestId: request.requestId,
        correlationId: request.correlationId,
        principalId: principal.principalId,
        sessionId: principal.sessionId,
        capability: typedCapability,
        permissionDecision: "ALLOW",
        permissionReason: "ALLOW",
        target: request.target,
        idempotencyKey: request.idempotencyKey ?? null,
        inputFingerprint: request.inputFingerprint ?? null,
        outcome: "FAILED",
        errorCode: "EXECUTION_FAILED",
        createdAt: this.now(),
      });

      return makeErrorResponse({
        requestId: request.requestId,
        correlationId: request.correlationId,
        capability: typedCapability,
        authorization: authorizationFromDecision(decision),
        auditRef,
        code: "EXECUTION_FAILED",
        message: "NQA handler execution failed.",
      });
    }
  }
}
