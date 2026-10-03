import { randomUUID } from "node:crypto";
import type { PluginAuditRecord, PluginAuditSink } from "./controlPlane";
import { insertPluginAuditLog } from "./store";

/**
 * DB-backed audit sink for the plugin foundation - the production
 * PluginAuditSink implementation. Writes are append-only (insert only; no
 * update/delete path exists anywhere in this namespace, matching the
 * workspaceAuditEvents/adminUserAuditLogs discipline).
 *
 * Audit writes are fire-and-remember: a failed audit append is logged with
 * a sanitized summary and swallowed, because losing an audit row must never
 * turn a security decision the caller already made into a request failure
 * (the inverse ordering - audit-before-execute where the decision depends
 * on the audit succeeding - is handled by the gateway/service layers, which
 * await this append at the points where it is load-bearing).
 */
export function createDbPluginAuditSink(): PluginAuditSink {
  return {
    async append(record: PluginAuditRecord): Promise<void> {
      try {
        await insertPluginAuditLog({
          eventType: record.eventType,
          actorUserId: record.actorUserId,
          clientId: record.clientId,
          correlationId: record.correlationId,
          safeMetadata: record.safeMetadata,
          createdAt: new Date(record.createdAt),
        });
      } catch (error) {
        console.error(
          `[plugin-audit] append failed: eventType=${record.eventType} correlationId=${record.correlationId}`,
          error instanceof Error ? error.name : "Error"
        );
      }
    },
  };
}

/** Server-generated per-decision correlation id - NEVER derived from client input. */
export function newPluginCorrelationId(): string {
  return `plg-${randomUUID()}`;
}
