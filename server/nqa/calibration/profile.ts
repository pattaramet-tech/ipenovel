import type { NqaAlignmentPolicy } from "../semantic/alignment/contracts";
import {
  NqaAlignmentThresholdProfileSchema,
  type NqaAlignmentThresholdProfile,
} from "./contracts";

export function buildNqaAlignmentThresholdProfile(input: {
  profileId: string;
  policy: NqaAlignmentPolicy;
  rerankerVersion: string;
}): NqaAlignmentThresholdProfile {
  return NqaAlignmentThresholdProfileSchema.parse({
    profileId: input.profileId,
    sourcePolicyVersion: input.policy.version,
    rerankerVersion: input.rerankerVersion,
    thresholds: {
      minPassMeanScore: input.policy.minPassMeanScore,
      minPassTranslationCoverage: input.policy.minPassTranslationCoverage,
      minPassSourceCoverage: input.policy.minPassSourceCoverage,
      minReviewMeanScore: input.policy.minReviewMeanScore,
      minReviewTranslationCoverage: input.policy.minReviewTranslationCoverage,
      minReviewSourceCoverage: input.policy.minReviewSourceCoverage,
      majorGapFraction: input.policy.majorGapFraction,
      maxLowScoreFractionPass: input.policy.maxLowScoreFractionPass,
    },
  });
}
