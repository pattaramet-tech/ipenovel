import { describe, expect, it } from "vitest";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { sha256Hex } from "../../core";
import type { NqaEmbeddingProvider } from "../contracts";
import type { NqaRerankerProvider } from "./contracts";
import { runSemanticAlignment } from "./engine";

function extraction(prefix: string, lines: string[]): NqaChapterExtraction {
  const text = ["Heading", ...lines].join("\n");
  return {
    documentId: prefix + "-doc",
    revisionId: "rev-1",
    tabId: "t.1",
    chapter: 197,
    internalSequence: null,
    title: "Test",
    variant:
      prefix === "source" ? "production_original" : "corrected_candidate",
    paragraphCount: lines.length + 1,
    startIndex: 1,
    endIndex: text.length + 1,
    text,
    sha256: sha256Hex(text),
  };
}

function basis(text: string): number[] {
  if (text.includes("A")) return [1, 0, 0];
  if (text.includes("B")) return [0, 1, 0];
  if (text.includes("C")) return [0, 0, 1];
  return [0.57, 0.57, 0.57];
}

const embeddingProvider: NqaEmbeddingProvider = {
  providerId: "fixture-embedding",
  modelVersion: "fixture-v1",
  async embed(texts) {
    return texts.map(basis);
  },
};

const rerankerProvider: NqaRerankerProvider = {
  providerId: "fixture-reranker",
  modelVersion: "fixture-reranker-v1",
  async rerank(pairs) {
    return pairs.map(pair => {
      const queryKey = pair.query.trim()[0] ?? "";
      const passageKey = pair.passage.trim()[0] ?? "";
      return {
        pairId: pair.pairId,
        score: queryKey === passageKey ? 0.95 : 0.2,
      };
    });
  },
};

const policy = {
  targetChunkChars: 5,
  maxChunkChars: 30,
  denseTopK: 3,
  maxRerankPairs: 30,
  minPassMeanScore: 0.7,
  minPassTranslationCoverage: 0.85,
  minPassSourceCoverage: 0.8,
  minReviewMeanScore: 0.45,
  minReviewTranslationCoverage: 0.6,
  minReviewSourceCoverage: 0.55,
  majorGapFraction: 0.3,
  lowScoreThreshold: 0.45,
  maxLowScoreFractionPass: 0.2,
};

describe("NQA M10 semantic alignment engine", () => {
  it("passes a clean monotonic translated sequence", async () => {
    const result = await runSemanticAlignment({
      source: extraction("source", [
        "A source event",
        "B source event",
        "C source event",
      ]),
      translation: extraction("translation", [
        "A translated event",
        "B translated event",
        "C translated event",
      ]),
      embeddingProvider,
      rerankerProvider,
      policy,
    });

    expect(result.decision).toBe("PASS");
    expect(result.reasonCodes).toEqual([]);
    expect(result.metrics.alignedPairCount).toBe(3);
    expect(result.metrics.sourceCoverage).toBe(1);
    expect(result.metrics.translationCoverage).toBe(1);
    expect(result.metrics.meanRerankScore).toBeCloseTo(0.95);
  });

  it("fails low-scoring local semantic divergence", async () => {
    const result = await runSemanticAlignment({
      source: extraction("source", [
        "A source event",
        "B source event",
        "C source event",
      ]),
      translation: extraction("translation", [
        "X unrelated scene",
        "Y unrelated scene",
        "Z unrelated scene",
      ]),
      embeddingProvider,
      rerankerProvider,
      policy,
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toContain("MEANING_DIVERGENCE");
    expect(result.metrics.meanRerankScore).toBeLessThan(0.45);
  });

  it("flags major translation-side gaps as addition/fabrication risk", async () => {
    const result = await runSemanticAlignment({
      source: extraction("source", [
        "A source event",
        "B source event",
        "C source event",
      ]),
      translation: extraction("translation", [
        "A translated event",
        "X unrelated inserted scene",
        "Y unrelated inserted scene",
        "B translated event",
        "C translated event",
      ]),
      embeddingProvider,
      rerankerProvider,
      policy: {
        ...policy,
        majorGapFraction: 0.25,
      },
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["ADDITION_MAJOR", "FABRICATION_SUSPECTED"])
    );
  });

  it("returns bounded text-free evidence/results", async () => {
    const secret = "UNIQUE_SECRET_ALIGNMENT_TEXT_" + "Q".repeat(200);
    const result = await runSemanticAlignment({
      source: extraction("source", ["A source event", "B source event"]),
      translation: extraction("translation", [
        "A translated event",
        "B translated event",
        secret,
      ]),
      embeddingProvider,
      rerankerProvider,
      policy,
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(
      result.evidence.every(evidence => evidence.boundedSummary.length <= 1000)
    ).toBe(true);
  });
});
