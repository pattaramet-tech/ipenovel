import type {
  NqaDocumentSnapshot,
  NqaSourceChapterBoundary,
  NqaTranslationChapterBoundary,
} from "./contracts";
import type { TranslationVariant } from "../contracts";

export type ParsedSourceHeading = {
  internalSequence: number;
  chapter: number;
  title: string;
};

export type ParsedTranslationHeading = {
  chapter: number;
  title: string | null;
};

export function parseSourceHeading(text: string): ParsedSourceHeading | null {
  const normalized = text.normalize("NFC").trim();
  const legacyMatch = normalized.match(
    /^บท\s*(\d+)\s*:\s*(\d+)\s*\.\s*(.+?)\s*$/
  );
  const liveMatch = legacyMatch
    ? null
    : normalized.match(/^บท\s*(\d+)\s*:\s*(.+?)\s*$/);
  if (!legacyMatch && !liveMatch) return null;

  const internalSequence = Number(legacyMatch?.[1] ?? liveMatch![1]);
  const chapter = Number(legacyMatch?.[2] ?? liveMatch![1]);
  const title = (legacyMatch?.[3] ?? liveMatch![2]).trim();
  if (
    !Number.isInteger(internalSequence) ||
    !Number.isInteger(chapter) ||
    internalSequence <= 0 ||
    chapter <= 0 ||
    !title
  ) {
    return null;
  }

  return {
    internalSequence,
    chapter,
    title,
  };
}

export function parseTranslationHeading(
  text: string
): ParsedTranslationHeading | null {
  const normalized = text.normalize("NFC").trim();
  const match = normalized.match(/^บท(?:ที่)?\s*(\d+)\s*(.*)$/);
  if (!match) return null;

  const chapter = Number(match[1]);
  if (!Number.isInteger(chapter) || chapter <= 0) {
    return null;
  }

  const title = match[2].trim();
  return {
    chapter,
    title: title || null,
  };
}
export function classifyTranslationVariant(input: {
  tabTitle: string | null;
  headingTitle: string | null;
  override?: TranslationVariant | null;
}): TranslationVariant {
  if (input.override) return input.override;

  const evidence = [input.tabTitle, input.headingTitle]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase("th");

  if (/แปลใหม่|แก้ไข|corrected|retranslated/.test(evidence)) {
    return "corrected_candidate";
  }

  if (/ร่าง|draft/.test(evidence)) {
    return "draft";
  }

  return "production_original";
}

export function buildSourceChapterBoundaries(
  snapshot: NqaDocumentSnapshot
): NqaSourceChapterBoundary[] {
  const boundaries: NqaSourceChapterBoundary[] = [];

  for (const tab of snapshot.tabs) {
    const headings = tab.paragraphs
      .map((paragraph, paragraphIndex) => ({
        paragraph,
        paragraphIndex,
        parsed: parseSourceHeading(paragraph.text),
      }))
      .filter(item => item.parsed !== null) as Array<{
      paragraph: (typeof tab.paragraphs)[number];
      paragraphIndex: number;
      parsed: ParsedSourceHeading;
    }>;

    for (let index = 0; index < headings.length; index += 1) {
      const current = headings[index];
      const next = headings[index + 1];
      const paragraphEnd = next
        ? next.paragraphIndex - 1
        : tab.paragraphs.length - 1;
      const lastParagraph = tab.paragraphs[paragraphEnd];
      if (!lastParagraph) continue;

      boundaries.push({
        kind: "SOURCE",
        documentId: snapshot.documentId,
        revisionId: snapshot.revisionId,
        tabId: tab.tabId,
        tabIndex: tab.index,
        internalSequence: current.parsed.internalSequence,
        chapter: current.parsed.chapter,
        title: current.parsed.title,
        paragraphStart: current.paragraphIndex,
        paragraphEnd,
        startIndex: current.paragraph.startIndex,
        endIndex: lastParagraph.endIndex,
      });
    }
  }

  return boundaries;
}
export function buildTranslationChapterBoundaries(
  snapshot: NqaDocumentSnapshot,
  variantOverrides: Record<string, TranslationVariant> = {}
): NqaTranslationChapterBoundary[] {
  const boundaries: NqaTranslationChapterBoundary[] = [];

  for (const tab of snapshot.tabs) {
    const headings = tab.paragraphs
      .map((paragraph, paragraphIndex) => ({
        paragraph,
        paragraphIndex,
        parsed: parseTranslationHeading(paragraph.text),
      }))
      .filter(item => item.parsed !== null) as Array<{
      paragraph: (typeof tab.paragraphs)[number];
      paragraphIndex: number;
      parsed: ParsedTranslationHeading;
    }>;

    for (let index = 0; index < headings.length; index += 1) {
      const current = headings[index];
      const next = headings[index + 1];
      const paragraphEnd = next
        ? next.paragraphIndex - 1
        : tab.paragraphs.length - 1;
      const lastParagraph = tab.paragraphs[paragraphEnd];
      if (!lastParagraph) continue;

      boundaries.push({
        kind: "TRANSLATION",
        documentId: snapshot.documentId,
        revisionId: snapshot.revisionId,
        tabId: tab.tabId,
        tabIndex: tab.index,
        chapter: current.parsed.chapter,
        title: current.parsed.title,
        variant: classifyTranslationVariant({
          tabTitle: tab.title,
          headingTitle: current.parsed.title,
          override: variantOverrides[tab.tabId] ?? null,
        }),
        paragraphStart: current.paragraphIndex,
        paragraphEnd,
        startIndex: current.paragraph.startIndex,
        endIndex: lastParagraph.endIndex,
      });
    }
  }

  return boundaries;
}
