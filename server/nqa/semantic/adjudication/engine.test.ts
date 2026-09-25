import { describe, expect, it } from "vitest";

import type {
  NqaAdjudicationEvidencePack,
  NqaJevProvider,
  NqaSmallLlmProvider,
} from "./contracts";
import { runNqaAdjudication } from "./engine";

function pack(
  decision: "PASS" | "REVIEW" | "FAIL" = "REVIEW"
): NqaAdjudicationEvidencePack {
  return {
    version: "nqa-adjudication-evidence-v1",
    upstreamDecision: decision,
    upstreamReasonCodes: decision === "REVIEW" ? ["ALIGNMENT_UNCERTAIN"] : [],
    globalSearch: {
      expectedRank: 1,
      expectedSimilarity: 0.72,
      expectedLeadOverAlternate: 0.01,
      bestAlternateChapter: 196,
    },
    alignment: {
      sourceCoverage: 0.8,
      translationCoverage: 0.82,
      meanRerankScore: 0.6,
      minRerankScore: 0.3,
      lowScoreFraction: 0.25,
      sourceGapFraction: 0.2,
      translationGapFraction: 0.18,
      alignedPairCount: 6,
      sourceChunkCount: 8,
      translationChunkCount: 8,
    },
    snippets: [],
  };
}

describe("NQA M11 adjudication engine", () => {
  it("does not override upstream PASS/FAIL", async () => {
    let calls = 0;
    const local: NqaSmallLlmProvider = {
      providerId: "fixture",
      modelVersion: "fixture",
      async adjudicate() {
        calls += 1;
        throw new Error("must not run");
      },
    };

    const passed = await runNqaAdjudication({
      evidencePack: pack("PASS"),
      smallLlmProvider: local,
    });
    const failed = await runNqaAdjudication({
      evidencePack: pack("FAIL"),
      smallLlmProvider: local,
    });

    expect(passed).toMatchObject({
      decision: "PASS",
      applied: false,
      route: "SKIPPED_UPSTREAM_FINAL",
    });
    expect(failed).toMatchObject({
      decision: "FAIL",
      applied: false,
      route: "SKIPPED_UPSTREAM_FINAL",
    });
    expect(calls).toBe(0);
  });

  it("routes high-confidence Jev human-review decisions without local LLM", async () => {
    let localCalls = 0;
    const jev: NqaJevProvider = {
      providerId: "jev",
      modelVersion: "jev-fixture",
      async decide() {
        return {
          route: "human_review",
          routeConfidence: 0.95,
          evidenceSufficientProbability: 0.3,
          semanticRiskScore: 0.5,
          modelVersion: "jev-fixture",
        };
      },
    };
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        localCalls += 1;
        throw new Error("must not run");
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      jevProvider: jev,
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      route: "HUMAN_REVIEW",
      reasonCodes: expect.arrayContaining(["HUMAN_REVIEW_REQUIRED"]),
    });
    expect(localCalls).toBe(0);
  });

  it("retains REVIEW on high-confidence Jev accept-machine routing by default", async () => {
    let localCalls = 0;
    const jev: NqaJevProvider = {
      providerId: "jev",
      modelVersion: "jev-fixture",
      async decide() {
        return {
          route: "accept_machine",
          routeConfidence: 0.97,
          evidenceSufficientProbability: 0.96,
          semanticRiskScore: 0.4,
          modelVersion: "jev-fixture",
        };
      },
    };
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        localCalls += 1;
        return {
          decision: "PASS",
          reasonCodes: [],
          confidence: 0.99,
          boundedRationale: "unused",
          modelVersion: "local-fixture",
        };
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      jevProvider: jev,
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      route: "JEV_ACCEPT_MACHINE",
    });
    expect(localCalls).toBe(0);
  });

  it("allows a high-confidence local PASS on upstream REVIEW", async () => {
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        return {
          decision: "PASS",
          reasonCodes: [],
          confidence: 0.93,
          boundedRationale: "Bounded evidence is consistent with the source.",
          modelVersion: "local-fixture",
        };
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "PASS",
      route: "LOCAL_LLM",
      localLlm: {
        confidence: 0.93,
      },
    });
  });

  it("allows a high-confidence local FAIL with bounded reason codes", async () => {
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        return {
          decision: "FAIL",
          reasonCodes: ["MEANING_DIVERGENCE", "FABRICATION_SUSPECTED"],
          confidence: 0.91,
          boundedRationale:
            "The bounded translation evidence introduces unsupported events.",
          modelVersion: "local-fixture",
        };
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "FAIL",
      route: "LOCAL_LLM",
      reasonCodes: expect.arrayContaining([
        "MEANING_DIVERGENCE",
        "FABRICATION_SUSPECTED",
      ]),
    });
  });

  it("escalates low-confidence local decisions to human review", async () => {
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        return {
          decision: "PASS",
          reasonCodes: [],
          confidence: 0.61,
          boundedRationale: "Uncertain.",
          modelVersion: "local-fixture",
        };
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      route: "HUMAN_REVIEW",
      reasonCodes: expect.arrayContaining(["HUMAN_REVIEW_REQUIRED"]),
    });
  });

  it("fails safe to human review when local adjudication errors", async () => {
    const local: NqaSmallLlmProvider = {
      providerId: "local",
      modelVersion: "local-fixture",
      async adjudicate() {
        throw new Error("model unavailable");
      },
    };

    const result = await runNqaAdjudication({
      evidencePack: pack(),
      smallLlmProvider: local,
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      route: "HUMAN_REVIEW",
      reasonCodes: expect.arrayContaining(["HUMAN_REVIEW_REQUIRED"]),
    });
  });
});
