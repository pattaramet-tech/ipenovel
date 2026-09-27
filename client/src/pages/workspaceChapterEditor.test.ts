import { describe, expect, it } from "vitest";
import {
  chapterEditorFindingRanges,
  chapterEditorIssues,
  chapterEditorMatchesFilter,
  chapterEditorStructuralRepairGuidance,
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

  it("builds a chapter issue stream from foreign findings and structural anomalies", () => {
    expect(
      chapterEditorIssues({
        sourceTabId: "tab-2",
        findings: [
          {
            id: 2,
            findingKey: "b",
            sourceTabId: "tab-2",
            paragraphKey: "p2",
            paragraphOrder: 2,
            startOffset: 5,
            endOffset: 8,
            token: "B",
            ruleKey: "latin_word",
            disposition: "fixed",
          },
          {
            id: 1,
            findingKey: "a",
            sourceTabId: "tab-2",
            paragraphKey: "p1",
            paragraphOrder: 1,
            startOffset: 1,
            endOffset: 4,
            token: "A",
            ruleKey: "latin_word",
            disposition: "open",
          },
          {
            id: 4,
            findingKey: "accepted",
            sourceTabId: "tab-2",
            paragraphKey: "p3",
            paragraphOrder: 3,
            startOffset: 0,
            endOffset: 8,
            token: "Accepted",
            ruleKey: "latin_word",
            disposition: "accepted",
          },
          {
            id: 3,
            findingKey: "c",
            sourceTabId: "tab-3",
            paragraphKey: "p3",
            paragraphOrder: 1,
            startOffset: 0,
            endOffset: 1,
            token: "C",
            ruleKey: "latin_word",
          },
        ],
        anomalies: [
          {
            id: 5,
            anomalyKey: "z",
            anomalyType: "duplicate_content_exact",
            severity: "warning",
            sourceTabId: "tab-1",
            relatedSourceTabIds: ["tab-1", "tab-2"],
            message: "duplicate",
          },
          {
            id: 4,
            anomalyKey: "y",
            anomalyType: "empty_tab",
            severity: "error",
            sourceTabId: "tab-2",
            relatedSourceTabIds: ["tab-2"],
            message: "empty",
          },
        ],
      }).map(issue => issue.key)
    ).toEqual([
      "finding:a",
      "finding:b",
      "finding:accepted",
      "structural:z",
      "structural:y",
    ]);
  });

  it("provides explicit structural repair guidance without auto-fixing content", () => {
    expect(chapterEditorStructuralRepairGuidance("empty_tab")).toContain(
      "เติมเนื้อหา"
    );
    expect(chapterEditorStructuralRepairGuidance("source_note_only")).toContain(
      "ยืนยัน"
    );
    expect(
      chapterEditorStructuralRepairGuidance("duplicate_content_exact")
    ).toContain("เปิดแท็บ");
    expect(
      chapterEditorStructuralRepairGuidance("missing_expected_chapter")
    ).toContain("แท็บใกล้เคียง");
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
          {
            sourceTabId: "tab-2",
            relatedSourceTabIds: [],
            disposition: "confirmed_source_note",
          },
          { relatedSourceTabIds: ["tab-3"] },
        ],
      })
    ).toEqual({
      edited: true,
      foreignFindingCount: 1,
      structuralIssueCount: 1,
      confirmedStructuralCount: 1,
      issueCount: 2,
      progressState: "pending",
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
      confirmedStructuralCount: 0,
      issueCount: 0,
      progressState: "passed",
    });
  });

  it("filters chapters by issue and edit state without conflating QC progress", () => {
    const pending = chapterEditorTabStatus({
      sourceTabId: "tab-1",
      checkerCurrent: true,
      paragraphs: [],
      findings: [{ sourceTabId: "tab-1", disposition: "open" }],
    });
    const edited = chapterEditorTabStatus({
      sourceTabId: "tab-2",
      checkerCurrent: true,
      paragraphs: [
        {
          sourceParagraphIndex: -1,
          sourceParagraphFingerprint: "manual",
          paragraphFingerprint: "manual",
        },
      ],
      anomalies: [
        {
          sourceTabId: "tab-2",
          disposition: "confirmed_source_note",
        },
      ],
    });
    const unchecked = chapterEditorTabStatus({
      sourceTabId: "tab-3",
      checkerCurrent: false,
      paragraphs: [],
    });

    expect(chapterEditorMatchesFilter("issue", pending)).toBe(true);
    expect(chapterEditorMatchesFilter("unedited", pending)).toBe(true);
    expect(chapterEditorMatchesFilter("edited", pending)).toBe(false);
    expect(chapterEditorMatchesFilter("edited", edited)).toBe(true);
    expect(edited.progressState).toBe("confirmed");
    expect(unchecked.progressState).toBe("unchecked");
  });
});
