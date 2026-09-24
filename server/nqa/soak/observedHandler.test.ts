import { describe, expect, it } from "vitest";

import type { NqaGatewayHandlerContext } from "../mcp/handlers";
import { createNqaSoakObservedHandler } from "./observedHandler";
import { InMemoryNqaOperationalSampleStore } from "./telemetry";
import { buildHealthySoakFixture } from "./testSupport";

function context(row: number): NqaGatewayHandlerContext {
  return {
    principal: {
      principalId: "qa-operator",
      sessionId: "m19-session",
      permissions: ["QA_OPERATE"],
      authenticated: true,
    },
    requestId: "m19-request-" + row,
    correlationId: "m19-correlation-" + row,
    capability: "nqa.qa.run_semantic",
    target: { row, chapter: 197 },
    inputFingerprint: null,
  };
}

describe("NQA M19 operational observation wrapper", () => {
  it("records linked latency for successful in-scope M18 execution", async () => {
    const { activation } = await buildHealthySoakFixture({
      targets: [{ row: 2, chapter: 197 }],
    });
    const telemetry = new InMemoryNqaOperationalSampleStore();
    const ticks = [100, 180];
    const handler = createNqaSoakObservedHandler({
      scope: activation.scope,
      telemetryStore: telemetry,
      nowIso: () => "2026-09-24T22:20:00+07:00",
      monotonicMs: () => ticks.shift()!,
      handler: async () => ({
        status: "PASS",
        rollout: {
          monitoring: {
            recordId: "record-live",
            recordFingerprint: "a".repeat(64),
          },
        },
      }),
    });

    await handler(context(2));
    expect(await telemetry.list(activation.scope.scopeId)).toMatchObject([
      {
        status: "SUCCESS",
        durationMs: 80,
        monitoringRecordId: "record-live",
        monitoringRecordFingerprint: "a".repeat(64),
        errorCode: null,
      },
    ]);
  });

  it("records a bounded error sample and rethrows execution failure", async () => {
    const { activation } = await buildHealthySoakFixture({
      targets: [{ row: 2, chapter: 197 }],
    });
    const telemetry = new InMemoryNqaOperationalSampleStore();
    const ticks = [10, 60];
    const handler = createNqaSoakObservedHandler({
      scope: activation.scope,
      telemetryStore: telemetry,
      nowIso: () => "2026-09-24T22:20:00+07:00",
      monotonicMs: () => ticks.shift()!,
      handler: async () => {
        const error = new Error("secret upstream details");
        (error as Error & { code: string }).code = "UPSTREAM_TIMEOUT";
        throw error;
      },
    });

    await expect(handler(context(2))).rejects.toThrow(
      "secret upstream details"
    );
    expect(await telemetry.list(activation.scope.scopeId)).toMatchObject([
      {
        status: "ERROR",
        durationMs: 50,
        monitoringRecordId: null,
        monitoringRecordFingerprint: null,
        errorCode: "UPSTREAM_TIMEOUT",
      },
    ]);
  });

  it("does not emit soak telemetry for out-of-scope traffic", async () => {
    const { activation } = await buildHealthySoakFixture({
      targets: [{ row: 3, chapter: 197 }],
    });
    const telemetry = new InMemoryNqaOperationalSampleStore();
    const handler = createNqaSoakObservedHandler({
      scope: activation.scope,
      telemetryStore: telemetry,
      nowIso: () => "2026-09-24T22:20:00+07:00",
      monotonicMs: () => 1,
      handler: async () => ({ status: "PASS" }),
    });

    await handler(context(2));
    expect(await telemetry.list(activation.scope.scopeId)).toEqual([]);
  });
});
