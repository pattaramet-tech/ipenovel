import { describe, expect, it, vi } from "vitest";

import type { NqaAdjudicationEvidencePack } from "./contracts";
import { LocalHttpSmallLlmProvider } from "./smallLlm";

function evidence(): NqaAdjudicationEvidencePack {
  return {
    version: "nqa-adjudication-evidence-v1",
    upstreamDecision: "REVIEW",
    upstreamReasonCodes: ["ALIGNMENT_UNCERTAIN"],
    globalSearch: null,
    alignment: null,
    snippets: [
      {
        evidenceId: "pair-1",
        kind: "ALIGNED_PAIR",
        sourceHash: "a".repeat(64),
        translationHash: "b".repeat(64),
        sourceStartIndex: 1,
        sourceEndIndex: 10,
        translationStartIndex: 20,
        translationEndIndex: 30,
        rerankScore: 0.42,
        sourceText: "Source bounded text",
        translationText: "ข้อความแปลแบบจำกัด",
      },
    ],
  };
}

describe("NQA M11 local small-LLM provider", () => {
  it("rejects non-loopback endpoints", () => {
    expect(
      () =>
        new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
          endpoint: "https://example.com/adjudicate",
        })
    ).toThrow("NQA sidecar endpoint must use loopback or a private bridge hostname.");
  });

  it("posts bounded evidence and parses a typed response", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          model: "Qwen/Qwen3-1.7B",
          evidence: evidence(),
        });

        return new Response(
          JSON.stringify({
            decision: "FAIL",
            reasonCodes: ["MEANING_DIVERGENCE", "FABRICATION_SUSPECTED"],
            confidence: 0.91,
            boundedRationale:
              "The bounded evidence contains unsupported translated events.",
            modelVersion: "Qwen/Qwen3-1.7B@fixture",
          }),
          { status: 200 }
        );
      }
    );

    const provider = new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
      endpoint: "http://127.0.0.1:8767/adjudicate",
      fetchFn,
    });

    await expect(provider.adjudicate(evidence())).resolves.toEqual({
      decision: "FAIL",
      reasonCodes: ["MEANING_DIVERGENCE", "FABRICATION_SUSPECTED"],
      confidence: 0.91,
      boundedRationale:
        "The bounded evidence contains unsupported translated events.",
      modelVersion: "Qwen/Qwen3-1.7B@fixture",
    });
  });

  it("rejects unknown reason codes", async () => {
    const provider = new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
      endpoint: "http://localhost:8767/adjudicate",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            decision: "FAIL",
            reasonCodes: ["INVENTED_REASON"],
            confidence: 0.9,
            boundedRationale: "Invalid fixture.",
          }),
          { status: 200 }
        ),
    });

    await expect(provider.adjudicate(evidence())).rejects.toThrow(
      "Local small-LLM returned an unknown reason code."
    );
  });

  it("rejects unbounded rationale and invalid confidence", async () => {
    const provider = new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
      endpoint: "http://localhost:8767/adjudicate",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            decision: "PASS",
            reasonCodes: [],
            confidence: 1.5,
            boundedRationale: "x",
          }),
          { status: 200 }
        ),
    });

    await expect(provider.adjudicate(evidence())).rejects.toThrow(
      "Local small-LLM returned invalid confidence."
    );
  });

  it("does not leak local model output on HTTP errors", async () => {
    const provider = new LocalHttpSmallLlmProvider("Qwen/Qwen3-1.7B", {
      endpoint: "http://localhost:8767/adjudicate",
      fetchFn: async () =>
        new Response("secret generated output", { status: 500 }),
    });

    await expect(provider.adjudicate(evidence())).rejects.toThrow(
      "Local small-LLM request failed with status 500."
    );
  });
});
