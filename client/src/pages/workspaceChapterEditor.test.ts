import { describe, expect, it } from "vitest";
import {
  chapterEditorFindingRanges,
  chapterEditorTabStatus,
  parseChapterEditorPasteText,
  serializeChapterEditorParagraphs,
} from "./workspaceChapterEditor";

describe("workspace Chapter Editor paragraph helpers", () => {
  it("normalizes pasted blank rows into paragraph blocks", () => {
    expect(
      parseChapterEditorPasteText(
        "บทที่ 78: พลังของเดรก\r\n\r\nย่อหน้าแรก\r\n\r\n\r\nย่อหน้าสอง"
      )
    ).toEqual(["บทที่ 78: พลังของเดรก", "ย่อหน้าแรก", "ย่อหน้าสอง"]);
  });

  it("also treats plain-text single line breaks as paragraph boundaries", () => {
    expect(parseChapterEditorPasteText("หนึ่ง\nสอง\nสาม")).toEqual([
      "หนึ่ง",
      "สอง",
      "สาม",
    ]);
  });

  it("serializes visual paragraph blocks back to the existing replace_tab contract", () => {
    expect(
      serializeChapterEditorParagraphs([
        " บทที่ 78: พลังของเดรก ",
        "",
        "ย่อหน้าแรก",
        "ย่อหน้า\nที่มี soft break",
      ])
    ).toBe(
      "บทที่ 78: พลังของเดรก\n\nย่อหน้าแรก\n\nย่อหน้า\nที่มี soft break"
    );
  });

  it("keeps foreign highlights on exact checker offsets inside one paragraph", () => {
    const text = "ศัตรูใช้ support แล้ว";
    expect(
      chapterEditorFindingRanges(text, [
        { startOffset: 9, endOffset: 16, token: "support" },
      ])
    ).toEqual([{ start: 9, end: 16 }]);
    expect(
      chapterEditorFindingRanges("ศัตรูใช้ ซัพพอร์ต แล้ว", [
        { startOffset: 9, endOffset: 16, token: "support" },
      ])
    ).toEqual([]);
  });

  it("derives edited, foreign-word and structural status per tab", () => {
    expect(
      chapterEditorTabStatus({
        sourceTabId: "tab-2",
        paragraphs: [
          {
            sourceParagraphIndex: 1,
            sourceParagraphFingerprint: "source-a",
            paragraphFingerprint: "source-a",
          },
          {
            sourceParagraphIndex: -2,
            sourceParagraphFingerprint: "manual-b",
            paragraphFingerprint: "manual-b",
          },
        ],
        findings: [
          { sourceTabId: "tab-2", disposition: "open" },
          { sourceTabId: "tab-2", disposition: "fixed" },
          { sourceTabId: "tab-3", disposition: "open" },
        ],
        anomalies: [
          { relatedSourceTabIds: ["tab-1", "tab-2"] },
          { relatedSourceTabIds: ["tab-3"] },
        ],
      })
    ).toEqual({
      edited: true,
      foreignFindingCount: 1,
      structuralIssueCount: 1,
    });

    expect(
      chapterEditorTabStatus({
        sourceTabId: "tab-1",
        paragraphs: [
          {
            sourceParagraphIndex: 1,
            sourceParagraphFingerprint: "same",
            paragraphFingerprint: "same",
          },
        ],
      })
    ).toEqual({
      edited: false,
      foreignFindingCount: 0,
      structuralIssueCount: 0,
    });
  });
});
