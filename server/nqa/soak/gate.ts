import { hashCanonicalJson } from "../core";
import type { NqaPolicyRegistryState } from "../activation/contracts";
import type {
  NqaControlledRolloutScope,
  NqaDualRunMonitoringRecord,
} from "../rollout/contracts";
import { verifyNqaDualRunMonitoringRecord } from "../rollout/monitoring";
import { verifyNqaControlledRolloutScope } from "../rollout/resolver";
import {
  NQA_SOAK_GATE_VERSION,
  NqaProductionSoakGateSchema,
  NqaSoakCriteriaSchema,
  type NqaOperationalSample,
  type NqaProductionSoakGate,
  type NqaSoakCriteria,
} from "./contracts";
import { verifyNqaOperationalSample } from "./telemetry";

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(label + " is not a valid timestamp.");
  return parsed;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function ratio(part: number, total: number): number {
  return total <= 0 ? 0 : part / total;
}

export function evaluateNqaProductionSoak(input: {
  state: NqaPolicyRegistryState;
  scope: NqaControlledRolloutScope;
  monitoringRecords: readonly NqaDualRunMonitoringRecord[];
  operationalSamples: readonly NqaOperationalSample[];
  windowStart: string;
  windowEnd: string;
  criteria: NqaSoakCriteria;
}): NqaProductionSoakGate {
  const scope = verifyNqaControlledRolloutScope(input.scope);
  const criteria = NqaSoakCriteriaSchema.parse(input.criteria);
  const startMs = parseTime(input.windowStart, "M19 soak windowStart");
  const endMs = parseTime(input.windowEnd, "M19 soak windowEnd");
  if (endMs <= startMs)
    throw new Error("M19 soak windowEnd must be after windowStart.");

  if (
    !input.state.rollbackTarget ||
    input.state.revision !== scope.expectedRegistryRevision ||
    input.state.stateFingerprint !== scope.expectedRegistryStateFingerprint ||
    input.state.lastTransactionId !== scope.sourceActivationTransactionId ||
    input.state.activePolicyFingerprint !== scope.candidatePolicyFingerprint ||
    input.state.rollbackTarget.policyFingerprint !==
      scope.baselinePolicyFingerprint
  ) {
    throw new Error(
      "M19 soak scope is stale or incompatible with current M17 registry state."
    );
  }

  const records = input.monitoringRecords
    .map(verifyNqaDualRunMonitoringRecord)
    .filter(record => {
      const observed = parseTime(
        record.observedAt,
        "M18 monitoring observedAt"
      );
      return observed >= startMs && observed <= endMs;
    })
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.recordId.localeCompare(right.recordId)
    );

  const samples = input.operationalSamples
    .map(verifyNqaOperationalSample)
    .filter(sample => {
      const observed = parseTime(sample.observedAt, "M19 sample observedAt");
      return observed >= startMs && observed <= endMs;
    })
    .sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.sampleId.localeCompare(right.sampleId)
    );

  for (const record of records) {
    const inScope = scope.targets.some(
      target => target.row === record.row && target.chapter === record.chapter
    );
    if (
      record.scopeId !== scope.scopeId ||
      record.scopeFingerprint !== scope.scopeFingerprint ||
      record.registryRevision !== input.state.revision ||
      record.registryStateFingerprint !== input.state.stateFingerprint ||
      record.sourceActivationTransactionId !==
        scope.sourceActivationTransactionId ||
      record.candidatePolicyFingerprint !== scope.candidatePolicyFingerprint ||
      record.baselinePolicyFingerprint !== scope.baselinePolicyFingerprint ||
      !inScope
    ) {
      throw new Error(
        "M19 soak contains an M18 record from another rollout state or target."
      );
    }
  }

  const recordByFingerprint = new Map(
    records.map(record => [record.recordFingerprint, record])
  );
  for (const sample of samples) {
    if (
      sample.scopeId !== scope.scopeId ||
      sample.scopeFingerprint !== scope.scopeFingerprint
    ) {
      throw new Error(
        "M19 operational sample belongs to another rollout scope."
      );
    }
    const inScope = scope.targets.some(
      target => target.row === sample.row && target.chapter === sample.chapter
    );
    if (!inScope) {
      throw new Error(
        "M19 operational sample target is outside rollout scope."
      );
    }
    if (sample.status === "SUCCESS") {
      const linked = sample.monitoringRecordFingerprint
        ? recordByFingerprint.get(sample.monitoringRecordFingerprint)
        : null;
      if (
        !linked ||
        linked.recordId !== sample.monitoringRecordId ||
        linked.row !== sample.row ||
        linked.chapter !== sample.chapter
      ) {
        throw new Error(
          "M19 operational sample M18 monitoring linkage mismatch."
        );
      }
    }
  }

  const successfulSamples = samples.filter(
    sample => sample.status === "SUCCESS"
  );
  const errorSamples = samples.filter(sample => sample.status === "ERROR");
  const linkedMonitoring = new Set(
    successfulSamples
      .map(sample => sample.monitoringRecordFingerprint)
      .filter((value): value is string => Boolean(value))
  );
  const monitoredTargets = new Set(
    records.map(record => record.row + ":" + record.chapter)
  );
  const targetCoverage = ratio(monitoredTargets.size, scope.targets.length);
  const errorRate = ratio(errorSamples.length, samples.length);
  const p95LatencyMs = percentile95(samples.map(sample => sample.durationMs));
  const reviewRequiredCount = records.filter(
    record => record.health === "REVIEW_REQUIRED"
  ).length;
  const blockExpansionCount = records.filter(
    record => record.health === "BLOCK_EXPANSION"
  ).length;
  const healthyCount = records.filter(
    record => record.health === "HEALTHY"
  ).length;
  const windowMinutes = (endMs - startMs) / 60_000;

  const failureReasons: NqaProductionSoakGate["failureReasons"] = [];
  if (windowMinutes < criteria.minWindowMinutes) {
    failureReasons.push("SOAK_WINDOW_TOO_SHORT");
  }
  if (samples.length < criteria.minOperationalSamples) {
    failureReasons.push("INSUFFICIENT_OPERATIONAL_SAMPLES");
  }
  if (successfulSamples.length < criteria.minSuccessfulSamples) {
    failureReasons.push("INSUFFICIENT_SUCCESSFUL_SAMPLES");
  }
  if (targetCoverage < criteria.minTargetCoverage) {
    failureReasons.push("INCOMPLETE_TARGET_COVERAGE");
  }
  if (errorRate > criteria.maxErrorRate) {
    failureReasons.push("ERROR_RATE_EXCEEDED");
  }
  if (p95LatencyMs === null || p95LatencyMs > criteria.maxP95LatencyMs) {
    failureReasons.push("LATENCY_EXCEEDED");
  }
  if (linkedMonitoring.size !== successfulSamples.length) {
    failureReasons.push("MISSING_MONITORING_LINKAGE");
  }
  if (criteria.requireZeroReviewRequired && reviewRequiredCount > 0) {
    failureReasons.push("REVIEW_REQUIRED");
  }
  if (criteria.requireZeroBlockExpansion && blockExpansionCount > 0) {
    failureReasons.push("BLOCK_EXPANSION");
  }

  const evidenceFingerprint = hashCanonicalJson({
    scope: "nqa:production-soak-evidence:v1",
    scopeFingerprint: scope.scopeFingerprint,
    monitoring: records.map(record => ({
      recordId: record.recordId,
      recordFingerprint: record.recordFingerprint,
    })),
    operationalSamples: samples.map(sample => ({
      sampleId: sample.sampleId,
      sampleFingerprint: sample.sampleFingerprint,
    })),
  });

  const withoutFingerprint = {
    gateVersion: NQA_SOAK_GATE_VERSION,
    scopeId: scope.scopeId,
    scopeFingerprint: scope.scopeFingerprint,
    sourceActivationTransactionId: scope.sourceActivationTransactionId,
    registryRevision: input.state.revision,
    registryStateFingerprint: input.state.stateFingerprint,
    candidatePolicyFingerprint: scope.candidatePolicyFingerprint,
    baselinePolicyFingerprint: scope.baselinePolicyFingerprint,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    windowMinutes,
    criteria,
    metrics: {
      operationalSamples: samples.length,
      successfulSamples: successfulSamples.length,
      errorSamples: errorSamples.length,
      linkedMonitoringRecords: linkedMonitoring.size,
      monitoredTargets: monitoredTargets.size,
      targetCoverage,
      errorRate,
      p95LatencyMs,
      healthyCount,
      reviewRequiredCount,
      blockExpansionCount,
    },
    failureReasons,
    decision:
      failureReasons.length === 0
        ? ("READY_FOR_SCOPE_EXPANSION_REVIEW" as const)
        : ("HOLD" as const),
    evidenceFingerprint,
  };

  return NqaProductionSoakGateSchema.parse({
    ...withoutFingerprint,
    artifactFingerprint: hashCanonicalJson({
      scope: "nqa:production-soak-gate:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaProductionSoakGate(
  input: NqaProductionSoakGate
): NqaProductionSoakGate {
  const gate = NqaProductionSoakGateSchema.parse(input);
  const { artifactFingerprint, ...withoutFingerprint } = gate;
  const expected = hashCanonicalJson({
    scope: "nqa:production-soak-gate:v1",
    ...withoutFingerprint,
  });
  if (artifactFingerprint !== expected) {
    throw new Error("M19 production soak artifact fingerprint mismatch.");
  }
  return gate;
}
