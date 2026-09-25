import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  NqaShadowCheckpoint,
  NqaShadowMachineResult,
  NqaShadowRecord,
} from "./contracts";
import { JsonFileNqaShadowStore } from "./store";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

function machine(): NqaShadowMachineResult {
  return {
    decision: "PASS",
    reasonCodes: [],
    stageDecisions: {
      deterministic: "PASS",
      globalSearch: "PASS",
      alignment: null,
      adjudication: null,
      structure: null,
    },
    scores: {
      expectedRank: 1,
      expectedSimilarity: 0.8,
      expectedLeadOverAlternate: 0.1,
      sourceCoverage: null,
      translationCoverage: null,
      meanRerankScore: null,
      minRerankScore: null,
      lowScoreFraction: null,
      sourceGapFraction: null,
      translationGapFraction: null,
      structuredStrongMismatchCount: null,
      structuredStrongMatchCount: null,
    },
    sourceHash: "a".repeat(64),
    translationHash: "b".repeat(64),
    providerVersions: {
      embedding: "local@bge-m3",
      reranker: null,
      adjudication: null,
      structure: null,
    },
    policyVersions: {
      deterministic: "nqa-deterministic-v1",
      semantic: "nqa-semantic-global-v1",
      alignment: null,
      adjudication: null,
      structure: null,
    },
    evidence: [],
  };
}

describe("NQA M13 JSON shadow store", () => {
  it("persists QA-owned checkpoint and evidence records outside production content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-shadow-"));
    cleanup.push(root);
    const store = new JsonFileNqaShadowStore(root);

    const checkpoint: NqaShadowCheckpoint = {
      checkpointVersion: "nqa-shadow-checkpoint-v1",
      runId: "real-batch-001",
      batchFingerprint: "f".repeat(64),
      completedCaseIds: ["case-1"],
      updatedAt: "2026-09-24T20:00:00+07:00",
    };
    const record: NqaShadowRecord = {
      recordVersion: "nqa-shadow-record-v1",
      runId: checkpoint.runId,
      batchFingerprint: checkpoint.batchFingerprint,
      caseId: "case-1",
      row: 1701,
      chapter: 197,
      inputFingerprint: null,
      tags: ["real-world"],
      groundTruth: null,
      machine: machine(),
      evaluatedAt: checkpoint.updatedAt,
      updatedAt: checkpoint.updatedAt,
    };

    await store.putRecord(record);
    await store.saveCheckpoint(checkpoint);

    const updatedRecord: NqaShadowRecord = {
      ...record,
      tags: ["real-world", "labeled-later"],
      updatedAt: "2026-09-24T20:05:00+07:00",
    };
    const updatedCheckpoint: NqaShadowCheckpoint = {
      ...checkpoint,
      updatedAt: updatedRecord.updatedAt,
    };

    await store.putRecord(updatedRecord);
    await store.saveCheckpoint(updatedCheckpoint);

    expect(await store.loadCheckpoint(checkpoint.runId)).toEqual(
      updatedCheckpoint
    );
    expect(await store.getRecord(checkpoint.runId, record.caseId)).toEqual(
      updatedRecord
    );
    expect(await store.listRecords(checkpoint.runId)).toEqual([updatedRecord]);

    const persisted = await fs.readFile(
      path.join(root, checkpoint.runId, "records", record.caseId + ".json"),
      "utf8"
    );
    expect(persisted).not.toContain("sourceText");
    expect(persisted).not.toContain("translationText");
  });
});
