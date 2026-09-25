import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import {
  InMemoryNqaDualRunMonitoringStore,
  JsonFileNqaDualRunMonitoringStore,
  buildNqaDualRunMonitoringRecord,
  evaluateNqaRolloutMonitoring,
} from "./monitoring";
import { resolveNqaRuntimeAlignmentPolicy } from "./resolver";
import { buildActivatedRolloutFixture } from "./testSupport";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

function semantic(
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
      },
      evidence: [],
      policyVersion: "fixture-deterministic",
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
        meanRerankScore: 0.7,
        minRerankScore: 0.7,
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

describe("NQA M18 dual-run monitoring", () => {
  it("blocks expansion when the candidate is more permissive than baseline", async () => {
    const { store, scope } = await buildActivatedRolloutFixture();
    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store,
      scope,
      row: 2,
      chapter: 197,
    });
    const record = buildNqaDualRunMonitoringRecord({
      recordId: "record-more-permissive",
      row: 2,
      chapter: 197,
      resolution,
      baseline: semantic("FAIL", resolution.baselinePolicy.version),
      candidate: semantic("PASS", resolution.candidatePolicy!.version),
      observedAt: "2026-09-24T22:04:00+07:00",
    });

    expect(record).toMatchObject({
      health: "BLOCK_EXPANSION",
      comparison: {
        decisionChanged: true,
        candidateMorePermissive: true,
      },
    });
    expect(
      evaluateNqaRolloutMonitoring({ scope, records: [record] })
    ).toMatchObject({
      decision: "HOLD",
      failureReasons: ["BLOCK_EXPANSION"],
    });
  });

  it("requires complete healthy scope coverage before manual expansion review", async () => {
    const { store, scope } = await buildActivatedRolloutFixture({
      targets: [
        { row: 2, chapter: 197 },
        { row: 3, chapter: 198 },
      ],
    });
    const make = async (row: number, chapter: number, recordId: string) => {
      const resolution = await resolveNqaRuntimeAlignmentPolicy({
        store,
        scope,
        row,
        chapter,
      });
      return buildNqaDualRunMonitoringRecord({
        recordId,
        row,
        chapter,
        resolution,
        baseline: semantic("PASS", resolution.baselinePolicy.version),
        candidate: semantic("PASS", resolution.candidatePolicy!.version),
        observedAt: "2026-09-24T22:04:00+07:00",
      });
    };

    const first = await make(2, 197, "record-1");
    expect(
      evaluateNqaRolloutMonitoring({ scope, records: [first] })
    ).toMatchObject({
      decision: "HOLD",
      failureReasons: ["INCOMPLETE_SCOPE_COVERAGE"],
    });

    const second = await make(3, 198, "record-2");
    expect(
      evaluateNqaRolloutMonitoring({ scope, records: [first, second] })
    ).toMatchObject({
      decision: "READY_FOR_MANUAL_EXPANSION_REVIEW",
      monitoredTargetCount: 2,
      healthyCount: 2,
      failureReasons: [],
    });
  });

  it("persists bounded monitoring records append-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-m18-monitor-"));
    cleanup.push(root);
    const { store, scope } = await buildActivatedRolloutFixture();
    const resolution = await resolveNqaRuntimeAlignmentPolicy({
      store,
      scope,
      row: 2,
      chapter: 197,
    });
    const record = buildNqaDualRunMonitoringRecord({
      recordId: "durable-record",
      row: 2,
      chapter: 197,
      resolution,
      baseline: semantic("PASS", resolution.baselinePolicy.version),
      candidate: semantic("PASS", resolution.candidatePolicy!.version),
      observedAt: "2026-09-24T22:04:00+07:00",
    });
    const durable = new JsonFileNqaDualRunMonitoringStore(root);
    await durable.append(record);

    expect(await durable.list(scope.scopeId)).toEqual([record]);
    await expect(durable.append(record)).rejects.toMatchObject({
      code: "EEXIST",
    });

    const memory = new InMemoryNqaDualRunMonitoringStore();
    await memory.append(record);
    await expect(memory.append(record)).rejects.toThrow(
      "recordId already exists"
    );
  });
});
