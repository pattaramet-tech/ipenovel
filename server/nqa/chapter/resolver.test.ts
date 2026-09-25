import { describe, expect, it } from "vitest";

import type { NqaDocumentSnapshot } from "./contracts";
import { resolveChapter } from "./resolver";

function sourceSnapshot(
  headings: Array<[string, number, number]>
): NqaDocumentSnapshot {
  const paragraphs = headings.flatMap(([heading, start, end], index) => [
    {
      text: heading,
      startIndex: start,
      endIndex: start + heading.length,
      tabId: "t.0",
    },
    {
      text: `source body ${index}`,
      startIndex: start + heading.length + 1,
      endIndex: end,
      tabId: "t.0",
    },
  ]);
  return {
    documentId: "source-document-12345",
    title: "English",
    revisionId: "rev-source",
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
        paragraphs,
      },
    ],
  };
}

function translationSnapshot(
  tabs: Array<{
    tabId: string;
    tabTitle: string;
    index: number;
    heading: string;
    body?: string;
  }>
): NqaDocumentSnapshot {
  return {
    documentId: "translation-document-123",
    title: "Thai",
    revisionId: "rev-thai",
    tabs: tabs.map(tab => ({
      tabId: tab.tabId,
      title: tab.tabTitle,
      index: tab.index,
      parentTabId: null,
      paragraphs: [
        {
          text: tab.heading,
          startIndex: 1,
          endIndex: tab.heading.length + 1,
          tabId: tab.tabId,
        },
        {
          text: tab.body ?? "thai body",
          startIndex: tab.heading.length + 2,
          endIndex: 200,
          tabId: tab.tabId,
        },
      ],
    })),
  };
}

const source = sourceSnapshot([
  ["บท 197: 196. Search and Rescue", 170567, 181956],
  ["บท 198: 197. Possessing", 181957, 193006],
  ["บท 199: 198. Rookie", 193007, 194000],
]);
describe("NQA chapter resolver", () => {
  it("resolves canonical source chapter 197 as internal sequence 198", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([
        {
          tabId: "t.bf525hytchcg",
          tabTitle: "บทที่ 197 การสิงร่าง",
          index: 16,
          heading: "บทที่ 197 การสิงร่าง(แปลใหม่)",
        },
      ]),
      chapter: 197,
      expectedInternalSequence: 198,
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      source: {
        internalSequence: 198,
        chapter: 197,
        title: "Possessing",
      },
      translation: {
        chapter: 197,
        variant: "corrected_candidate",
      },
      reasonCodes: [],
    });
  });

  it("reports internal-sequence drift without remapping the source chapter", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([
        {
          tabId: "t.197",
          tabTitle: "แท็บ 17",
          index: 16,
          heading: "บทที่ 197 การสิงร่าง",
        },
      ]),
      chapter: 197,
      expectedInternalSequence: 197,
    });

    expect(result.source?.internalSequence).toBe(198);
    expect(result.reasonCodes).toContain("INTERNAL_SEQUENCE_DRIFT");
  });

  it("selects a unique production original while exposing duplicate variants", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([
        {
          tabId: "t.original",
          tabTitle: "แท็บ 17",
          index: 16,
          heading: "บทที่ 197 ค้นหาและช่วยเหลือ",
        },
        {
          tabId: "t.corrected",
          tabTitle: "บทที่ 197 การสิงร่าง",
          index: 50,
          heading: "บทที่ 197 การสิงร่าง(แปลใหม่)",
        },
      ]),
      chapter: 197,
    });

    expect(result).toMatchObject({
      status: "RESOLVED_WITH_VARIANTS",
      translation: {
        tabId: "t.original",
        variant: "production_original",
      },
      reasonCodes: ["DUPLICATE_CHAPTER_ID"],
    });
    expect(result.translationVariants).toHaveLength(2);
  });
  it("requires review when duplicate candidates have no unique production original", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([
        {
          tabId: "t.corrected-a",
          tabTitle: "แปลใหม่ A",
          index: 16,
          heading: "บทที่ 197 การสิงร่าง(แปลใหม่)",
        },
        {
          tabId: "t.corrected-b",
          tabTitle: "แปลใหม่ B",
          index: 17,
          heading: "บทที่ 197 การสิงร่าง(แก้ไข)",
        },
      ]),
      chapter: 197,
    });

    expect(result).toMatchObject({
      status: "REVIEW",
      translation: null,
      reasonCodes: ["DUPLICATE_CHAPTER_ID", "TRANSLATION_CHAPTER_AMBIGUOUS"],
    });
  });

  it("returns NOT_FOUND when source chapter is absent", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([]),
      chapter: 999,
    });

    expect(result).toEqual({
      status: "NOT_FOUND",
      source: null,
      translation: null,
      translationVariants: [],
      reasonCodes: ["SOURCE_CHAPTER_MISSING"],
    });
  });

  it("returns NOT_FOUND when translation chapter is absent", () => {
    const result = resolveChapter({
      sourceSnapshot: source,
      translationSnapshot: translationSnapshot([]),
      chapter: 197,
    });

    expect(result).toMatchObject({
      status: "NOT_FOUND",
      source: {
        chapter: 197,
        internalSequence: 198,
      },
      translation: null,
      reasonCodes: ["TRANSLATION_CHAPTER_MISSING"],
    });
  });

  it("requires review when source chapter number appears more than once", () => {
    const duplicatedSource = sourceSnapshot([
      ["บท 198: 197. Possessing", 1, 100],
      ["บท 999: 197. Duplicate", 101, 200],
    ]);

    const result = resolveChapter({
      sourceSnapshot: duplicatedSource,
      translationSnapshot: translationSnapshot([]),
      chapter: 197,
    });

    expect(result).toMatchObject({
      status: "REVIEW",
      source: null,
      reasonCodes: ["SOURCE_CHAPTER_AMBIGUOUS"],
    });
  });
});
