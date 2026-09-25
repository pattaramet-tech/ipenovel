import { describe, expect, it } from "vitest";

import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import { buildNqaShadowMachineResult } from "./evidence";

describe("NQA M13 bounded evidence collection", () => {
  it("collects stage decisions, scores, hashes, and bounded summaries without raw chapter text", () => {
    const sourceHash = "a".repeat(64);
    const translationHash = "b".repeat(64);

    const result: NqaSemanticQaStageResult = {
      decision: "REVIEW",
      reasonCodes: ["ALIGNMENT_UNCERTAIN", "EVENT_MISMATCH"],
      deterministic: {
        decision: "PASS",
        reasonCodes: [],
        metrics: {
          sourceChars: 1000,
          translationChars: 900,
          lengthRatio: 0.9,
          sourceParagraphs: 10,
          translationParagraphs: 9,
          paragraphRatio: 0.9,
          exactDuplicate: false,
          repeatedParagraphs: [],
          foreignTextHits: [],
          malformedSource: false,
          malformedTranslation: false,
          hasTranslationEndingMarker: true,
        },
        evidence: [
          {
            evidenceId: "det-source-range",
            kind: "SOURCE_RANGE",
            sourceHash,
            boundedSummary: "source metadata",
          },
          {
            evidenceId: "det-translation-range",
            kind: "TRANSLATION_RANGE",
            translationHash,
            boundedSummary: "translation metadata",
          },
        ],
        policyVersion: "nqa-deterministic-v1",
        resolverStatus: "RESOLVED",
        resolverReasonCodes: [],
      },
      globalSearch: {
        decision: "PASS",
        reasonCodes: [],
        expectedChapter: 197,
        expectedRank: 1,
        expectedSimilarity: 0.82,
        bestCandidate: null,
        bestAlternate: null,
        expectedLeadOverAlternate: 0.08,
        marginOverExpected: null,
        candidates: [],
        providerId: "local-http-embedding",
        modelVersion: "bge-m3",
        policyVersion: "nqa-semantic-global-v1",
        evidence: [],
      },
      alignment: {
        decision: "REVIEW",
        reasonCodes: ["ALIGNMENT_UNCERTAIN"],
        metrics: {
          sourceChunkCount: 10,
          translationChunkCount: 9,
          alignedPairCount: 9,
          sourceCoverage: 0.91,
          translationCoverage: 1,
          meanRerankScore: 0.7,
          minRerankScore: 0.2,
          lowScoreFraction: 0.22,
          sourceGapFraction: 0.09,
          translationGapFraction: 0,
        },
        alignedPairs: [],
        gaps: [],
        providerId: "local-http-reranker",
        modelVersion: "bge-reranker-v2-m3",
        policyVersion: "nqa-alignment-v1",
        evidence: [
          {
            evidenceId: "alignment-summary",
            kind: "ALIGNMENT",
            sourceHash,
            translationHash,
            boundedSummary: "bounded alignment summary",
          },
        ],
      },
      adjudication: null,
      structure: {
        decision: "REVIEW",
        reasonCodes: ["EVENT_MISMATCH"],
        metrics: {
          itemCount: 1,
          assessedItemCount: 1,
          strongMismatchCount: 1,
          strongMismatchItemCount: 1,
          strongMatchCount: 2,
          mismatchByDimension: { EVENT: 1 },
          matchByDimension: { ENTITY: 1 },
        },
        assessments: [],
        providerId: "local-http-structure-verifier",
        modelVersion: "Qwen/Qwen3-1.7B",
        policyVersion: "nqa-structure-v1",
        evidence: [
          {
            evidenceId: "structure-summary",
            kind: "POLICY",
            boundedSummary: "EVENT mismatch on bounded evidence",
          },
        ],
      },
      policyVersion: "nqa-semantic-global-v1",
    };

    const machine = buildNqaShadowMachineResult(result);

    expect(machine.sourceHash).toBe(sourceHash);
    expect(machine.translationHash).toBe(translationHash);
    expect(machine.stageDecisions).toEqual({
      deterministic: "PASS",
      globalSearch: "PASS",
      alignment: "REVIEW",
      adjudication: null,
      structure: "REVIEW",
    });
    expect(machine.scores.expectedSimilarity).toBe(0.82);
    expect(machine.scores.meanRerankScore).toBe(0.7);
    expect(machine.scores.structuredStrongMismatchCount).toBe(1);
    expect(machine.providerVersions.embedding).toBe(
      "local-http-embedding@bge-m3"
    );
    expect(machine.providerVersions.structure).toBe(
      "local-http-structure-verifier@Qwen/Qwen3-1.7B"
    );
    expect(JSON.stringify(machine)).not.toContain("sourceText");
    expect(JSON.stringify(machine)).not.toContain("translationText");
    expect(machine.evidence.map(item => item.evidenceId)).toEqual([
      "det-source-range",
      "det-translation-range",
      "alignment-summary",
      "structure-summary",
    ]);
  });
});
