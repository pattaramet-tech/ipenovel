import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NqaShadowRecord } from "../shadow/contracts";
import { JsonFileNqaReviewJournalStore } from "./store";
import { createNqaReviewAction } from "./workflow";

const cleanup: string[] = [];
const SOURCE_HASH = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0)
      .map(directory => fs.rm(directory, { recursive: true, force: true }))
  );
});

function record(): NqaShadowRecord {
  return {
    recordVersion: "nqa-shadow-record-v1",
    runId: "run-store",
    batchFingerprint: "f".repeat(64),
    caseId: "case-001",
    row: 1701,
    chapter: 197,
    inputFingerprint: null,
    tags: [],
    groundTruth: null,
    machine: {
      decision: "PASS",
      reasonCodes: [],
      stageDecisions: {
        deterministic: "PASS",
        globalSearch: null,
        alignment: null,
        adjudication: null,
        structure: null,
      },
      scores: {
        expectedRank: null,
        expectedSimilarity: null,
        expectedLeadOverAlternate: null,
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
      sourceHash: SOURCE_HASH,
      translationHash: "b".repeat(64),
      providerVersions: {
        embedding: null,
        reranker: null,
        adjudication: null,
        structure: null,
      },
      policyVersions: {
        deterministic: "det-v1",
        semantic: "semantic-v1",
        alignment: null,
        adjudication: null,
        structure: null,
      },
      evidence: [],
    },
    evaluatedAt: "2026-09-24T20:00:00+07:00",
    updatedAt: "2026-09-24T20:00:00+07:00",
  };
}

describe("NQA M14 append-only review journal store", () => {
  it("persists each review action as an immutable JSON file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-review-"));
    cleanup.push(root);
    const store = new JsonFileNqaReviewJournalStore(root);
    const source = record();

    const first = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: { decision: "PASS", reasonCodes: [] },
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:01:00+07:00",
    });
    await store.appendAction(first);

    const second = createNqaReviewAction({
      record: source,
      existingActions: [first],
      actionId: "action-002",
      actionType: "CONFIRM",
      reviewerId: "reviewer-b",
      label: { decision: "PASS", reasonCodes: [] },
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:02:00+07:00",
    });
    await store.appendAction(second);

    expect(await store.listActions(source.runId, source.caseId)).toEqual([
      first,
      second,
    ]);

    const directory = path.join(
      root,
      source.runId,
      "review",
      source.caseId,
      "actions"
    );
    expect(
      (await fs.readdir(directory)).filter(name => name.endsWith(".json"))
    ).toHaveLength(2);
  });

  it("rejects attempts to append the same action twice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nqa-review-"));
    cleanup.push(root);
    const store = new JsonFileNqaReviewJournalStore(root);
    const source = record();
    const action = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "action-001",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: { decision: "PASS", reasonCodes: [] },
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:01:00+07:00",
    });

    await store.appendAction(action);
    await expect(store.appendAction(action)).rejects.toThrow(
      "Review actionId already exists."
    );
  });
});
