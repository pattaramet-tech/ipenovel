import {
  NQA_SEMANTIC_GLOBAL_POLICY_VERSION,
  type NqaSemanticSearchPolicy,
} from "./contracts";

export const DEFAULT_NQA_SEMANTIC_SEARCH_POLICY: NqaSemanticSearchPolicy = {
  version: NQA_SEMANTIC_GLOBAL_POLICY_VERSION,
  minExpectedSimilarityPass: 0.6,
  minExpectedLeadPass: 0.02,
  minWrongSourceSimilarityFail: 0.72,
  minWrongSourceMarginFail: 0.08,
  maxExpectedRankPass: 1,
  nearbyChapterDistance: 2,
  maxCandidates: 10,
};

export function mergeNqaSemanticSearchPolicy(
  override: Partial<NqaSemanticSearchPolicy> = {}
): NqaSemanticSearchPolicy {
  return {
    ...DEFAULT_NQA_SEMANTIC_SEARCH_POLICY,
    ...override,
  };
}
