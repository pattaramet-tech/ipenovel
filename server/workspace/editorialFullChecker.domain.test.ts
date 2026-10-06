import { describe, expect, it } from "vitest";

import {
  editorialDraftSha256,
  paragraphFingerprint,
  reindexEditorialDraftDocument,
  type EditorialDraftDocument,
  type EditorialDraftParagraph,
} from "./editorialDraft.domain";
import {
  EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
  applyEditorialFullCheckerTransform,
  evaluateEditorialFullChecker,
  previewEditorialFullCheckerTransform,
  resolveEditorialFullCheckerFindingTarget,
} from "./editorialFullChecker.domain";

function paragraph(
  text: string,
  key: string,
  paragraphOrder: number,
  sourceParagraphIndex = paragraphOrder
): EditorialDraftParagraph {
  const fingerprint = paragraphFingerprint(text);
  return {
    paragraphKey: key,
    sourceParagraphIndex,
    paragraphOrder,
    text,
    sourceParagraphFingerprint: fingerprint,
    sourceOccurrenceCount: 1,
    sourceOccurrenceOrdinal: 1,
    paragraphFingerprint: fingerprint,
    occurrenceCount: 1,
    occurrenceOrdinal: 1,
  };
}

function documentFromTabs(
  tabs: Array<{
    sourceTabId: string;
    tabOrder: number;
    title?: string;
    chapterNumber?: string | null;
    chapterTitle?: string | null;
    paragraphs: string[];
  }>
): EditorialDraftDocument {
  return reindexEditorialDraftDocument({
    warnings: [],
    tabs: tabs.map(tab => ({
      sourceTabId: tab.sourceTabId,
      tabOrder: tab.tabOrder,
      title: tab.title ?? tab.sourceTabId,
      paragraphs: tab.paragraphs.map((text, index) =>
        paragraph(text, `${tab.sourceTabId}-p${index + 1}`, index + 1)
      ),
      fingerprintSequence: [],
      structuralSha256: "",
      chapterNumber: tab.chapterNumber ?? null,
      chapterTitle: tab.chapterTitle ?? null,
      warnings: [],
    })),
  });
}

function oneTab(...paragraphs: string[]) {
  return documentFromTabs([
    { sourceTabId: "tab-1", tabOrder: 1, paragraphs },
  ]);
}

describe("IPE-058-D Full Checker parity core", () => {
  it("1. accepts clean Thai-only narrative", () => {
    const result = evaluateEditorialFullChecker({
      document: oneTab("บทที่ 1 เริ่มต้น", "เขาเดินกลับบ้านอย่างเงียบงัน", "จบตอน"),
    });
    expect(result.engineVersion).toBe(EDITORIAL_FULL_CHECKER_ENGINE_VERSION);
    expect(result.findings.filter(row => row.category === "foreign")).toHaveLength(0);
  });

  it("2. keeps a short allowed English name non-blocking", () => {
    const result = evaluateEditorialFullChecker({
      document: oneTab("บทที่ 1", "Naruto เดินเข้าห้อง"),
    });
    expect(result.findings.some(row => row.code === "long_english")).toBe(false);
  });

  it("3. reports suspicious long English", () => {
    const result = evaluateEditorialFullChecker({
      document: oneTab(
        "บทที่ 1",
        "This is a deliberately long untranslated English sentence with enough words and enough latin characters to trigger the deterministic checker."
      ),
    });
    expect(result.findings.some(row => row.code === "long_english")).toBe(true);
  });

  it.each([
    ["4. Japanese residue", "เขาเห็น テスト อยู่ตรงหน้า"],
    ["5. Chinese residue", "เขาเห็น 中文 อยู่ตรงหน้า"],
    ["6. Korean residue", "เขาเห็น 테스트 อยู่ตรงหน้า"],
    ["7. Devanagari residue", "เขาเห็น परीक्षण อยู่ตรงหน้า"],
    ["7b. Cyrillic residue", "เขาเห็น Привет อยู่ตรงหน้า"],
  ])("%s", (_label, text) => {
    const result = evaluateEditorialFullChecker({
      document: oneTab("บทที่ 1", text),
    });
    expect(result.findings.some(row => row.code === "foreign_script")).toBe(true);
  });

  it("8. preserves a kaomoji exception", () => {
    const result = evaluateEditorialFullChecker({
      document: oneTab("บทที่ 1", "เขายิ้ม (￣▽￣) แล้วเดินต่อ"),
    });
    expect(result.findings.some(row => row.code === "foreign_script")).toBe(false);
  });

  it("9. previews deterministic chapter heading normalization", () => {
    const draft = oneTab("chapter 12 Test title", "เนื้อเรื่อง");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "chapter_heading_cleanup",
    });
    expect(preview.changed).toBe(true);
    expect(preview.document.tabs[0]!.paragraphs[0]!.text).toBe("บทที่ 12 Test title");
  });

  it("10. normalizes Thai digits in a heading", () => {
    const draft = oneTab("ตอนที่ ๑๒ ชื่อตอน", "เนื้อเรื่อง");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "chapter_heading_cleanup",
    });
    expect(preview.document.tabs[0]!.paragraphs[0]!.text).toContain("บทที่ 12");
  });

  it("11. never coerces a range-shaped heading into a single chapter identity", () => {
    const draft = oneTab("บทที่ 001—030 ช่วงรวม", "เนื้อเรื่อง");
    const result = evaluateEditorialFullChecker({ document: draft });
    expect(result.findings.some(row => row.code === "range_shaped_chapter_identity")).toBe(true);
    const after = applyEditorialFullCheckerTransform({
      document: draft,
      transformCode: "chapter_heading_cleanup",
    });
    expect(after.tabs[0]!.chapterNumber).toBe("001-030");
  });

  it("12. previews blank cleanup", () => {
    const draft = oneTab("บทที่ 1", "เนื้อเรื่อง", "   ", "จบตอน");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "blank_line_cleanup",
    });
    expect(preview.changed).toBe(true);
    expect(preview.document.tabs[0]!.paragraphs.map(row => row.text)).not.toContain("   ");
  });

  it("13. splits adjacent quote pairs deterministically", () => {
    const draft = oneTab("บทที่ 1", "“หนึ่ง” “สอง”", "จบตอน");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "quote_bracket_split",
    });
    expect(preview.changed).toBe(true);
    expect(preview.document.tabs[0]!.paragraphs.length).toBeGreaterThan(draft.tabs[0]!.paragraphs.length);
  });

  it("14. splits adjacent bracket status blocks", () => {
    const draft = oneTab("บทที่ 1", "【HP: 10】【MP: 20】", "จบตอน");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "quote_bracket_split",
    });
    expect(preview.document.tabs[0]!.paragraphs.some(row => row.text === "【HP: 10】")).toBe(true);
    expect(preview.document.tabs[0]!.paragraphs.some(row => row.text === "【MP: 20】")).toBe(true);
  });

  it("15. reports a source-note-only tab without mutating it", () => {
    const draft = oneTab("บทที่ 1", "หมายเหตุต้นฉบับไม่มีบทที่");
    const result = evaluateEditorialFullChecker({ document: draft });
    expect(result.findings.some(row => row.code === "source_note_only")).toBe(true);
  });

  it("16. bounds source junk and previews only the bounded junk removal", () => {
    const draft = oneTab(
      "บทที่ 1",
      "เนื้อเรื่องก่อนหน้า",
      "หมายเหตุผู้เขียน: วันนี้ลงช้า",
      "...",
      "พระเอกเปิดประตูแล้วเดินกลับเข้าห้อง",
      "จบตอน"
    );
    const result = evaluateEditorialFullChecker({ document: draft });
    expect(result.findings.filter(row => row.code === "source_junk")).toHaveLength(2);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "source_junk_cleanup",
    });
    const texts = preview.document.tabs[0]!.paragraphs.map(row => row.text);
    expect(texts).toContain("พระเอกเปิดประตูแล้วเดินกลับเข้าห้อง");
    expect(texts).not.toContain("หมายเหตุผู้เขียน: วันนี้ลงช้า");
  });

  it("17. previews only HIGH-confidence English-source cleanup", () => {
    const draft = oneTab(
      "chapter 1",
      "This source paragraph is intentionally long enough to look like untranslated source material.",
      "Another untranslated source paragraph remains here for deterministic detection.",
      "บทที่ 1 ชื่อไทย",
      "เนื้อเรื่องไทยย่อหน้าที่หนึ่ง",
      "เนื้อเรื่องไทยย่อหน้าที่สอง"
    );
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "english_source_cleanup",
    });
    expect(preview.changed).toBe(true);
    expect(preview.document.tabs[0]!.paragraphs[0]!.text).toContain("บทที่ 1");
  });

  it("18. deduplicates ending markers", () => {
    const draft = oneTab("บทที่ 1", "เนื้อเรื่อง", "จบตอน", "จบตอน");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    expect(
      preview.document.tabs[0]!.paragraphs.filter(row => row.text === "จบตอน")
    ).toHaveLength(1);
  });

  it("19. adds one ending marker only when narrative evidence is sufficient", () => {
    const narrative = oneTab("บทที่ 1", "เนื้อเรื่องจริง");
    const preview = previewEditorialFullCheckerTransform({
      document: narrative,
      transformCode: "ending_cleanup",
    });
    expect(preview.document.tabs[0]!.paragraphs.at(-1)?.text).toBe("จบตอน");

    const headingOnly = oneTab("บทที่ 2");
    const blocked = previewEditorialFullCheckerTransform({
      document: headingOnly,
      transformCode: "ending_cleanup",
    });
    expect(blocked.changed).toBe(false);
  });

  it("20. reports duplicate chapter numbers using the existing structural checker", () => {
    const draft = documentFromTabs([
      { sourceTabId: "tab-a", tabOrder: 1, paragraphs: ["บทที่ 1", "เนื้อหา A"] },
      { sourceTabId: "tab-b", tabOrder: 2, paragraphs: ["บทที่ 1", "เนื้อหา B"] },
    ]);
    const result = evaluateEditorialFullChecker({ document: draft });
    expect(result.findings.some(row => row.code === "duplicate_chapter_number")).toBe(true);
  });

  it("21. reports missing chapters from the canonical episode range", () => {
    const draft = documentFromTabs([
      { sourceTabId: "tab-1", tabOrder: 1, paragraphs: ["บทที่ 1", "เนื้อหา"] },
      { sourceTabId: "tab-3", tabOrder: 2, paragraphs: ["บทที่ 3", "เนื้อหา"] },
    ]);
    const result = evaluateEditorialFullChecker({
      document: draft,
      episodeNumber: "001-003",
    });
    expect(result.findings.some(row => row.code === "missing_expected_chapter")).toBe(true);
  });

  it("22. reports out-of-order chapters from chapter identity, not tabOrder-as-number", () => {
    const draft = documentFromTabs([
      { sourceTabId: "late", tabOrder: 1, paragraphs: ["บทที่ 2", "เนื้อหา"] },
      { sourceTabId: "early", tabOrder: 2, paragraphs: ["บทที่ 1", "เนื้อหา"] },
    ]);
    const result = evaluateEditorialFullChecker({ document: draft });
    expect(result.findings.some(row => row.code === "out_of_order_chapter")).toBe(true);
  });

  it("23. proves transform idempotency and a second pass is a no-op", () => {
    const draft = oneTab("chapter 1", "เนื้อเรื่อง", "", "จบตอน", "จบตอน");
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "all_safe",
    });
    expect(preview.idempotent).toBe(true);
    const twice = applyEditorialFullCheckerTransform({
      document: preview.document,
      transformCode: "all_safe",
    });
    expect(editorialDraftSha256(twice)).toBe(preview.afterDraftSha256);
  });

  it("24. fails safe to no target for a stale paragraphKey", () => {
    const draft = oneTab("บทที่ 1", "เนื้อเรื่อง テスト");
    const result = evaluateEditorialFullChecker({ document: draft });
    const finding = result.findings.find(row => row.code === "foreign_script")!;
    expect(resolveEditorialFullCheckerFindingTarget(draft, finding)?.text).toBe("テスト");
    expect(
      resolveEditorialFullCheckerFindingTarget(draft, {
        ...finding,
        paragraphKey: "stale-paragraph-key",
      })
    ).toBeNull();
  });

  it("25. reports UTF-16 offsets correctly after an emoji", () => {
    const text = "😀ภาษาไทย テスト ต่อ";
    const draft = oneTab("บทที่ 1", text);
    const result = evaluateEditorialFullChecker({ document: draft });
    const finding = result.findings.find(row => row.code === "foreign_script");
    expect(finding).toBeTruthy();
    expect(finding?.offsetEncoding).toBe("utf16");
    expect(text.slice(finding!.startOffset!, finding!.endOffset!)).toBe("テスト");
  });
});

  it("IPE-060B A/R4B. canonical note heading over narrative is an ordinary chapter", () => {
    // IPE-064R4B round 15: canonical source-note metadata over REAL
    // narrative content is an ordinary narrative chapter — the standard
    // จบตอน marker is appended (only genuinely note-only tabs keep the
    // marker-less contract).
    const draft = documentFromTabs([
      {
        sourceTabId: "note-tab",
        tabOrder: 1,
        title: "หมายเหตุจากต้นฉบับ",
        chapterNumber: "205",
        chapterTitle: "หมายเหตุจากต้นฉบับ",
        paragraphs: ["หมายเหตุจากต้นฉบับ", "เขาเดินกลับบ้านอย่างเงียบงัน"],
      },
    ]);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    const texts = preview.document.tabs[0]!.paragraphs.map(row => row.text);
    expect(texts.at(-1)).toBe("จบตอน");
    expect(texts).toContain("เขาเดินกลับบ้านอย่างเงียบงัน");
  });

  it("IPE-064R4B round 15. a genuinely note-only tab keeps the marker-less contract", () => {
    const draft = documentFromTabs([
      {
        sourceTabId: "note-tab",
        tabOrder: 1,
        title: "หมายเหตุจากต้นฉบับ",
        chapterNumber: "205",
        chapterTitle: "หมายเหตุจากต้นฉบับ",
        paragraphs: ["หมายเหตุจากต้นฉบับ"],
      },
    ]);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    const texts = preview.document.tabs[0]!.paragraphs.map(row => row.text);
    expect(texts).not.toContain("จบตอน");
    expect(texts).toContain("หมายเหตุจากต้นฉบับ");
  });

  // IPE-064R4B review round 27 (P2): leading separator paragraphs must not
  // push the note heading out of the heading-probe window — the raw
  // first-three-rows check missed it and appended จบตอน to a tab the
  // structural classifier accepts as a non-billable source note.
  it("IPE-064R4B round 27. separators before the note heading do not restore the marker", () => {
    const draft = documentFromTabs([
      {
        sourceTabId: "note-tab",
        tabOrder: 1,
        title: "หมายเหตุจากต้นฉบับ",
        chapterNumber: "205",
        chapterTitle: "หมายเหตุจากต้นฉบับ",
        paragraphs: [
          "---",
          "***",
          "===",
          "หมายเหตุจากต้นฉบับ",
          "หมายเหตุจากต้นฉบับ",
        ],
      },
    ]);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    const texts = preview.document.tabs[0]!.paragraphs.map(row => row.text);
    expect(texts).not.toContain("จบตอน");
  });

  it("IPE-060B E. ordinary narrative chapters still get the ending marker", () => {
    const preview = previewEditorialFullCheckerTransform({
      document: documentFromTabs([
        { sourceTabId: "ch", tabOrder: 1, paragraphs: ["บทที่ 9", "พายุกำลังจะมาถึง"] },
      ]),
      transformCode: "ending_cleanup",
    });
    expect(preview.document.tabs[0]!.paragraphs.at(-1)?.text).toBe("จบตอน");
  });

  it("IPE-060B F. chapters already carrying จบตอน are not duplicated", () => {
    const preview = previewEditorialFullCheckerTransform({
      document: documentFromTabs([
        { sourceTabId: "ch", tabOrder: 1, paragraphs: ["บทที่ 9", "พายุกำลังจะมาถึง", "จบตอน"] },
      ]),
      transformCode: "ending_cleanup",
    });
    expect(
      preview.document.tabs[0]!.paragraphs.filter(row => row.text === "จบตอน")
    ).toHaveLength(1);
  });

describe("IPE-060R1 — Thai numeral normalization in the full checker", () => {
  it("Thai-digit content upstream-normalized to Arabic receives the ending marker normally", () => {
    const draft = documentFromTabs([
      { sourceTabId: "ch", tabOrder: 1, paragraphs: ["บทที่ ๑ จุดเริ่มต้น", "พายุกำลังจะมาถึง"] },
    ]);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    expect(preview.document.tabs[0]!.paragraphs.at(-1)?.text).toBe("จบตอน");
  });


  it("digit suffix after หมายเหตุจากต้นฉบับ does not trigger the exact-note ending exception", () => {
    const draft = documentFromTabs([
      { sourceTabId: "note", tabOrder: 1, paragraphs: ["บทที่ 7", "หมายเหตุจากต้นฉบับ ๑๒๓", "เนื้อหาจริง"] },
    ]);
    const preview = previewEditorialFullCheckerTransform({
      document: draft,
      transformCode: "ending_cleanup",
    });
    // Only the EXACT canonical note is exempt — a digit suffix is ordinary
    // narrative and still receives the ending marker.
    expect(preview.document.tabs[0]!.paragraphs.at(-1)?.text).toBe("จบตอน");
  });
});
