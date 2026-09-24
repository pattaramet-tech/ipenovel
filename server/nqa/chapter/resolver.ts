import type {
  NqaChapterResolution,
  NqaDocumentSnapshot,
  NqaSourceChapterBoundary,
  NqaTranslationChapterBoundary,
} from "./contracts";
import {
  buildSourceChapterBoundaries,
  buildTranslationChapterBoundaries,
} from "./parser";
import type { TranslationVariant } from "../contracts";

function chooseTranslationCandidate(
  candidates: NqaTranslationChapterBoundary[]
): {
  selected: NqaTranslationChapterBoundary | null;
  status: NqaChapterResolution["status"];
  reasonCodes: NqaChapterResolution["reasonCodes"];
} {
  if (candidates.length === 0) {
    return {
      selected: null,
      status: "NOT_FOUND",
      reasonCodes: ["TRANSLATION_CHAPTER_MISSING"],
    };
  }

  if (candidates.length === 1) {
    return {
      selected: candidates[0],
      status: "RESOLVED",
      reasonCodes: [],
    };
  }

  const production = candidates.filter(
    candidate => candidate.variant === "production_original"
  );

  if (production.length === 1) {
    return {
      selected: production[0],
      status: "RESOLVED_WITH_VARIANTS",
      reasonCodes: ["DUPLICATE_CHAPTER_ID"],
    };
  }

  return {
    selected: null,
    status: "REVIEW",
    reasonCodes: ["DUPLICATE_CHAPTER_ID", "TRANSLATION_CHAPTER_AMBIGUOUS"],
  };
}

export function resolveChapter(input: {
  sourceSnapshot: NqaDocumentSnapshot;
  translationSnapshot: NqaDocumentSnapshot;
  chapter: number;
  expectedInternalSequence?: number | null;
  variantOverrides?: Record<string, TranslationVariant>;
}): NqaChapterResolution {
  const sourceCandidates = buildSourceChapterBoundaries(
    input.sourceSnapshot
  ).filter(boundary => boundary.chapter === input.chapter);

  if (sourceCandidates.length === 0) {
    return {
      status: "NOT_FOUND",
      source: null,
      translation: null,
      translationVariants: [],
      reasonCodes: ["SOURCE_CHAPTER_MISSING"],
    };
  }

  if (sourceCandidates.length > 1) {
    return {
      status: "REVIEW",
      source: null,
      translation: null,
      translationVariants: [],
      reasonCodes: ["SOURCE_CHAPTER_AMBIGUOUS"],
    };
  }

  const source = sourceCandidates[0];
  const translationCandidates = buildTranslationChapterBoundaries(
    input.translationSnapshot,
    input.variantOverrides
  ).filter(boundary => boundary.chapter === input.chapter);

  const translationChoice = chooseTranslationCandidate(translationCandidates);

  const reasonCodes = [...translationChoice.reasonCodes];
  if (
    input.expectedInternalSequence !== undefined &&
    input.expectedInternalSequence !== null &&
    source.internalSequence !== input.expectedInternalSequence
  ) {
    reasonCodes.push("INTERNAL_SEQUENCE_DRIFT");
  }

  let status = translationChoice.status;
  if (
    reasonCodes.includes("INTERNAL_SEQUENCE_DRIFT") &&
    status !== "NOT_FOUND"
  ) {
    status = "REVIEW";
  }

  return {
    status,
    source,
    translation: translationChoice.selected,
    translationVariants: translationCandidates,
    reasonCodes,
  };
}
