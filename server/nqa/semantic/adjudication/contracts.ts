import type {
  NqaDecision,
  NqaReasonCode,
  QaEvidenceRef,
} from "../../contracts";
import type { NqaAlignmentResult } from "../alignment/contracts";
import type { NqaGlobalSourceSearchResult } from "../contracts";

export const NQA_ADJUDICATION_POLICY_VERSION = "nqa-adjudication-v1" as const;

export type NqaAdjudicationSnippet = {
  evidenceId: string;
  kind: "ALIGNED_PAIR" | "SOURCE_GAP" | "TRANSLATION_GAP";
  sourceHash: string | null;
  translationHash: string | null;
  sourceStartIndex: number | null;
  sourceEndIndex: number | null;
  translationStartIndex: number | null;
  translationEndIndex: number | null;
  rerankScore: number | null;
  sourceText: string | null;
  translationText: string | null;
};

export type NqaAdjudicationEvidencePack = {
  version: "nqa-adjudication-evidence-v1";
  upstreamDecision: NqaDecision;
  upstreamReasonCodes: NqaReasonCode[];
  globalSearch: {
    expectedRank: number | null;
    expectedSimilarity: number | null;
    expectedLeadOverAlternate: number | null;
    bestAlternateChapter: number | null;
  } | null;
  alignment: {
    sourceCoverage: number;
    translationCoverage: number;
    meanRerankScore: number | null;
    minRerankScore: number | null;
    lowScoreFraction: number;
    sourceGapFraction: number;
    translationGapFraction: number;
    alignedPairCount: number;
    sourceChunkCount: number;
    translationChunkCount: number;
  } | null;
  snippets: NqaAdjudicationSnippet[];
};

export type NqaJevState = Omit<NqaAdjudicationEvidencePack, "snippets"> & {
  snippetSignals: Array<{
    kind: NqaAdjudicationSnippet["kind"];
    rerankScore: number | null;
    sourceHash: string | null;
    translationHash: string | null;
  }>;
};

export type NqaJevRoute =
  "accept_machine" | "escalate_local_llm" | "human_review";

export type NqaJevDecision = {
  route: NqaJevRoute;
  routeConfidence: number;
  evidenceSufficientProbability: number;
  semanticRiskScore: number | null;
  modelVersion: string;
};

export interface NqaJevProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  decide(state: NqaJevState): Promise<NqaJevDecision>;
}

export type NqaSmallLlmDecision = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  confidence: number;
  boundedRationale: string;
  modelVersion: string;
};

export interface NqaSmallLlmProvider {
  readonly providerId: string;
  readonly modelVersion: string;
  adjudicate(
    evidence: NqaAdjudicationEvidencePack
  ): Promise<NqaSmallLlmDecision>;
}

export type NqaAdjudicationPolicy = {
  version: string;
  maxSnippets: number;
  maxSnippetCharsPerSide: number;
  lowScoreSnippetLimit: number;
  gapSnippetLimit: number;
  jevRouteConfidenceThreshold: number;
  jevEvidenceSufficientThreshold: number;
  allowJevFinalDecision: boolean;
  localLlmFinalConfidenceThreshold: number;
  allowLocalLlmPass: boolean;
  allowLocalLlmFail: boolean;
};

export type NqaAdjudicationResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  applied: boolean;
  route:
    | "SKIPPED_UPSTREAM_FINAL"
    | "JEV_ACCEPT_MACHINE"
    | "LOCAL_LLM"
    | "HUMAN_REVIEW";
  jev: NqaJevDecision | null;
  localLlm: NqaSmallLlmDecision | null;
  evidencePackVersion: NqaAdjudicationEvidencePack["version"];
  policyVersion: string;
  evidence: QaEvidenceRef[];
};

export type NqaAdjudicationInput = {
  upstreamDecision: NqaDecision;
  upstreamReasonCodes: NqaReasonCode[];
  globalSearch: NqaGlobalSourceSearchResult | null;
  alignment: NqaAlignmentResult | null;
};
