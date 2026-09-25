import type { NqaDecision, NqaReasonCode, QaEvidenceRef } from "../contracts";
import type { NqaChapterResolution } from "../chapter/contracts";

export const NQA_DETERMINISTIC_POLICY_VERSION = "nqa-deterministic-v1" as const;

export type NqaForeignScriptRule = {
  id: string;
  label: string;
  startCodePoint: number;
  endCodePoint: number;
};

export type NqaDeterministicPolicy = {
  version: string;
  minChapterCharsReview: number;
  maxChapterCharsReview: number;
  minLengthRatioReview: number;
  maxLengthRatioReview: number;
  minParagraphRatioReview: number;
  maxParagraphRatioReview: number;
  repeatedParagraphMinChars: number;
  repeatedParagraphOccurrencesReview: number;
  requireTranslationEndingMarker: boolean;
  translationEndingMarkers: string[];
  foreignScriptRules: NqaForeignScriptRule[];
};

export type NqaForeignTextHit = {
  ruleId: string;
  label: string;
  codePoint: number;
  character: string;
  index: number;
};

export type NqaRepeatedParagraphHit = {
  normalizedText: string;
  occurrences: number;
};

export type NqaDeterministicMetrics = {
  sourceChars: number | null;
  translationChars: number | null;
  lengthRatio: number | null;
  sourceParagraphs: number | null;
  translationParagraphs: number | null;
  paragraphRatio: number | null;
  exactDuplicate: boolean | null;
  repeatedParagraphs: NqaRepeatedParagraphHit[];
  foreignTextHits: NqaForeignTextHit[];
  malformedSource: boolean;
  malformedTranslation: boolean;
  hasTranslationEndingMarker: boolean | null;
};

export type NqaDeterministicQaResult = {
  decision: NqaDecision;
  reasonCodes: NqaReasonCode[];
  metrics: NqaDeterministicMetrics;
  evidence: QaEvidenceRef[];
  policyVersion: string;
  resolverStatus: NqaChapterResolution["status"];
  resolverReasonCodes: NqaChapterResolution["reasonCodes"];
};
