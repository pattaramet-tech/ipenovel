import {
  NQA_ALIGNMENT_POLICY_VERSION,
  type NqaAlignmentPolicy,
} from "./contracts";

export const DEFAULT_NQA_ALIGNMENT_POLICY: NqaAlignmentPolicy = {
  version: NQA_ALIGNMENT_POLICY_VERSION,
  targetChunkChars: 1200,
  maxChunkChars: 1800,
  denseTopK: 4,
  maxRerankPairs: 160,
  minPassMeanScore: 0.7,
  minPassTranslationCoverage: 0.85,
  minPassSourceCoverage: 0.8,
  minReviewMeanScore: 0.45,
  minReviewTranslationCoverage: 0.6,
  minReviewSourceCoverage: 0.55,
  majorGapFraction: 0.3,
  lowScoreThreshold: 0.45,
  maxLowScoreFractionPass: 0.3,
};

export function mergeNqaAlignmentPolicy(
  override: Partial<NqaAlignmentPolicy> = {}
): NqaAlignmentPolicy {
  return {
    ...DEFAULT_NQA_ALIGNMENT_POLICY,
    ...override,
  };
}
