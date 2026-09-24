import type { NqaChapterExtraction } from "../../chapter/contracts";
import type { NqaReasonCode } from "../../contracts";
import type { NqaAlignmentPolicy } from "../alignment/contracts";
import { chunkSemanticChapter } from "../alignment/chunker";
import { mergeNqaAlignmentPolicy } from "../alignment/policy";
import type {
  NqaAdjudicationEvidencePack,
  NqaAdjudicationInput,
  NqaAdjudicationPolicy,
  NqaAdjudicationSnippet,
  NqaJevState,
} from "./contracts";
import { mergeNqaAdjudicationPolicy } from "./policy";

function boundedText(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(1, maxChars)).trimEnd();
}

function mergeReasons(reasons: readonly NqaReasonCode[]): NqaReasonCode[] {
  return Array.from(new Set(reasons));
}

export function buildAdjudicationEvidencePack(input: {
  adjudication: NqaAdjudicationInput;
  source: NqaChapterExtraction;
  translation: NqaChapterExtraction;
  policy?: Partial<NqaAdjudicationPolicy>;
  alignmentPolicy?: Partial<NqaAlignmentPolicy>;
}): NqaAdjudicationEvidencePack {
  const policy = mergeNqaAdjudicationPolicy(input.policy);
  const alignmentPolicy = mergeNqaAlignmentPolicy(input.alignmentPolicy);

  const sourceChunks = chunkSemanticChapter({
    extraction: input.source,
    policy: alignmentPolicy,
  });
  const translationChunks = chunkSemanticChapter({
    extraction: input.translation,
    policy: alignmentPolicy,
  });

  const snippets: NqaAdjudicationSnippet[] = [];
  const alignment = input.adjudication.alignment;

  if (alignment) {
    const lowScorePairs = [...alignment.alignedPairs]
      .sort(
        (left, right) =>
          left.rerankScore - right.rerankScore ||
          left.translationChunkIndex - right.translationChunkIndex
      )
      .slice(0, Math.max(0, policy.lowScoreSnippetLimit));

    for (const pair of lowScorePairs) {
      const sourceChunk = sourceChunks[pair.sourceChunkIndex];
      const translationChunk = translationChunks[pair.translationChunkIndex];
      if (!sourceChunk || !translationChunk) continue;

      snippets.push({
        evidenceId:
          "aligned-" + pair.translationChunkIndex + "-" + pair.sourceChunkIndex,
        kind: "ALIGNED_PAIR",
        sourceHash: sourceChunk.sha256,
        translationHash: translationChunk.sha256,
        sourceStartIndex: sourceChunk.startIndex,
        sourceEndIndex: sourceChunk.endIndex,
        translationStartIndex: translationChunk.startIndex,
        translationEndIndex: translationChunk.endIndex,
        rerankScore: pair.rerankScore,
        sourceText: boundedText(
          sourceChunk.text,
          policy.maxSnippetCharsPerSide
        ),
        translationText: boundedText(
          translationChunk.text,
          policy.maxSnippetCharsPerSide
        ),
      });
    }

    const gaps = alignment.gaps.slice(0, Math.max(0, policy.gapSnippetLimit));
    for (const gap of gaps) {
      const chunk =
        gap.side === "SOURCE"
          ? sourceChunks[gap.chunkIndex]
          : translationChunks[gap.chunkIndex];
      if (!chunk) continue;

      snippets.push({
        evidenceId: gap.side.toLocaleLowerCase() + "-gap-" + gap.chunkIndex,
        kind: gap.side === "SOURCE" ? "SOURCE_GAP" : "TRANSLATION_GAP",
        sourceHash: gap.side === "SOURCE" ? chunk.sha256 : null,
        translationHash: gap.side === "TRANSLATION" ? chunk.sha256 : null,
        sourceStartIndex: gap.side === "SOURCE" ? chunk.startIndex : null,
        sourceEndIndex: gap.side === "SOURCE" ? chunk.endIndex : null,
        translationStartIndex:
          gap.side === "TRANSLATION" ? chunk.startIndex : null,
        translationEndIndex: gap.side === "TRANSLATION" ? chunk.endIndex : null,
        rerankScore: null,
        sourceText:
          gap.side === "SOURCE"
            ? boundedText(chunk.text, policy.maxSnippetCharsPerSide)
            : null,
        translationText:
          gap.side === "TRANSLATION"
            ? boundedText(chunk.text, policy.maxSnippetCharsPerSide)
            : null,
      });
    }
  }

  return {
    version: "nqa-adjudication-evidence-v1",
    upstreamDecision: input.adjudication.upstreamDecision,
    upstreamReasonCodes: mergeReasons(input.adjudication.upstreamReasonCodes),
    globalSearch: input.adjudication.globalSearch
      ? {
          expectedRank: input.adjudication.globalSearch.expectedRank,
          expectedSimilarity:
            input.adjudication.globalSearch.expectedSimilarity,
          expectedLeadOverAlternate:
            input.adjudication.globalSearch.expectedLeadOverAlternate,
          bestAlternateChapter:
            input.adjudication.globalSearch.bestAlternate?.chapter ?? null,
        }
      : null,
    alignment: alignment
      ? {
          sourceCoverage: alignment.metrics.sourceCoverage,
          translationCoverage: alignment.metrics.translationCoverage,
          meanRerankScore: alignment.metrics.meanRerankScore,
          minRerankScore: alignment.metrics.minRerankScore,
          lowScoreFraction: alignment.metrics.lowScoreFraction,
          sourceGapFraction: alignment.metrics.sourceGapFraction,
          translationGapFraction: alignment.metrics.translationGapFraction,
          alignedPairCount: alignment.metrics.alignedPairCount,
          sourceChunkCount: alignment.metrics.sourceChunkCount,
          translationChunkCount: alignment.metrics.translationChunkCount,
        }
      : null,
    snippets: snippets.slice(0, Math.max(0, policy.maxSnippets)),
  };
}

export function buildJevState(
  evidence: NqaAdjudicationEvidencePack
): NqaJevState {
  return {
    version: evidence.version,
    upstreamDecision: evidence.upstreamDecision,
    upstreamReasonCodes: [...evidence.upstreamReasonCodes],
    globalSearch: evidence.globalSearch,
    alignment: evidence.alignment,
    snippetSignals: evidence.snippets.map(snippet => ({
      kind: snippet.kind,
      rerankScore: snippet.rerankScore,
      sourceHash: snippet.sourceHash,
      translationHash: snippet.translationHash,
    })),
  };
}
