import type {
  NqaDecision,
  NqaReasonCode,
  QaEvidenceRef,
} from "../../contracts";

export const NQA_ALIGNMENT_POLICY_VERSION = "nqa-alignment-v1" as const;

export type NqaSemanticChunk = {
  chunkIndex: number;
  paragraphStart: number;
  paragraphEnd: number;
  startIndex: number;
  endIndex: number;
  charCount: number;
  sha256: string;
  text: string;
};

export type NqaDenseChunkCandidate = {
  translationChunkIndex: number;
  sourceChunkIndex: number;
  denseSimilarity: number;
};

export type NqaRerankPair = {
  pairId: string;
  query: string;
  passage: string;
};

export type NqaRerankScore = {
  pairId: string;
  score: number;
};

export interface NqaRerankerProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  rerank(pairs: NqaRerankPair[]): Promise<NqaRerankScore[]>;
}

export type NqaAlignmentEdge = {
  translationChunkIndex: number;
  sourceChunkIndex: number;
  denseSimilarity: number;
  rerankScore: number;
};

export type NqaSemanticChunkRef = Omit<NqaSemanticChunk, "text">;

export type NqaAlignedPair = NqaAlignmentEdge & {
  sourceChunk: NqaSemanticChunkRef;
  translationChunk: NqaSemanticChunkRef;
};

export type NqaAlignmentGap = {
  side: "SOURCE" | "TRANSLATION";
  chunkIndex: number;
  startIndex: number;
  endIndex: number;
  sha256: string;
  charCount: number;
};

export type NqaAlignmentPolicy = {
  version: string;
  targetChunkChars: number;
  maxChunkChars: number;
  denseTopK: number;
  maxRerankPairs: number;
  minPassMeanScore: number;
  minPassTranslationCoverage: number;
  minPassSourceCoverage: number;
  minReviewMeanScore: number;
  minReviewTranslationCoverage: number;
  minReviewSourceCoverage: number;
  majorGapFraction: number;
  lowScoreThreshold: number;
  maxLowScoreFractionPass: number;
};

export type NqaAlignmentMetrics = {
  sourceChunkCount: number;
  translationChunkCount: number;
  alignedPairCount: number;
  sourceCoverage: number;
  translationCoverage: number;
  meanRerankScore: number | null;
  minRerankScore: number | null;
  lowScoreFraction: number;
  sourceGapFraction: number;
  translationGapFraction: number;
};

export type NqaAlignmentResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  metrics: NqaAlignmentMetrics;
  alignedPairs: NqaAlignedPair[];
  gaps: NqaAlignmentGap[];
  providerId: string;
  modelVersion: string;
  policyVersion: string;
  evidence: QaEvidenceRef[];
};
