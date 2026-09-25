import type { NqaChapterExtraction } from "../../chapter/contracts";
import type { NqaReasonCode, QaEvidenceRef } from "../../contracts";
import type { NqaEmbeddingProvider } from "../contracts";
import { chunkSemanticChapter } from "./chunker";
import type {
  NqaAlignmentGap,
  NqaAlignmentPolicy,
  NqaAlignmentResult,
  NqaRerankerProvider,
  NqaSemanticChunk,
} from "./contracts";
import { buildRerankedAlignmentEdges } from "./edges";
import { selectMonotonicAlignment } from "./monotonic";
import { mergeNqaAlignmentPolicy } from "./policy";

function addReason(reasons: NqaReasonCode[], reason: NqaReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function ratio(part: number, total: number): number {
  return total <= 0 ? 0 : part / total;
}

function gapFor(
  side: "SOURCE" | "TRANSLATION",
  chunk: NqaSemanticChunk
): NqaAlignmentGap {
  return {
    side,
    chunkIndex: chunk.chunkIndex,
    startIndex: chunk.startIndex,
    endIndex: chunk.endIndex,
    sha256: chunk.sha256,
    charCount: chunk.charCount,
  };
}

function boundedEvidence(input: {
  result: Omit<NqaAlignmentResult, "evidence">;
}): QaEvidenceRef[] {
  const metrics = input.result.metrics;
  const evidence: QaEvidenceRef[] = [
    {
      evidenceId: "semantic-monotonic-alignment",
      kind: "ALIGNMENT",
      boundedSummary: [
        "Monotonic chunk alignment.",
        "sourceCoverage=" + metrics.sourceCoverage.toFixed(4),
        "translationCoverage=" + metrics.translationCoverage.toFixed(4),
        "meanRerankScore=" + (metrics.meanRerankScore?.toFixed(4) ?? "n/a"),
        "lowScoreFraction=" + metrics.lowScoreFraction.toFixed(4),
        "sourceGapFraction=" + metrics.sourceGapFraction.toFixed(4),
        "translationGapFraction=" + metrics.translationGapFraction.toFixed(4),
        "alignedPairs=" + metrics.alignedPairCount,
        "provider=" + input.result.providerId,
        "model=" + input.result.modelVersion,
      ]
        .join(" ")
        .slice(0, 1000),
    },
  ];

  for (const gap of input.result.gaps.slice(0, 8)) {
    evidence.push({
      evidenceId:
        "alignment-gap-" + gap.side.toLocaleLowerCase() + "-" + gap.chunkIndex,
      kind: gap.side === "SOURCE" ? "SOURCE_RANGE" : "TRANSLATION_RANGE",
      sourceStartIndex: gap.side === "SOURCE" ? gap.startIndex : null,
      sourceEndIndex: gap.side === "SOURCE" ? gap.endIndex : null,
      translationStartIndex: gap.side === "TRANSLATION" ? gap.startIndex : null,
      translationEndIndex: gap.side === "TRANSLATION" ? gap.endIndex : null,
      sourceHash: gap.side === "SOURCE" ? gap.sha256 : null,
      translationHash: gap.side === "TRANSLATION" ? gap.sha256 : null,
      boundedSummary:
        gap.side +
        " chunk gap index=" +
        gap.chunkIndex +
        " chars=" +
        gap.charCount,
    });
  }

  return evidence;
}

export async function runSemanticAlignment(input: {
  source: NqaChapterExtraction;
  translation: NqaChapterExtraction;
  embeddingProvider: NqaEmbeddingProvider;
  rerankerProvider: NqaRerankerProvider;
  policy?: Partial<NqaAlignmentPolicy>;
}): Promise<NqaAlignmentResult> {
  const policy = mergeNqaAlignmentPolicy(input.policy);
  const sourceChunks = chunkSemanticChapter({
    extraction: input.source,
    policy,
  });
  const translationChunks = chunkSemanticChapter({
    extraction: input.translation,
    policy,
  });

  const edges = await buildRerankedAlignmentEdges({
    sourceChunks,
    translationChunks,
    embeddingProvider: input.embeddingProvider,
    rerankerProvider: input.rerankerProvider,
    policy,
  });
  const alignedPairs = selectMonotonicAlignment({
    edges,
    sourceChunks,
    translationChunks,
  });

  const alignedSource = new Set(
    alignedPairs.map(pair => pair.sourceChunkIndex)
  );
  const alignedTranslation = new Set(
    alignedPairs.map(pair => pair.translationChunkIndex)
  );
  const gaps: NqaAlignmentGap[] = [
    ...sourceChunks
      .filter(chunk => !alignedSource.has(chunk.chunkIndex))
      .map(chunk => gapFor("SOURCE", chunk)),
    ...translationChunks
      .filter(chunk => !alignedTranslation.has(chunk.chunkIndex))
      .map(chunk => gapFor("TRANSLATION", chunk)),
  ];

  const sourceChars = sourceChunks.reduce(
    (sum, chunk) => sum + chunk.charCount,
    0
  );
  const translationChars = translationChunks.reduce(
    (sum, chunk) => sum + chunk.charCount,
    0
  );
  const alignedSourceChars = sourceChunks
    .filter(chunk => alignedSource.has(chunk.chunkIndex))
    .reduce((sum, chunk) => sum + chunk.charCount, 0);
  const alignedTranslationChars = translationChunks
    .filter(chunk => alignedTranslation.has(chunk.chunkIndex))
    .reduce((sum, chunk) => sum + chunk.charCount, 0);

  const scores = alignedPairs.map(pair => pair.rerankScore);
  const meanRerankScore =
    scores.length === 0
      ? null
      : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const minRerankScore = scores.length === 0 ? null : Math.min(...scores);
  const lowScoreFraction =
    scores.length === 0
      ? 1
      : ratio(
          scores.filter(score => score < policy.lowScoreThreshold).length,
          scores.length
        );

  const metrics = {
    sourceChunkCount: sourceChunks.length,
    translationChunkCount: translationChunks.length,
    alignedPairCount: alignedPairs.length,
    sourceCoverage: ratio(alignedSourceChars, sourceChars),
    translationCoverage: ratio(alignedTranslationChars, translationChars),
    meanRerankScore,
    minRerankScore,
    lowScoreFraction,
    sourceGapFraction: 1 - ratio(alignedSourceChars, sourceChars),
    translationGapFraction:
      1 - ratio(alignedTranslationChars, translationChars),
  };

  const reasonCodes: NqaReasonCode[] = [];
  let decision: "PASS" | "REVIEW" | "FAIL" = "REVIEW";

  const insufficient =
    sourceChunks.length === 0 ||
    translationChunks.length === 0 ||
    alignedPairs.length === 0;

  if (insufficient) {
    addReason(reasonCodes, "INSUFFICIENT_EVIDENCE");
  } else if (
    meanRerankScore !== null &&
    meanRerankScore >= policy.minPassMeanScore &&
    metrics.translationCoverage >= policy.minPassTranslationCoverage &&
    metrics.sourceCoverage >= policy.minPassSourceCoverage &&
    lowScoreFraction <= policy.maxLowScoreFractionPass
  ) {
    decision = "PASS";
  } else {
    const sourceMajorGap = metrics.sourceGapFraction >= policy.majorGapFraction;
    const translationMajorGap =
      metrics.translationGapFraction >= policy.majorGapFraction;
    const scoreFail =
      meanRerankScore === null || meanRerankScore < policy.minReviewMeanScore;
    const translationCoverageFail =
      metrics.translationCoverage < policy.minReviewTranslationCoverage;
    const sourceCoverageFail =
      metrics.sourceCoverage < policy.minReviewSourceCoverage;

    if (sourceMajorGap || sourceCoverageFail) {
      addReason(reasonCodes, "OMISSION_MAJOR");
    }
    if (translationMajorGap || translationCoverageFail) {
      addReason(reasonCodes, "ADDITION_MAJOR");
      addReason(reasonCodes, "FABRICATION_SUSPECTED");
    }
    if (scoreFail) {
      addReason(reasonCodes, "MEANING_DIVERGENCE");
    }

    if (
      sourceMajorGap ||
      translationMajorGap ||
      scoreFail ||
      translationCoverageFail ||
      sourceCoverageFail
    ) {
      decision = "FAIL";
    } else {
      addReason(reasonCodes, "ALIGNMENT_UNCERTAIN");
    }
  }

  const withoutEvidence = {
    decision,
    reasonCodes,
    metrics,
    alignedPairs,
    gaps,
    providerId: input.rerankerProvider.providerId,
    modelVersion: input.rerankerProvider.modelVersion,
    policyVersion: policy.version,
  };

  return {
    ...withoutEvidence,
    evidence: boundedEvidence({
      result: withoutEvidence,
    }),
  };
}
