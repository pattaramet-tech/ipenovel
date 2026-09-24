import { describe, expect, it } from "vitest";

import { buildNqaAlignmentThresholdProfile } from "./profile";

describe("NQA M15 alignment threshold profile snapshot", () => {
  it("copies only replayable M10 decision thresholds and provenance", () => {
    const profile = buildNqaAlignmentThresholdProfile({
      profileId: "current",
      rerankerVersion: "local@reranker",
      policy: {
        version: "nqa-alignment-v1",
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
      },
    });

    expect(profile).toEqual({
      profileId: "current",
      sourcePolicyVersion: "nqa-alignment-v1",
      rerankerVersion: "local@reranker",
      thresholds: {
        minPassMeanScore: 0.7,
        minPassTranslationCoverage: 0.85,
        minPassSourceCoverage: 0.8,
        minReviewMeanScore: 0.45,
        minReviewTranslationCoverage: 0.6,
        minReviewSourceCoverage: 0.55,
        majorGapFraction: 0.3,
        maxLowScoreFractionPass: 0.3,
      },
    });
    expect(profile.thresholds).not.toHaveProperty("lowScoreThreshold");
    expect(profile.thresholds).not.toHaveProperty("targetChunkChars");
  });
});
