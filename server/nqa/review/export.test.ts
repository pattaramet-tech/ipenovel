import { describe, expect, it } from "vitest";

import type { NqaShadowRecord } from "../shadow/contracts";
import { buildNqaCurationExport } from "./export";
import { createNqaReviewAction } from "./workflow";

const SOURCE_HASH = "a".repeat(64);
const TRANSLATION_HASH = "b".repeat(64);

function record(caseId: string, row: number): NqaShadowRecord {
  return {
    recordVersion: "nqa-shadow-record-v1",
    runId: "run-export",
    batchFingerprint: "f".repeat(64),
    caseId,
    row,
    chapter: 197,
    inputFingerprint: "c".repeat(64),
    tags: ["real-world"],
    groundTruth: null,
    machine: {
      decision: "REVIEW",
      reasonCodes: ["ALIGNMENT_UNCERTAIN"],
      stageDecisions: {
        deterministic: "PASS",
        globalSearch: "PASS",
        alignment: "REVIEW",
        adjudication: null,
        structure: null,
      },
      scores: {
        expectedRank: 1,
        expectedSimilarity: 0.8,
        expectedLeadOverAlternate: 0.1,
        sourceCoverage: 0.9,
        translationCoverage: 0.9,
        meanRerankScore: 0.6,
        minRerankScore: 0.3,
        lowScoreFraction: 0.2,
        sourceGapFraction: 0.1,
        translationGapFraction: 0.1,
        structuredStrongMismatchCount: null,
        structuredStrongMatchCount: null,
      },
      sourceHash: SOURCE_HASH,
      translationHash: TRANSLATION_HASH,
      providerVersions: {
        embedding: "local@bge-m3",
        reranker: "local@reranker",
        adjudication: null,
        structure: null,
      },
      policyVersions: {
        deterministic: "det-v1",
        semantic: "semantic-v1",
        alignment: "alignment-v1",
        adjudication: null,
        structure: null,
      },
      evidence: [
        {
          stage: "M10_ALIGNMENT",
          evidenceId: "ev-1",
          sourceHash: SOURCE_HASH,
          translationHash: TRANSLATION_HASH,
          boundedSummary: "bounded evidence only",
        },
      ],
    },
    evaluatedAt: "2026-09-24T20:00:00+07:00",
    updatedAt: "2026-09-24T20:00:00+07:00",
  };
}

describe("NQA M14 deterministic curation export", () => {
  it("produces the same dataset fingerprint regardless of record input order", () => {
    const firstRecord = record("case-a", 1702);
    const secondRecord = record("case-b", 1701);

    const first = buildNqaCurationExport({
      records: [firstRecord, secondRecord],
    });
    const second = buildNqaCurationExport({
      records: [secondRecord, firstRecord],
    });

    expect(first).toEqual(second);
    expect(first.cases.map(item => item.caseId)).toEqual(["case-b", "case-a"]);
    expect(first.datasetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves baseline pending labels and active candidate state in the export", () => {
    const source: NqaShadowRecord = {
      ...record("case-pending", 1700),
      groundTruth: {
        decision: "PASS",
        reasonCodes: [],
        status: "CANDIDATE_PENDING_HUMAN_SIGNOFF",
        labeledBy: null,
        labeledAt: null,
        notes: ["candidate from M13 collection"],
      },
    };

    const result = buildNqaCurationExport({ records: [source] });

    expect(result.cases[0].reviewStatus).toBe("PROPOSED");
    expect(result.cases[0].candidateLabel).toEqual({
      decision: "PASS",
      reasonCodes: [],
    });
    expect(result.cases[0].baselineGroundTruth?.status).toBe(
      "CANDIDATE_PENDING_HUMAN_SIGNOFF"
    );
    expect(result.finalLabelCount).toBe(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it("exports bounded review provenance and final labels without raw chapter text", () => {
    const source = record("case-a", 1701);
    const proposal = createNqaReviewAction({
      record: source,
      existingActions: [],
      actionId: "proposal-1",
      actionType: "PROPOSE",
      reviewerId: "reviewer-a",
      label: { decision: "PASS", reasonCodes: [] },
      evidence: [{ kind: "SOURCE_HASH", sha256: SOURCE_HASH }],
      createdAt: "2026-09-24T20:05:00+07:00",
    });
    const confirmation = createNqaReviewAction({
      record: source,
      existingActions: [proposal],
      actionId: "confirm-1",
      actionType: "CONFIRM",
      reviewerId: "reviewer-b",
      label: { decision: "PASS", reasonCodes: [] },
      evidence: [{ kind: "M13_EVIDENCE", evidenceId: "ev-1" }],
      boundedNote: "Confirmed against bounded evidence.",
      createdAt: "2026-09-24T20:06:00+07:00",
    });

    const result = buildNqaCurationExport({
      records: [source],
      actionsByCaseId: new Map([["case-a", [proposal, confirmation]]]),
    });

    expect(result.finalLabelCount).toBe(1);
    expect(result.unresolvedCount).toBe(0);
    expect(result.cases[0].reviewStatus).toBe("CONFIRMED");
    expect(result.cases[0].finalGroundTruth?.decision).toBe("PASS");
    expect(result.cases[0].actionTrail).toHaveLength(2);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sourceText");
    expect(serialized).not.toContain("translationText");
  });
});
