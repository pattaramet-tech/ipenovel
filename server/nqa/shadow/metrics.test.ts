import { describe, expect, it } from "vitest";

import type {
  NqaShadowGroundTruth,
  NqaShadowMachineResult,
  NqaShadowRecord,
} from "./contracts";
import { calculateNqaShadowMetrics } from "./metrics";

function machine(
  decision: NqaShadowMachineResult["decision"],
  reasonCodes: NqaShadowMachineResult["reasonCodes"] = []
): NqaShadowMachineResult {
  return {
    decision,
    reasonCodes,
    stageDecisions: {
      deterministic: decision,
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
    sourceHash: null,
    translationHash: null,
    providerVersions: {
      embedding: null,
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

function label(
  decision: NqaGroundTruthDecision,
  status: NqaShadowGroundTruth["status"] = "HUMAN_CONFIRMED"
): NqaShadowGroundTruth {
  return {
    decision,
    reasonCodes: [],
    status,
    labeledBy: "reviewer",
    labeledAt: "2026-09-24T20:00:00+07:00",
    notes: [],
  };
}

type NqaGroundTruthDecision = NqaShadowGroundTruth["decision"];

function record(
  caseId: string,
  machineDecision: NqaShadowMachineResult["decision"],
  groundTruth: NqaShadowGroundTruth | null
): NqaShadowRecord {
  return {
    recordVersion: "nqa-shadow-record-v1",
    runId: "metrics-run",
    batchFingerprint: "f".repeat(64),
    caseId,
    row: 1700 + Number(caseId.replace(/\D/g, "") || 1),
    chapter: 197,
    inputFingerprint: null,
    tags: [],
    groundTruth,
    machine: machine(
      machineDecision,
      machineDecision === "FAIL" ? ["MEANING_DIVERGENCE"] : []
    ),
    evaluatedAt: "2026-09-24T20:00:00+07:00",
    updatedAt: "2026-09-24T20:00:00+07:00",
  };
}

describe("NQA M13 shadow metrics", () => {
  it("separates false pass, false fail, review load, and pending human labels", () => {
    const metrics = calculateNqaShadowMetrics({
      totalCases: 5,
      records: [
        record("case-1", "FAIL", label("PASS")),
        record("case-2", "PASS", label("FAIL")),
        record("case-3", "REVIEW", label("PASS")),
        record("case-4", "PASS", label("PASS")),
        record(
          "case-5",
          "REVIEW",
          label("REVIEW", "CANDIDATE_PENDING_HUMAN_SIGNOFF")
        ),
      ],
    });

    expect(metrics.completedCases).toBe(5);
    expect(metrics.finalLabeledCases).toBe(4);
    expect(metrics.pendingHumanLabelCases).toBe(1);
    expect(metrics.falsePassCount).toBe(1);
    expect(metrics.falsePassEligibleCount).toBe(1);
    expect(metrics.falsePassRate).toBe(1);
    expect(metrics.falseFailCount).toBe(1);
    expect(metrics.falseFailEligibleCount).toBe(3);
    expect(metrics.falseFailRate).toBeCloseTo(1 / 3);
    expect(metrics.reviewCount).toBe(2);
    expect(metrics.reviewRate).toBe(0.4);
    expect(metrics.reviewOnFinalLabelCount).toBe(1);
    expect(metrics.reviewOnFinalLabelRate).toBe(0.25);
    expect(metrics.exactMatchCount).toBe(1);
    expect(metrics.exactMatchRate).toBe(0.25);
    expect(metrics.confusionMatrix.PASS.FAIL).toBe(1);
    expect(metrics.confusionMatrix.FAIL.PASS).toBe(1);
    expect(metrics.reasonCodeCounts.MEANING_DIVERGENCE).toBe(1);
  });
});
