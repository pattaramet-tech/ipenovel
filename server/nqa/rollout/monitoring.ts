import fs from "node:fs/promises";
import path from "node:path";

import { hashCanonicalJson } from "../core";
import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import {
  NQA_DUAL_RUN_RECORD_VERSION,
  NqaDualRunMonitoringRecordSchema,
  NqaRolloutMonitoringSummarySchema,
  type NqaControlledRolloutScope,
  type NqaDualRunMonitoringRecord,
  type NqaRolloutMonitoringSummary,
  type NqaRuntimePolicyResolution,
} from "./contracts";
import { verifyNqaControlledRolloutScope } from "./resolver";

export interface NqaDualRunMonitoringStore {
  append(record: NqaDualRunMonitoringRecord): Promise<void>;
  list(scopeId: string): Promise<NqaDualRunMonitoringRecord[]>;
}

function severity(decision: "PASS" | "REVIEW" | "FAIL"): number {
  return decision === "PASS" ? 0 : decision === "REVIEW" ? 1 : 2;
}

function boundedSnapshot(result: NqaSemanticQaStageResult) {
  return {
    decision: result.decision,
    reasonCodes: [...result.reasonCodes].slice(0, 30),
    alignment: result.alignment
      ? {
          decision: result.alignment.decision,
          reasonCodes: [...result.alignment.reasonCodes].slice(0, 30),
          policyVersion: result.alignment.policyVersion,
          providerId: result.alignment.providerId,
          modelVersion: result.alignment.modelVersion,
          metrics: {
            alignedPairCount: result.alignment.metrics.alignedPairCount,
            sourceCoverage: result.alignment.metrics.sourceCoverage,
            translationCoverage: result.alignment.metrics.translationCoverage,
            meanRerankScore: result.alignment.metrics.meanRerankScore,
            minRerankScore: result.alignment.metrics.minRerankScore,
            lowScoreFraction: result.alignment.metrics.lowScoreFraction,
            sourceGapFraction: result.alignment.metrics.sourceGapFraction,
            translationGapFraction:
              result.alignment.metrics.translationGapFraction,
          },
        }
      : null,
  };
}

export function buildNqaDualRunMonitoringRecord(input: {
  recordId: string;
  row: number;
  chapter: number;
  resolution: NqaRuntimePolicyResolution;
  baseline: NqaSemanticQaStageResult;
  candidate: NqaSemanticQaStageResult;
  observedAt: string;
}): NqaDualRunMonitoringRecord {
  if (
    !input.resolution.dualRun ||
    !input.resolution.scopeId ||
    !input.resolution.scopeFingerprint ||
    !input.resolution.sourceActivationTransactionId ||
    !input.resolution.candidatePolicyFingerprint
  ) {
    throw new Error(
      "M18 dual-run evidence requires an in-scope candidate resolution."
    );
  }

  const baseline = boundedSnapshot(input.baseline);
  const candidate = boundedSnapshot(input.candidate);
  const baselineSeverity = severity(baseline.decision);
  const candidateSeverity = severity(candidate.decision);
  const comparison = {
    decisionChanged: baseline.decision !== candidate.decision,
    candidateMorePermissive: candidateSeverity < baselineSeverity,
    candidateMoreStrict: candidateSeverity > baselineSeverity,
  };
  const health = comparison.candidateMorePermissive
    ? ("BLOCK_EXPANSION" as const)
    : comparison.candidateMoreStrict
      ? ("REVIEW_REQUIRED" as const)
      : ("HEALTHY" as const);

  const withoutFingerprint = {
    recordVersion: NQA_DUAL_RUN_RECORD_VERSION,
    recordId: input.recordId,
    row: input.row,
    chapter: input.chapter,
    scopeId: input.resolution.scopeId,
    scopeFingerprint: input.resolution.scopeFingerprint,
    registryRevision: input.resolution.registryRevision,
    registryStateFingerprint: input.resolution.registryStateFingerprint,
    sourceActivationTransactionId:
      input.resolution.sourceActivationTransactionId,
    baselinePolicyFingerprint: input.resolution.baselinePolicyFingerprint,
    candidatePolicyFingerprint: input.resolution.candidatePolicyFingerprint,
    baseline,
    candidate,
    comparison,
    health,
    observedAt: input.observedAt,
  };

  return NqaDualRunMonitoringRecordSchema.parse({
    ...withoutFingerprint,
    recordFingerprint: hashCanonicalJson({
      scope: "nqa:dual-run-monitoring-record:v1",
      ...withoutFingerprint,
    }),
  });
}

export function verifyNqaDualRunMonitoringRecord(
  input: NqaDualRunMonitoringRecord
): NqaDualRunMonitoringRecord {
  const record = NqaDualRunMonitoringRecordSchema.parse(input);
  const { recordFingerprint, ...withoutFingerprint } = record;
  if (
    recordFingerprint !==
    hashCanonicalJson({
      scope: "nqa:dual-run-monitoring-record:v1",
      ...withoutFingerprint,
    })
  ) {
    throw new Error("M18 dual-run monitoring record fingerprint mismatch.");
  }
  return record;
}

export class InMemoryNqaDualRunMonitoringStore implements NqaDualRunMonitoringStore {
  private readonly records: NqaDualRunMonitoringRecord[] = [];

  async append(record: NqaDualRunMonitoringRecord): Promise<void> {
    const parsed = verifyNqaDualRunMonitoringRecord(record);
    if (this.records.some(item => item.recordId === parsed.recordId)) {
      throw new Error("M18 dual-run monitoring recordId already exists.");
    }
    this.records.push(structuredClone(parsed));
  }

  async list(scopeId: string): Promise<NqaDualRunMonitoringRecord[]> {
    return structuredClone(
      this.records
        .filter(record => record.scopeId === scopeId)
        .sort(
          (left, right) =>
            left.row - right.row ||
            left.chapter - right.chapter ||
            left.recordId.localeCompare(right.recordId)
        )
    );
  }
}

export class JsonFileNqaDualRunMonitoringStore implements NqaDualRunMonitoringStore {
  constructor(private readonly rootDir: string) {
    if (!rootDir.trim()) {
      throw new Error("M18 monitoring rootDir is required.");
    }
  }

  private scopeDir(scopeId: string): string {
    return path.join(this.rootDir, scopeId);
  }

  async append(record: NqaDualRunMonitoringRecord): Promise<void> {
    const parsed = verifyNqaDualRunMonitoringRecord(record);
    const directory = this.scopeDir(parsed.scopeId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(
        directory,
        parsed.recordId + "-" + parsed.recordFingerprint + ".json"
      ),
      JSON.stringify(parsed, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" }
    );
  }

  async list(scopeId: string): Promise<NqaDualRunMonitoringRecord[]> {
    const directory = this.scopeDir(scopeId);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const records: NqaDualRunMonitoringRecord[] = [];
    for (const name of names.filter(name => name.endsWith(".json")).sort()) {
      const content = await fs.readFile(path.join(directory, name), "utf8");
      records.push(verifyNqaDualRunMonitoringRecord(JSON.parse(content)));
    }
    return records.sort(
      (left, right) =>
        left.row - right.row ||
        left.chapter - right.chapter ||
        left.recordId.localeCompare(right.recordId)
    );
  }
}

export function evaluateNqaRolloutMonitoring(input: {
  scope: NqaControlledRolloutScope;
  records: readonly NqaDualRunMonitoringRecord[];
}): NqaRolloutMonitoringSummary {
  const scope = verifyNqaControlledRolloutScope(input.scope);
  const records = input.records.map(verifyNqaDualRunMonitoringRecord);

  for (const record of records) {
    if (
      record.scopeId !== scope.scopeId ||
      record.scopeFingerprint !== scope.scopeFingerprint ||
      record.sourceActivationTransactionId !==
        scope.sourceActivationTransactionId ||
      record.baselinePolicyFingerprint !== scope.baselinePolicyFingerprint ||
      record.candidatePolicyFingerprint !== scope.candidatePolicyFingerprint
    ) {
      throw new Error(
        "M18 monitoring record does not belong to rollout scope."
      );
    }
  }

  const monitored = new Set(
    records.map(record => record.row + ":" + record.chapter)
  );
  const monitoredTargetCount = scope.targets.filter(target =>
    monitored.has(target.row + ":" + target.chapter)
  ).length;
  const healthyCount = records.filter(
    record => record.health === "HEALTHY"
  ).length;
  const reviewRequiredCount = records.filter(
    record => record.health === "REVIEW_REQUIRED"
  ).length;
  const blockExpansionCount = records.filter(
    record => record.health === "BLOCK_EXPANSION"
  ).length;

  const failureReasons: Array<
    "INCOMPLETE_SCOPE_COVERAGE" | "REVIEW_REQUIRED" | "BLOCK_EXPANSION"
  > = [];
  if (monitoredTargetCount !== scope.targets.length) {
    failureReasons.push("INCOMPLETE_SCOPE_COVERAGE");
  }
  if (reviewRequiredCount > 0) failureReasons.push("REVIEW_REQUIRED");
  if (blockExpansionCount > 0) failureReasons.push("BLOCK_EXPANSION");

  const fingerprintPayload = records.map(record => ({
    recordId: record.recordId,
    recordFingerprint: record.recordFingerprint,
  }));

  return NqaRolloutMonitoringSummarySchema.parse({
    scopeId: scope.scopeId,
    scopeFingerprint: scope.scopeFingerprint,
    targetCount: scope.targets.length,
    monitoredTargetCount,
    recordCount: records.length,
    healthyCount,
    reviewRequiredCount,
    blockExpansionCount,
    decision:
      failureReasons.length === 0
        ? "READY_FOR_MANUAL_EXPANSION_REVIEW"
        : "HOLD",
    failureReasons,
    datasetFingerprint: hashCanonicalJson({
      scope: "nqa:dual-run-monitoring-dataset:v1",
      scopeFingerprint: scope.scopeFingerprint,
      records: fingerprintPayload,
    }),
  });
}
