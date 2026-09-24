import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import { buildNqaDualRunMonitoringRecord } from "../rollout/monitoring";
import { resolveNqaRuntimeAlignmentPolicy } from "../rollout/resolver";
import { buildActivatedRolloutFixture } from "../rollout/testSupport";
import { evaluateNqaProductionSoak } from "./gate";
import { buildNqaOperationalSample } from "./telemetry";
import type { NqaSoakCriteria } from "./contracts";

export const TEST_SOAK_CRITERIA: NqaSoakCriteria = {
  minWindowMinutes: 60,
  minOperationalSamples: 2,
  minSuccessfulSamples: 2,
  minTargetCoverage: 1,
  maxErrorRate: 0,
  maxP95LatencyMs: 500,
  requireZeroReviewRequired: true,
  requireZeroBlockExpansion: true,
};

export function semanticFixture(
  decision: "PASS" | "REVIEW" | "FAIL",
  policyVersion: string
): NqaSemanticQaStageResult {
  return {
    decision,
    reasonCodes: decision === "PASS" ? [] : ["ALIGNMENT_UNCERTAIN"],
    deterministic: {
      decision: "PASS",
      reasonCodes: [],
      metrics: {
        sourceChars: 300,
        translationChars: 300,
        lengthRatio: 1,
        sourceParagraphs: 2,
        translationParagraphs: 2,
        paragraphRatio: 1,
        exactDuplicate: false,
        repeatedParagraphs: [],
        foreignTextHits: [],
        malformedSource: false,
        malformedTranslation: false,
        hasTranslationEndingMarker: true,
      },
      evidence: [],
      policyVersion: "fixture-deterministic",
      resolverStatus: "RESOLVED",
      resolverReasonCodes: [],
    },
    globalSearch: null,
    alignment: {
      decision,
      reasonCodes: decision === "PASS" ? [] : ["ALIGNMENT_UNCERTAIN"],
      metrics: {
        sourceChunkCount: 1,
        translationChunkCount: 1,
        alignedPairCount: 1,
        sourceCoverage: 1,
        translationCoverage: 1,
        meanRerankScore: 0.9,
        minRerankScore: 0.9,
        lowScoreFraction: 0,
        sourceGapFraction: 0,
        translationGapFraction: 0,
      },
      alignedPairs: [],
      gaps: [],
      providerId: "fixture-reranker",
      modelVersion: "fixture-v1",
      policyVersion,
      evidence: [],
    },
    adjudication: null,
    structure: null,
    policyVersion: "fixture-semantic",
  };
}

export async function buildHealthySoakFixture(input?: {
  targets?: readonly { row: number; chapter: number }[];
}) {
  const targets = input?.targets ?? [
    { row: 2, chapter: 197 },
    { row: 3, chapter: 198 },
  ];
  const activation = await buildActivatedRolloutFixture({ targets });
  const records = [];
  const samples = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store: activation.store,
      scope: activation.scope,
      row: target.row,
      chapter: target.chapter,
    });
    const observedAt =
      "2026-09-24T22:" + String(10 + index).padStart(2, "0") + ":00+07:00";
    const record = buildNqaDualRunMonitoringRecord({
      recordId: "m19-record-" + index,
      row: target.row,
      chapter: target.chapter,
      resolution,
      baseline: semanticFixture("PASS", resolution.baselinePolicy.version),
      candidate: semanticFixture("PASS", resolution.candidatePolicy!.version),
      observedAt,
    });
    records.push(record);
    samples.push(
      buildNqaOperationalSample({
        sampleId: "m19-sample-" + index,
        scopeId: activation.scope.scopeId,
        scopeFingerprint: activation.scope.scopeFingerprint,
        row: target.row,
        chapter: target.chapter,
        status: "SUCCESS",
        durationMs: 100 + index * 10,
        monitoringRecordId: record.recordId,
        monitoringRecordFingerprint: record.recordFingerprint,
        observedAt,
      })
    );
  }

  const state = await activation.store.readState();
  const gate = evaluateNqaProductionSoak({
    state,
    scope: activation.scope,
    monitoringRecords: records,
    operationalSamples: samples,
    windowStart: "2026-09-24T22:00:00+07:00",
    windowEnd: "2026-09-24T23:00:00+07:00",
    criteria: {
      ...TEST_SOAK_CRITERIA,
      minOperationalSamples: targets.length,
      minSuccessfulSamples: targets.length,
    },
  });

  return { activation, state, records, samples, gate };
}
