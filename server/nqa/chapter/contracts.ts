import type { TranslationVariant } from "../contracts";

export type NqaDocumentParagraph = {
  text: string;
  startIndex: number;
  endIndex: number;
  tabId: string;
};

export type NqaDocumentTabSnapshot = {
  tabId: string;
  title: string | null;
  index: number | null;
  parentTabId: string | null;
  paragraphs: NqaDocumentParagraph[];
};

export type NqaDocumentSnapshot = {
  documentId: string;
  title: string | null;
  revisionId: string | null;
  tabs: NqaDocumentTabSnapshot[];
};

export type NqaSourceChapterBoundary = {
  kind: "SOURCE";
  documentId: string;
  revisionId: string | null;
  tabId: string;
  tabIndex: number | null;
  internalSequence: number;
  chapter: number;
  title: string;
  paragraphStart: number;
  paragraphEnd: number;
  startIndex: number;
  endIndex: number;
};

export type NqaTranslationChapterBoundary = {
  kind: "TRANSLATION";
  documentId: string;
  revisionId: string | null;
  tabId: string;
  tabIndex: number | null;
  chapter: number;
  title: string | null;
  variant: TranslationVariant;
  paragraphStart: number;
  paragraphEnd: number;
  startIndex: number;
  endIndex: number;
};
export type NqaChapterExtraction = {
  documentId: string;
  revisionId: string | null;
  tabId: string;
  chapter: number;
  internalSequence: number | null;
  title: string | null;
  variant: TranslationVariant | null;
  paragraphCount: number;
  startIndex: number;
  endIndex: number;
  text: string;
  sha256: string;
};

export const NQA_CHAPTER_RESOLUTION_STATUSES = [
  "RESOLVED",
  "RESOLVED_WITH_VARIANTS",
  "REVIEW",
  "NOT_FOUND",
] as const;

export type NqaChapterResolutionStatus =
  (typeof NQA_CHAPTER_RESOLUTION_STATUSES)[number];

export type NqaChapterResolutionReason =
  | "SOURCE_CHAPTER_MISSING"
  | "SOURCE_CHAPTER_AMBIGUOUS"
  | "TRANSLATION_CHAPTER_MISSING"
  | "TRANSLATION_CHAPTER_AMBIGUOUS"
  | "DUPLICATE_CHAPTER_ID"
  | "INTERNAL_SEQUENCE_DRIFT";

export type NqaChapterResolution = {
  status: NqaChapterResolutionStatus;
  source: NqaSourceChapterBoundary | null;
  translation: NqaTranslationChapterBoundary | null;
  translationVariants: NqaTranslationChapterBoundary[];
  reasonCodes: NqaChapterResolutionReason[];
};
