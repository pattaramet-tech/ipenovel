import { fingerprintText } from "../core";
import type {
  NqaChapterExtraction,
  NqaDocumentSnapshot,
  NqaSourceChapterBoundary,
  NqaTranslationChapterBoundary,
} from "./contracts";

function tabFor(snapshot: NqaDocumentSnapshot, tabId: string) {
  return snapshot.tabs.find(tab => tab.tabId === tabId) ?? null;
}

function extractionText(
  snapshot: NqaDocumentSnapshot,
  boundary: NqaSourceChapterBoundary | NqaTranslationChapterBoundary
): {
  text: string;
  paragraphCount: number;
} {
  const tab = tabFor(snapshot, boundary.tabId);
  if (!tab) {
    throw new Error("Chapter boundary references an unknown tab.");
  }

  const paragraphs = tab.paragraphs.slice(
    boundary.paragraphStart,
    boundary.paragraphEnd + 1
  );
  if (paragraphs.length === 0) {
    throw new Error("Chapter boundary resolved to an empty paragraph range.");
  }

  return {
    text: paragraphs.map(paragraph => paragraph.text).join("\n"),
    paragraphCount: paragraphs.length,
  };
}

export function extractSourceChapter(input: {
  snapshot: NqaDocumentSnapshot;
  boundary: NqaSourceChapterBoundary;
}): NqaChapterExtraction {
  const extracted = extractionText(input.snapshot, input.boundary);
  const fingerprint = fingerprintText({
    text: extracted.text,
    paragraphCount: extracted.paragraphCount,
    startIndex: input.boundary.startIndex,
    endIndex: input.boundary.endIndex,
  });

  return {
    documentId: input.snapshot.documentId,
    revisionId: input.snapshot.revisionId,
    tabId: input.boundary.tabId,
    chapter: input.boundary.chapter,
    internalSequence: input.boundary.internalSequence,
    title: input.boundary.title,
    variant: null,
    paragraphCount: extracted.paragraphCount,
    startIndex: input.boundary.startIndex,
    endIndex: input.boundary.endIndex,
    text: extracted.text,
    sha256: fingerprint.sha256,
  };
}
export function extractTranslationChapter(input: {
  snapshot: NqaDocumentSnapshot;
  boundary: NqaTranslationChapterBoundary;
}): NqaChapterExtraction {
  const extracted = extractionText(input.snapshot, input.boundary);
  const fingerprint = fingerprintText({
    text: extracted.text,
    paragraphCount: extracted.paragraphCount,
    startIndex: input.boundary.startIndex,
    endIndex: input.boundary.endIndex,
  });

  return {
    documentId: input.snapshot.documentId,
    revisionId: input.snapshot.revisionId,
    tabId: input.boundary.tabId,
    chapter: input.boundary.chapter,
    internalSequence: null,
    title: input.boundary.title,
    variant: input.boundary.variant,
    paragraphCount: extracted.paragraphCount,
    startIndex: input.boundary.startIndex,
    endIndex: input.boundary.endIndex,
    text: extracted.text,
    sha256: fingerprint.sha256,
  };
}
