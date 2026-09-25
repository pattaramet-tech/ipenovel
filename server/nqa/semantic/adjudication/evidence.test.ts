import { describe, expect, it } from "vitest";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { sha256Hex } from "../../core";
import type { NqaAlignmentResult } from "../alignment/contracts";
import { buildAdjudicationEvidencePack, buildJevState } from "./evidence";

function extraction(prefix: string, lines: string[]): NqaChapterExtraction {
  const text = ["Heading", ...lines].join("\n");
  return {
    documentId: prefix + "-doc",
    revisionId: "rev",
    tabId: "t.1",
    chapter: 197,
    internalSequence: null,
    title: "Test",
    variant:
      prefix === "source" ? "production_original" : "corrected_candidate",
    paragraphCount: lines.length + 1,
    startIndex: 100,
    endIndex: 100 + text.length,
    text,
    sha256: sha256Hex(text),
  };
}

function alignment(): NqaAlignmentResult {
  return {
    decision: "REVIEW",
    reasonCodes: ["ALIGNMENT_UNCERTAIN"],
    metrics: {
      sourceChunkCount: 2,
      translationChunkCount: 2,
      alignedPairCount: 1,
      sourceCoverage: 0.55,
      translationCoverage: 0.52,
      meanRerankScore: 0.4,
      minRerankScore: 0.4,
      lowScoreFraction: 1,
      sourceGapFraction: 0.45,
      translationGapFraction: 0.48,
    },
    alignedPairs: [
      {
        translationChunkIndex: 0,
        sourceChunkIndex: 0,
        denseSimilarity: 0.7,
        rerankScore: 0.4,
        sourceChunk: {
          chunkIndex: 0,
          paragraphStart: 0,
          paragraphEnd: 0,
          startIndex: 100,
          endIndex: 120,
          charCount: 20,
          sha256: "a".repeat(64),
        },
        translationChunk: {
          chunkIndex: 0,
          paragraphStart: 0,
          paragraphEnd: 0,
          startIndex: 100,
          endIndex: 120,
          charCount: 20,
          sha256: "b".repeat(64),
        },
      },
    ],
    gaps: [
      {
        side: "SOURCE",
        chunkIndex: 1,
        startIndex: 121,
        endIndex: 140,
        sha256: "c".repeat(64),
        charCount: 19,
      },
      {
        side: "TRANSLATION",
        chunkIndex: 1,
        startIndex: 121,
        endIndex: 140,
        sha256: "d".repeat(64),
        charCount: 19,
      },
    ],
    providerId: "fixture-reranker",
    modelVersion: "fixture",
    policyVersion: "nqa-alignment-v1",
    evidence: [],
  };
}

describe("NQA M11 evidence pack", () => {
  it("bounds local snippets and keeps Jev state text-free", () => {
    const secretSource = "SOURCE_SECRET_" + "A".repeat(1200);
    const secretTranslation = "TRANSLATION_SECRET_" + "ก".repeat(1200);

    const pack = buildAdjudicationEvidencePack({
      adjudication: {
        upstreamDecision: "REVIEW",
        upstreamReasonCodes: ["ALIGNMENT_UNCERTAIN"],
        globalSearch: null,
        alignment: alignment(),
      },
      source: extraction("source", [
        secretSource,
        "SECOND_SOURCE_" + "B".repeat(1200),
      ]),
      translation: extraction("translation", [
        secretTranslation,
        "SECOND_TRANSLATION_" + "ข".repeat(1200),
      ]),
      policy: {
        maxSnippetCharsPerSide: 120,
        maxSnippets: 3,
      },
      alignmentPolicy: {
        targetChunkChars: 1000,
        maxChunkChars: 1800,
      },
    });

    expect(pack.snippets.length).toBeLessThanOrEqual(3);
    for (const snippet of pack.snippets) {
      expect(snippet.sourceText?.length ?? 0).toBeLessThanOrEqual(120);
      expect(snippet.translationText?.length ?? 0).toBeLessThanOrEqual(120);
    }

    const jevState = buildJevState(pack);
    const serialized = JSON.stringify(jevState);
    expect(serialized).not.toContain("SOURCE_SECRET_");
    expect(serialized).not.toContain("TRANSLATION_SECRET_");
    expect(serialized).not.toContain("SECOND_SOURCE_");
    expect(serialized).not.toContain("SECOND_TRANSLATION_");
  });

  it("preserves only machine metrics and snippet signals in Jev state", () => {
    const pack = buildAdjudicationEvidencePack({
      adjudication: {
        upstreamDecision: "REVIEW",
        upstreamReasonCodes: ["LOW_CONFIDENCE"],
        globalSearch: null,
        alignment: alignment(),
      },
      source: extraction("source", ["A source", "B source"]),
      translation: extraction("translation", [
        "A translation",
        "B translation",
      ]),
    });

    const jevState = buildJevState(pack);
    expect(jevState).not.toHaveProperty("snippets");
    expect(jevState.snippetSignals.length).toBeGreaterThan(0);
    expect(
      jevState.snippetSignals.every(
        signal => !("sourceText" in signal) && !("translationText" in signal)
      )
    ).toBe(true);
  });
});
