import {
  NQA_ADJUDICATION_POLICY_VERSION,
  type NqaAdjudicationPolicy,
} from "./contracts";

export const DEFAULT_NQA_ADJUDICATION_POLICY: NqaAdjudicationPolicy = {
  version: NQA_ADJUDICATION_POLICY_VERSION,
  maxSnippets: 8,
  maxSnippetCharsPerSide: 700,
  lowScoreSnippetLimit: 4,
  gapSnippetLimit: 4,
  jevRouteConfidenceThreshold: 0.9,
  jevEvidenceSufficientThreshold: 0.9,
  allowJevFinalDecision: false,
  localLlmFinalConfidenceThreshold: 0.85,
  allowLocalLlmPass: true,
  allowLocalLlmFail: true,
};

export function mergeNqaAdjudicationPolicy(
  override: Partial<NqaAdjudicationPolicy> = {}
): NqaAdjudicationPolicy {
  return {
    ...DEFAULT_NQA_ADJUDICATION_POLICY,
    ...override,
  };
}
