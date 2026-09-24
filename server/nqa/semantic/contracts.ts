import type { NqaDecision, NqaReasonCode, QaEvidenceRef } from "../contracts";
import type { NqaDeterministicQaResult } from "../deterministic/contracts";
import type { NqaAlignmentResult } from "./alignment/contracts";
import type { NqaAdjudicationResult } from "./adjudication/contracts";

export const NQA_SEMANTIC_GLOBAL_POLICY_VERSION =
  "nqa-semantic-global-v1" as const;

export type NqaEmbeddingVector = number[];

export interface NqaEmbeddingProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  embed(texts: string[]): Promise<NqaEmbeddingVector[]>;
}

export type NqaSemanticSourceCandidate = {
  chapter: number;
  internalSequence: number;
  title: string;
  tabId: string;
  sha256: string;
  similarity: number;
};

export type NqaSemanticSearchPolicy = {
  version: string;
  minExpectedSimilarityPass: number;
  minExpectedLeadPass: number;
  minWrongSourceSimilarityFail: number;
  minWrongSourceMarginFail: number;
  maxExpectedRankPass: number;
  nearbyChapterDistance: number;
  maxCandidates: number;
};

export type NqaGlobalSourceSearchResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  expectedChapter: number;
  expectedRank: number | null;
  expectedSimilarity: number | null;
  bestCandidate: NqaSemanticSourceCandidate | null;
  bestAlternate: NqaSemanticSourceCandidate | null;
  expectedLeadOverAlternate: number | null;
  marginOverExpected: number | null;
  candidates: NqaSemanticSourceCandidate[];
  providerId: string;
  modelVersion: string;
  policyVersion: string;
  evidence: QaEvidenceRef[];
};

export type NqaSemanticQaStageResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  deterministic: NqaDeterministicQaResult;
  globalSearch: NqaGlobalSourceSearchResult | null;
  alignment: NqaAlignmentResult | null;
  adjudication: NqaAdjudicationResult | null;
  policyVersion: string;
};
