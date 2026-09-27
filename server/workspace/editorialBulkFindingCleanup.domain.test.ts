import { describe, expect, it } from "vitest";

import {
  applyEditorialBulkCleanupToDocument,
  editorialBulkCleanupGroupKey,
  groupEditorialBulkCleanupFindings,
} from "./editorialBulkFindingCleanup.domain";
import { reindexEditorialDraftDocument } from "./editorialDraft.domain";

function document(paragraphs: string[]) {
  return reindexEditorialDraftDocument({
    tabs: [
      {
        sourceTabId: "tab-1",
        tabOrder: 0,
        title: "บทที่ 74",
        chapterNumber: "74",
        chapterTitle: "ทดสอบ",
        warnings: [],
        fingerprintSequence: [],
        structuralSha256: "",
        paragraphs: paragraphs.map((text, index) => ({
          paragraphKey: `p-${index + 1}`,
          sourceParagraphIndex: index,
          paragraphOrder: index + 1,
          text,
          sourceParagraphFingerprint: "",
          sourceOccurrenceCount: 1,
          sourceOccurrenceOrdinal: 1,
          paragraphFingerprint: "",
          occurrenceCount: 1,
          occurrenceOrdinal: 1,
        })),
      },
    ],
    warnings: [],
  });
}

describe("Editorial Bulk Finding Cleanup domain", () => {
  it("groups identical findings across work items", () => {
    const rows = [11, 12, 12].map((workItemId, index) => ({
      workItemId,
      finding: {
        findingKey: `f-${index}`,
        ruleKey: "source_junk",
        token: "alex02373",
        normalizedToken: "alex02373",
        sourceTabId: "tab-1",
        paragraphKey: `p-${index}`,
        paragraphOrder: index + 1,
        paragraphFingerprint: "a".repeat(64),
        startOffset: 0,
        endOffset: 9,
        disposition: "open",
        resolutionVersion: 0,
      },
    }));
    const [group] = groupEditorialBulkCleanupFindings(rows);
    expect(group).toMatchObject({
      ruleKey: "source_junk",
      displayToken: "alex02373",
      occurrenceCount: 3,
      paragraphCount: 3,
      workItemCount: 2,
      workItemIds: [11, 12],
    });
    expect(group.groupKey).toBe(
      editorialBulkCleanupGroupKey({
        ruleKey: "source_junk",
        normalizedToken: "alex02373",
      })
    );
  });

  it("removes repeated inline exact findings without creating multiple drafts", () => {
    const input = document([
      "บทที่ 74",
      "พบ ाइट แล้วพบ ाइट อีกครั้ง",
      "จบตอน",
    ]);
    const paragraph = input.tabs[0].paragraphs[1];
    const first = paragraph.text.indexOf("ाइट");
    const second = paragraph.text.lastIndexOf("ाइट");
    const result = applyEditorialBulkCleanupToDocument({
      document: input,
      findings: [first, second].map((startOffset, index) => ({
        findingKey: `f-${index}`,
        ruleKey: "foreign_script",
        token: "ाइट",
        normalizedToken: "ाइट",
        sourceTabId: "tab-1",
        paragraphKey: paragraph.paragraphKey,
        paragraphOrder: paragraph.paragraphOrder,
        paragraphFingerprint: paragraph.paragraphFingerprint,
        startOffset,
        endOffset: startOffset + "ाइट".length,
        disposition: "open",
        resolutionVersion: 0,
      })),
    });
    expect(result.removedFindingCount).toBe(2);
    expect(result.changedParagraphCount).toBe(1);
    expect(result.removedParagraphCount).toBe(0);
    expect(result.document.tabs[0].paragraphs[1].text).toBe(
      "พบ แล้วพบ อีกครั้ง"
    );
  });

  it("removes whole source-junk paragraphs", () => {
    const input = document([
      "บทที่ 74",
      "เนื้อหาปกติ",
      "ความคิดของผู้สร้าง",
      "alex02373",
      "จบตอน",
    ]);
    const junk = input.tabs[0].paragraphs.slice(2);
    const result = applyEditorialBulkCleanupToDocument({
      document: input,
      findings: junk.map((paragraph, index) => ({
        findingKey: `j-${index}`,
        ruleKey: "source_junk",
        token: paragraph.text,
        normalizedToken: paragraph.text,
        sourceTabId: "tab-1",
        paragraphKey: paragraph.paragraphKey,
        paragraphOrder: paragraph.paragraphOrder,
        paragraphFingerprint: paragraph.paragraphFingerprint,
        startOffset: 0,
        endOffset: paragraph.text.length,
        disposition: "open",
        resolutionVersion: 0,
      })),
    });
    expect(result.removedParagraphCount).toBe(3);
    expect(result.document.tabs[0].paragraphs.map(row => row.text)).toEqual([
      "บทที่ 74",
      "เนื้อหาปกติ",
    ]);
  });

  it("fails closed when a paragraph fingerprint is stale", () => {
    const input = document(["บทที่ 1", "พบ ाइट"]);
    const paragraph = input.tabs[0].paragraphs[1];
    expect(() =>
      applyEditorialBulkCleanupToDocument({
        document: input,
        findings: [
          {
            findingKey: "stale",
            ruleKey: "foreign_script",
            token: "ाइट",
            normalizedToken: "ाइट",
            sourceTabId: "tab-1",
            paragraphKey: paragraph.paragraphKey,
            paragraphOrder: paragraph.paragraphOrder,
            paragraphFingerprint: "0".repeat(64),
            startOffset: 3,
            endOffset: 6,
            disposition: "open",
            resolutionVersion: 0,
          },
        ],
      })
    ).toThrow(/identity changed/i);
  });
});
