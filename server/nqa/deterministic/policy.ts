import {
  NQA_DETERMINISTIC_POLICY_VERSION,
  type NqaDeterministicPolicy,
} from "./contracts";

export const DEFAULT_NQA_DETERMINISTIC_POLICY: NqaDeterministicPolicy = {
  version: NQA_DETERMINISTIC_POLICY_VERSION,
  minChapterCharsReview: 300,
  maxChapterCharsReview: 100_000,
  minLengthRatioReview: 0.25,
  maxLengthRatioReview: 4,
  minParagraphRatioReview: 0.25,
  maxParagraphRatioReview: 4,
  repeatedParagraphMinChars: 40,
  repeatedParagraphOccurrencesReview: 3,
  requireTranslationEndingMarker: false,
  translationEndingMarkers: ["จบตอน"],
  foreignScriptRules: [
    {
      id: "DEVANAGARI",
      label: "Devanagari",
      startCodePoint: 0x0900,
      endCodePoint: 0x097f,
    },
  ],
};

export function mergeNqaDeterministicPolicy(
  override: Partial<NqaDeterministicPolicy> = {}
): NqaDeterministicPolicy {
  return {
    ...DEFAULT_NQA_DETERMINISTIC_POLICY,
    ...override,
    translationEndingMarkers:
      override.translationEndingMarkers ??
      DEFAULT_NQA_DETERMINISTIC_POLICY.translationEndingMarkers,
    foreignScriptRules:
      override.foreignScriptRules ??
      DEFAULT_NQA_DETERMINISTIC_POLICY.foreignScriptRules,
  };
}
