import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../core";
import { evaluateNqaProductionSoak, verifyNqaProductionSoakGate } from "./gate";
import { buildNqaOperationalSample } from "./telemetry";
import { buildHealthySoakFixture, TEST_SOAK_CRITERIA } from "./testSupport";

describe("NQA M19 production soak gate", () => {
  it("passes a complete healthy soak window deterministically", async () => {
    const { gate } = await buildHealthySoakFixture();

    expect(gate).toMatchObject({
      decision: "READY_FOR_SCOPE_EXPANSION_REVIEW",
      failureReasons: [],
      windowMinutes: 60,
      metrics: {
        operationalSamples: 2,
        successfulSamples: 2,
        errorSamples: 0,
        linkedMonitoringRecords: 2,
        monitoredTargets: 2,
        targetCoverage: 1,
        errorRate: 0,
        p95LatencyMs: 110,
        healthyCount: 2,
        reviewRequiredCount: 0,
        blockExpansionCount: 0,
      },
    });
    expect(verifyNqaProductionSoakGate(gate)).toEqual(gate);
  });

  it("ignores evidence outside the explicit soak window and holds", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();

    const gate = evaluateNqaProductionSoak({
      state,
      scope: activation.scope,
      monitoringRecords: records,
      operationalSamples: samples,
      windowStart: "2026-09-24T23:00:01+07:00",
      windowEnd: "2026-09-25T00:00:01+07:00",
      criteria: TEST_SOAK_CRITERIA,
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.metrics.operationalSamples).toBe(0);
    expect(gate.metrics.monitoredTargets).toBe(0);
    expect(gate.failureReasons).toEqual(
      expect.arrayContaining([
        "INSUFFICIENT_OPERATIONAL_SAMPLES",
        "INSUFFICIENT_SUCCESSFUL_SAMPLES",
        "INCOMPLETE_TARGET_COVERAGE",
        "LATENCY_EXCEEDED",
      ])
    );
  });

  it("holds when operational error rate or p95 latency exceeds criteria", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();
    const failed = buildNqaOperationalSample({
      sampleId: "m19-error-sample",
      scopeId: activation.scope.scopeId,
      scopeFingerprint: activation.scope.scopeFingerprint,
      row: 2,
      chapter: 197,
      status: "ERROR",
      durationMs: 1_000,
      errorCode: "UPSTREAM_TIMEOUT",
      observedAt: "2026-09-24T22:30:00+07:00",
    });

    const gate = evaluateNqaProductionSoak({
      state,
      scope: activation.scope,
      monitoringRecords: records,
      operationalSamples: [...samples, failed],
      windowStart: "2026-09-24T22:00:00+07:00",
      windowEnd: "2026-09-24T23:00:00+07:00",
      criteria: {
        ...TEST_SOAK_CRITERIA,
        minOperationalSamples: 3,
        maxErrorRate: 0.1,
        maxP95LatencyMs: 500,
      },
    });

    expect(gate.decision).toBe("HOLD");
    expect(gate.metrics.errorRate).toBeCloseTo(1 / 3);
    expect(gate.metrics.p95LatencyMs).toBe(1_000);
    expect(gate.failureReasons).toEqual(
      expect.arrayContaining(["ERROR_RATE_EXCEEDED", "LATENCY_EXCEEDED"])
    );
  });

  it("rejects a successful operational sample linked to another M18 record", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();
    const wrong = buildNqaOperationalSample({
      sampleId: "wrong-link",
      scopeId: activation.scope.scopeId,
      scopeFingerprint: activation.scope.scopeFingerprint,
      row: 2,
      chapter: 197,
      status: "SUCCESS",
      durationMs: 100,
      monitoringRecordId: records[1].recordId,
      monitoringRecordFingerprint: records[1].recordFingerprint,
      observedAt: "2026-09-24T22:20:00+07:00",
    });

    expect(() =>
      evaluateNqaProductionSoak({
        state,
        scope: activation.scope,
        monitoringRecords: records,
        operationalSamples: [samples[0], wrong],
        windowStart: "2026-09-24T22:00:00+07:00",
        windowEnd: "2026-09-24T23:00:00+07:00",
        criteria: TEST_SOAK_CRITERIA,
      })
    ).toThrow("monitoring linkage mismatch");
  });

  it("rejects a fingerprint-valid M18 record whose target is outside the approved scope", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();
    const { recordFingerprint: _ignored, ...payload } = records[0];
    const outOfScope = {
      ...payload,
      row: 999,
      recordFingerprint: hashCanonicalJson({
        scope: "nqa:dual-run-monitoring-record:v1",
        ...payload,
        row: 999,
      }),
    };

    expect(() =>
      evaluateNqaProductionSoak({
        state,
        scope: activation.scope,
        monitoringRecords: [outOfScope, records[1]],
        operationalSamples: samples,
        windowStart: "2026-09-24T22:00:00+07:00",
        windowEnd: "2026-09-24T23:00:00+07:00",
        criteria: TEST_SOAK_CRITERIA,
      })
    ).toThrow("another rollout state or target");
  });

  it("rejects tampered operational evidence", async () => {
    const { activation, state, records, samples } =
      await buildHealthySoakFixture();
    const tampered = { ...samples[0], durationMs: 999 };

    expect(() =>
      evaluateNqaProductionSoak({
        state,
        scope: activation.scope,
        monitoringRecords: records,
        operationalSamples: [tampered, samples[1]],
        windowStart: "2026-09-24T22:00:00+07:00",
        windowEnd: "2026-09-24T23:00:00+07:00",
        criteria: TEST_SOAK_CRITERIA,
      })
    ).toThrow("sample fingerprint mismatch");
  });
});
