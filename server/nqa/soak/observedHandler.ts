import { hashCanonicalJson } from "../core";
import type {
  NqaGatewayHandler,
  NqaGatewayHandlerContext,
} from "../mcp/handlers";
import type { NqaControlledRolloutScope } from "../rollout/contracts";
import { verifyNqaControlledRolloutScope } from "../rollout/resolver";
import {
  buildNqaOperationalSample,
  type NqaOperationalSampleStore,
} from "./telemetry";

function targetInScope(
  scope: NqaControlledRolloutScope,
  context: NqaGatewayHandlerContext
): boolean {
  const row = context.target.row;
  const chapter = context.target.chapter;
  if (!row || !chapter) return false;
  return scope.targets.some(
    target => target.row === row && target.chapter === chapter
  );
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code.slice(0, 100);
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 100);
  return "EXECUTION_ERROR";
}

function monitoringLink(value: unknown): {
  recordId: string;
  recordFingerprint: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const rollout = (value as { rollout?: unknown }).rollout;
  if (!rollout || typeof rollout !== "object") return null;
  const monitoring = (rollout as { monitoring?: unknown }).monitoring;
  if (!monitoring || typeof monitoring !== "object") return null;
  const recordId = (monitoring as { recordId?: unknown }).recordId;
  const recordFingerprint = (monitoring as { recordFingerprint?: unknown })
    .recordFingerprint;
  return typeof recordId === "string" && typeof recordFingerprint === "string"
    ? { recordId, recordFingerprint }
    : null;
}

export function createNqaSoakObservedHandler(input: {
  handler: NqaGatewayHandler;
  scope: NqaControlledRolloutScope;
  telemetryStore: NqaOperationalSampleStore;
  nowIso: () => string;
  monotonicMs: () => number;
}): NqaGatewayHandler {
  const scope = verifyNqaControlledRolloutScope(input.scope);

  return async context => {
    if (!targetInScope(scope, context)) {
      return input.handler(context);
    }

    const row = context.target.row!;
    const chapter = context.target.chapter!;
    const started = input.monotonicMs();
    try {
      const result = await input.handler(context);
      const durationMs = Math.max(0, input.monotonicMs() - started);
      const link = monitoringLink(result);
      const observedAt = input.nowIso();
      await input.telemetryStore.append(
        buildNqaOperationalSample({
          sampleId:
            "m19-" +
            hashCanonicalJson({
              requestId: context.requestId,
              scopeFingerprint: scope.scopeFingerprint,
              observedAt,
            }).slice(0, 32),
          scopeId: scope.scopeId,
          scopeFingerprint: scope.scopeFingerprint,
          row,
          chapter,
          status: link ? "SUCCESS" : "ERROR",
          durationMs,
          monitoringRecordId: link?.recordId ?? null,
          monitoringRecordFingerprint: link?.recordFingerprint ?? null,
          errorCode: link ? null : "MONITORING_NOT_PRODUCED",
          observedAt,
        })
      );
      return result;
    } catch (error) {
      const observedAt = input.nowIso();
      await input.telemetryStore.append(
        buildNqaOperationalSample({
          sampleId:
            "m19-" +
            hashCanonicalJson({
              requestId: context.requestId,
              scopeFingerprint: scope.scopeFingerprint,
              observedAt,
            }).slice(0, 32),
          scopeId: scope.scopeId,
          scopeFingerprint: scope.scopeFingerprint,
          row,
          chapter,
          status: "ERROR",
          durationMs: Math.max(0, input.monotonicMs() - started),
          errorCode: errorCode(error),
          observedAt,
        })
      );
      throw error;
    }
  };
}
