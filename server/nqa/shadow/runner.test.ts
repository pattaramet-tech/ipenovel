import { describe, expect, it, vi } from "vitest";

import type { NqaShadowCase, NqaShadowMachineResult } from "./contracts";
import { runNqaShadowBatch } from "./runner";
import { InMemoryNqaShadowStore } from "./store";

function machine(
  decision: NqaShadowMachineResult["decision"]
): NqaShadowMachineResult {
  return {
    decision,
    reasonCodes: decision === "FAIL" ? ["MEANING_DIVERGENCE"] : [],
    stageDecisions: {
      deterministic: "PASS",
      globalSearch: "PASS",
      alignment: decision,
      adjudication: null,
      structure: null,
    },
    scores: {
      expectedRank: 1,
      expectedSimilarity: 0.8,
      expectedLeadOverAlternate: 0.1,
      sourceCoverage: 0.95,
      translationCoverage: 0.96,
      meanRerankScore: 0.75,
      minRerankScore: 0.5,
      lowScoreFraction: 0,
      sourceGapFraction: 0.05,
      translationGapFraction: 0.04,
      structuredStrongMismatchCount: null,
      structuredStrongMatchCount: null,
    },
    sourceHash: "a".repeat(64),
    translationHash: "b".repeat(64),
    providerVersions: {
      embedding: "local@bge-m3",
      reranker: "local@bge-reranker-v2-m3",
      adjudication: null,
      structure: null,
    },
    policyVersions: {
      deterministic: "nqa-deterministic-v1",
      semantic: "nqa-semantic-global-v1",
      alignment: "nqa-alignment-v1",
      adjudication: null,
      structure: null,
    },
    evidence: [],
  };
}

function shadowCase(id: string, row: number): NqaShadowCase {
  return {
    caseId: id,
    row,
    chapter: 197,
    inputFingerprint: null,
    tags: ["real-world"],
    groundTruth: null,
  };
}

describe("NQA M13 shadow batch runner", () => {
  it("checkpoints bounded progress and resumes without reevaluating completed cases", async () => {
    const store = new InMemoryNqaShadowStore();
    const evaluate = vi.fn(async () => machine("PASS"));
    const evaluator = { evaluate };
    const cases = [
      shadowCase("case-a", 1701),
      shadowCase("case-b", 1702),
      shadowCase("case-c", 1703),
    ];

    const first = await runNqaShadowBatch({
      runId: "run-001",
      cases,
      evaluator,
      store,
      maxCasesPerInvocation: 2,
      now: () => "2026-09-24T20:00:00+07:00",
    });

    expect(first.processedCaseIds).toEqual(["case-a", "case-b"]);
    expect(first.remainingCaseIds).toEqual(["case-c"]);
    expect(first.metrics.completedCases).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(2);

    const second = await runNqaShadowBatch({
      runId: "run-001",
      cases,
      evaluator,
      store,
      maxCasesPerInvocation: 2,
      now: () => "2026-09-24T20:10:00+07:00",
    });

    expect(second.processedCaseIds).toEqual(["case-c"]);
    expect(second.reusedCaseIds).toEqual(["case-a", "case-b"]);
    expect(second.remainingCaseIds).toEqual([]);
    expect(second.metrics.completedCases).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("updates human labels on reused cases without rerunning the model", async () => {
    const store = new InMemoryNqaShadowStore();
    const evaluate = vi.fn(async () => machine("PASS"));
    const initial = [shadowCase("case-a", 1701)];

    await runNqaShadowBatch({
      runId: "run-label",
      cases: initial,
      evaluator: { evaluate },
      store,
    });

    const labeled: NqaShadowCase[] = [
      {
        ...initial[0],
        groundTruth: {
          decision: "PASS",
          reasonCodes: [],
          status: "HUMAN_CONFIRMED",
          labeledBy: "reviewer-1",
          labeledAt: "2026-09-24T20:20:00+07:00",
          notes: ["checked against source"],
        },
      },
    ];

    const result = await runNqaShadowBatch({
      runId: "run-label",
      cases: labeled,
      evaluator: { evaluate },
      store,
    });

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.processedCaseIds).toEqual([]);
    expect(result.reusedCaseIds).toEqual(["case-a"]);
    expect(result.metrics.finalLabeledCases).toBe(1);
    expect(result.metrics.exactMatchRate).toBe(1);

    const record = await store.getRecord("run-label", "case-a");
    expect(record?.groundTruth?.status).toBe("HUMAN_CONFIRMED");
  });

  it("rejects changed case identity under the same run id", async () => {
    const store = new InMemoryNqaShadowStore();
    const evaluator = { evaluate: async () => machine("PASS") };

    await runNqaShadowBatch({
      runId: "run-fingerprint",
      cases: [shadowCase("case-a", 1701)],
      evaluator,
      store,
    });

    await expect(
      runNqaShadowBatch({
        runId: "run-fingerprint",
        cases: [shadowCase("case-a", 1702)],
        evaluator,
        store,
      })
    ).rejects.toThrow(
      "Shadow batch fingerprint does not match the existing checkpoint."
    );
  });

  it("preserves completed work when a later evaluation fails", async () => {
    const store = new InMemoryNqaShadowStore();
    let call = 0;
    const evaluator = {
      evaluate: async () => {
        call += 1;
        if (call === 2) throw new Error("runtime unavailable");
        return machine("PASS");
      },
    };

    await expect(
      runNqaShadowBatch({
        runId: "run-partial",
        cases: [shadowCase("case-a", 1701), shadowCase("case-b", 1702)],
        evaluator,
        store,
      })
    ).rejects.toThrow("runtime unavailable");

    const checkpoint = await store.loadCheckpoint("run-partial");
    expect(checkpoint?.completedCaseIds).toEqual(["case-a"]);
    expect(await store.getRecord("run-partial", "case-a")).not.toBeNull();
    expect(await store.getRecord("run-partial", "case-b")).toBeNull();
  });
});
