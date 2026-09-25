import { describe, expect, it } from "vitest";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { sha256Hex } from "../../core";
import type { NqaAlignmentResult } from "../alignment/contracts";
import { buildStructureEvidenceItems } from "./evidence";

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
    startIndex: 1,
    endIndex: text.length + 1,
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
      sourceCoverage: 0.5,
      translationCoverage: 0.5,
      meanRerankScore: 0.4,
      minRerankScore: 0.4,
      lowScoreFraction: 1,
      sourceGapFraction: 0.5,
      translationGapFraction: 0.5,
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
          startIndex: 1,
          endIndex: 10,
          charCount: 9,
          sha256: "a".repeat(64),
        },
        translationChunk: {
          chunkIndex: 0,
          paragraphStart: 0,
          paragraphEnd: 0,
          startIndex: 1,
          endIndex: 10,
          charCount: 9,
          sha256: "b".repeat(64),
        },
      },
    ],
    gaps: [
      {
        side: "SOURCE",
        chunkIndex: 1,
        startIndex: 11,
        endIndex: 20,
        sha256: "c".repeat(64),
        charCount: 9,
      },
      {
        side: "TRANSLATION",
        chunkIndex: 1,
        startIndex: 11,
        endIndex: 20,
        sha256: "d".repeat(64),
        charCount: 9,
      },
    ],
    providerId: "fixture-reranker",
    modelVersion: "fixture",
    policyVersion: "nqa-alignment-v1",
    evidence: [],
  };
}

describe("NQA M12 structure evidence", () => {
  it("bounds pair/gap text and respects item cap", () => {
    const source = extraction("source", ["A".repeat(1200), "B".repeat(1200)]);
    const translation = extraction("translation", [
      "ก".repeat(1200),
      "ข".repeat(1200),
    ]);

    const items = buildStructureEvidenceItems({
      alignment: alignment(),
      source,
      translation,
      policy: {
        maxCharsPerSide: 120,
        maxItems: 3,
        lowScoreItemLimit: 1,
        gapItemLimit: 2,
      },
      alignmentPolicy: {
        targetChunkChars: 1000,
        maxChunkChars: 1800,
      },
    });

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sourceText?.length ?? 0).toBeLessThanOrEqual(120);
      expect(item.translationText?.length ?? 0).toBeLessThanOrEqual(120);
    }
    expect(items.map(item => item.kind)).toEqual([
      "ALIGNED_PAIR",
      "SOURCE_GAP",
      "TRANSLATION_GAP",
    ]);
  });
});
