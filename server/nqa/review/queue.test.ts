import { describe, expect, it } from "vitest";

import type { NqaShadowRecord } from "../shadow/contracts";
import { buildNqaReviewQueue } from "./queue";
import { createNqaReviewAction } from "./workflow";

const SOURCE_HASH = "a".repeat(64);
const TRANSLATION_HASH = "b".repeat(64);

function record(input: {
  caseId: string;
  row: number;
  decision: "PASS" | "REVIEW" | "FAIL";
  groundTruth?: NqaShadowRecord["groundTruth"];
}): NqaShadowRecord {
  return {
    recordVersion: "nqa-shadow-record-v1",
    runId: "run-queue",
    batchFingerprint: "f".repeat(64),
    caseId: input.caseId,
    row: input.row,
    chapter: 197,
    inputFingerprint: null,
    tags: [],
    groundTruth: input.groundTruth ?? null,
    machine: {
      decision: input.decision,
      reasonCodes: input.decision === "REVIEW" ? ["HUMAN_REVIEW_REQUIRED"] : [],
      stageDecisions: {
        deterministic: input.decision,
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
      translationHash: TRANSLATION_HASH,
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
      evidence: [
        {
          stage: "M08_DETERMINISTIC",
          evidenceId: "ev-1",
          sourceHash: SOURCE_HASH,
          translationHash: TRANSLATION_HASH,
          boundedSummary: "bounded",
        },
      ],
    },
    evaluatedAt: "2026-09-24T20:00:00+07:00",
    updatedAt: "2026-09-24T20:00:00+07:00",
  };
}

describe("NQA M14 deterministic review queue", () => {
  it("prioritizes disputed, proposed, machine-review, then unlabeled cases", () => {
    const disputed = record({
      caseId: "case-disputed",
      row: 1704,
      decision: "PASS",
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "HUMAN_CONFIRMED",
        labeledBy: "reviewer-a",
        labeledAt: "2026-09-24T20:00:00+07:00",
        notes: [],
      },
    });
    const dispute = createNqaReviewAction({
      record: disputed,
      existingActions: [],
      actionId: "dispute-1",
      actionType: "DISPUTE",
      reviewerId: "reviewer-b",
      label: {
        decision: "FAIL",
        reasonCodes: ["MEANING_DIVERGENCE"],
      },
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:10:00+07:00",
    });

    const proposed = record({
      caseId: "case-proposed",
      row: 1703,
      decision: "PASS",
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
        labeledBy: null,
        labeledAt: null,
        notes: [],
      },
    });
    const machineReview = record({
      caseId: "case-review",
      row: 1702,
      decision: "REVIEW",
    });
    const unlabeled = record({
      caseId: "case-unlabeled",
      row: 1701,
      decision: "PASS",
    });
    const confirmed = record({
      caseId: "case-final",
      row: 1700,
      decision: "PASS",
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "HUMAN_CONFIRMED",
        labeledBy: "reviewer-a",
        labeledAt: "2026-09-24T20:00:00+07:00",
        notes: [],
      },
    });

    const actions = new Map([["case-disputed", [dispute]]]);
    const queue = buildNqaReviewQueue({
      records: [unlabeled, confirmed, machineReview, proposed, disputed],
      actionsByCaseId: actions,
    });

    expect(queue.map(item => item.caseId)).toEqual([
      "case-disputed",
      "case-proposed",
      "case-review",
      "case-unlabeled",
    ]);
    expect(queue.map(item => item.queueReason)).toEqual([
      "DISPUTED_LABEL",
      "PENDING_CONFIRMATION",
      "MACHINE_REVIEW",
      "UNLABELED",
    ]);
    expect(queue[0].evidence[0].boundedSummary).toBe("bounded");
  });

  it("is deterministic regardless of input record order", () => {
    const left = record({
      caseId: "case-a",
      row: 1702,
      decision: "PASS",
    });
    const right = record({
      caseId: "case-b",
      row: 1701,
      decision: "PASS",
    });

    const first = buildNqaReviewQueue({ records: [left, right] });
    const second = buildNqaReviewQueue({ records: [right, left] });

    expect(first).toEqual(second);
    expect(first.map(item => item.caseId)).toEqual(["case-b", "case-a"]);
  });
});
