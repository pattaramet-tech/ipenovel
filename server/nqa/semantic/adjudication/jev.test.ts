import { describe, expect, it, vi } from "vitest";

import type { NqaJevState } from "./contracts";
import { JevHttpDecisionProvider } from "./jev";

function state(): NqaJevState {
  return {
    version: "nqa-adjudication-evidence-v1",
    upstreamDecision: "REVIEW",
    upstreamReasonCodes: ["ALIGNMENT_UNCERTAIN"],
    globalSearch: {
      expectedRank: 1,
      expectedSimilarity: 0.71,
      expectedLeadOverAlternate: 0.01,
      bestAlternateChapter: 211,
    },
    alignment: {
      sourceCoverage: 0.7,
      translationCoverage: 0.72,
      meanRerankScore: 0.55,
      minRerankScore: 0.3,
      lowScoreFraction: 0.3,
      sourceGapFraction: 0.3,
      translationGapFraction: 0.28,
      alignedPairCount: 5,
      sourceChunkCount: 8,
      translationChunkCount: 8,
    },
    snippetSignals: [
      {
        kind: "ALIGNED_PAIR",
        rerankScore: 0.3,
        sourceHash: "a".repeat(64),
        translationHash: "b".repeat(64),
      },
    ],
  };
}

describe("NQA M11 Jev provider", () => {
  it("requires an API key", () => {
    expect(
      () =>
        new JevHttpDecisionProvider("jev-latest", {
          apiKey: "   ",
        })
    ).toThrow("Jev API key is required.");
  });

  it("allows only approved HTTPS System One endpoints", () => {
    expect(
      () =>
        new JevHttpDecisionProvider("jev-latest", {
          apiKey: "test",
          endpoint: "https://example.com/v1/systemone",
        })
    ).toThrow("Jev endpoint must be an approved HTTPS System One endpoint.");
    expect(
      () =>
        new JevHttpDecisionProvider("jev-latest", {
          apiKey: "test",
          endpoint: "http://api.typesafe.ai/v1/systemone",
        })
    ).toThrow("Jev endpoint must be an approved HTTPS System One endpoint.");
  });

  it("sends typed Choice/Noul/Score questions and parses answers", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("jev-latest");
        expect(body.state).toEqual(state());
        expect(body.questions.route.type).toBe("choice");
        expect(body.questions.evidence_sufficient.type).toBe("noul");
        expect(body.questions.semantic_risk.type).toBe("score");
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer test-key"
        );

        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              route: {
                type: "choice",
                choice: "escalate_local_llm",
                probabilities: {
                  accept_machine: 0.05,
                  escalate_local_llm: 0.9,
                  human_review: 0.05,
                },
                confidence: 0.85,
              },
              evidence_sufficient: {
                type: "noul",
                noul: 0.92,
              },
              semantic_risk: {
                type: "score",
                score: 2.4,
                confidence: 0.8,
                probabilities: {},
              },
            },
          }),
          { status: 200 }
        );
      }
    );

    const provider = new JevHttpDecisionProvider("jev-latest", {
      apiKey: "test-key",
      fetchFn,
    });

    const result = await provider.decide(state());
    expect(result).toMatchObject({
      route: "escalate_local_llm",
      routeConfidence: 0.85,
      evidenceSufficientProbability: 0.92,
      modelVersion: "jev-1.13.0",
    });
    expect(result.semanticRiskScore).toBeCloseTo(0.8);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed typed answers without leaking response bodies", async () => {
    const provider = new JevHttpDecisionProvider("jev-latest", {
      apiKey: "test",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            answers: {
              route: {
                choice: "invented_route",
                confidence: 0.99,
              },
            },
          }),
          { status: 200 }
        ),
    });

    await expect(provider.decide(state())).rejects.toThrow(
      "Jev returned an invalid route."
    );
  });

  it("does not leak provider response bodies on HTTP failure", async () => {
    const provider = new JevHttpDecisionProvider("jev-latest", {
      apiKey: "test",
      fetchFn: async () =>
        new Response("secret upstream output", { status: 500 }),
    });

    await expect(provider.decide(state())).rejects.toThrow(
      "Jev request failed with status 500."
    );
  });
});
