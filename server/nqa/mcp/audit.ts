import type { AuthorizationDecision } from "../controlPlane";
import type { NqaGatewayErrorCode, NqaGatewayTargetSchema } from "./contracts";
import type { z } from "zod";

export const NQA_GATEWAY_AUDIT_EVENTS = [
  "AUTHENTICATION_REJECTED",
  "REQUEST_REJECTED",
  "AUTHORIZATION_REJECTED",
  "HANDLER_REJECTED",
  "IDEMPOTENCY_REUSED",
  "EXECUTION_STARTED",
  "EXECUTION_SUCCEEDED",
  "EXECUTION_FAILED",
] as const;

export type NqaGatewayAuditEvent = (typeof NQA_GATEWAY_AUDIT_EVENTS)[number];

type NqaGatewayTarget = z.infer<typeof NqaGatewayTargetSchema>;

export type NqaGatewayAuditRecord = {
  auditVersion: "nqa-gateway-audit-v1";
  event: NqaGatewayAuditEvent;
  requestId: string;
  correlationId: string;
  principalId: string;
  sessionId: string;
  capability: string;
  permissionDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  permissionReason:
    | AuthorizationDecision["reason"]
    | "UNAUTHENTICATED"
    | "INVALID_REQUEST"
    | "NOT_EVALUATED";
  target: NqaGatewayTarget;
  idempotencyKey: string | null;
  inputFingerprint: string | null;
  outcome: "REJECTED" | "STARTED" | "REUSED" | "SUCCEEDED" | "FAILED";
  errorCode: NqaGatewayErrorCode | null;
  createdAt: string;
};

export interface NqaGatewayAuditSink {
  append(record: NqaGatewayAuditRecord): Promise<string> | string;
}

function cloneRecord(record: NqaGatewayAuditRecord): NqaGatewayAuditRecord {
  return {
    ...record,
    target: { ...record.target },
  };
}

export class InMemoryNqaGatewayAuditSink implements NqaGatewayAuditSink {
  readonly records: Array<NqaGatewayAuditRecord & { auditRef: string }> = [];

  append(record: NqaGatewayAuditRecord): string {
    const auditRef = `nqa-audit-${String(this.records.length + 1).padStart(4, "0")}`;
    this.records.push({
      ...cloneRecord(record),
      auditRef,
    });
    return auditRef;
  }
}
