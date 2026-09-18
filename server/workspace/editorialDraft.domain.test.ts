import { describe, expect, it } from "vitest";
import {
  EDITORIAL_DRAFT_PRESENTATION,
  editorialDraftSha256,
  normalizeChapterHeading,
  normalizeEditorialText,
  paragraphFingerprint,
  runEditorialPreparationPipeline,
  sourcePayloadSha256,
  thaiDigitsToArabic,
  type EditorialSourcePayload,
} from "./editorialDraft.domain";

function payload(paragraphs: string[]): EditorialSourcePayload {
  return {
    sourceKind: "google_doc",
    sourceKey: "doc-1",
    providerDocumentId: "doc-1",
    mimeType: "application/vnd.google-apps.document",
    title: "Fixture",
    revisionKey: "rev-1",
    tabs: [{ sourceTabId: "tab-1", tabOrder: 0, title: "Tab 1", paragraphs }],
  };
}

describe("editorial draft Production-derived preparation", () => {
  it("normalizes invisible chars, line endings and Thai digits deterministically", () => {
    expect(thaiDigitsToArabic("บทที่ ๑๒๓")).toBe("บทที่ 123");
    expect(normalizeEditorialText("\uFEFFบทที่\u00A0๑\r\n")).toBe("บทที่1");
  });

  it("normalizes chapter prefixes while keeping title on the same paragraph", () => {
    expect(normalizeChapterHeading("ตอนที่ ๑๒： ชื่อบท")).toBe(
      "บทที่ 12 ชื่อบท"
    );
    expect(normalizeChapterHeading("Chapter 13: Title")).toBe("บทที่ 13 Title");
    expect(normalizeChapterHeading("บท 14 ชื่อ")).toBe("บทที่ 14 ชื่อ");
  });

  it("rejects duplicate tab order because structural positions must be unambiguous", () => {
    const input = payload(["ข้อความ"]);
    input.tabs.push({
      sourceTabId: "tab-2",
      tabOrder: 0,
      title: "Tab 2",
      paragraphs: ["ข้อความสอง"],
    });
    expect(() => runEditorialPreparationPipeline(input)).toThrow(
      "EDITORIAL_SOURCE_TAB_ORDER_INVALID"
    );
  });

  it("uses exact Production ending promo rules only in the tail and ensures one end marker", () => {
    const versions = runEditorialPreparationPipeline(
      payload([
        "บทที่ 1 เริ่ม",
        "โปรดติดตามตอนต่อไป",
        "เนื้อเรื่อง",
        "ฝากติดตามเพจ Ipe นิยายแปลด้วยนะ",
        "จบตอน!",
        "จบตอน",
      ])
    );
    const final = versions.at(-1)!.document.tabs[0].paragraphs.map(p => p.text);
    expect(final).toEqual(["บทที่ 1 เริ่ม", "เนื้อเรื่อง", "จบตอน"]);
  });

  it("splits the same adjacent quote/bracket pairs as Production", () => {
    const versions = runEditorialPreparationPipeline(
      payload(["“หนึ่ง” “สอง”", "[A][B]", "【HP: 10】【MP: 20】"])
    );
    const final = versions.at(-1)!.document.tabs[0].paragraphs.map(p => p.text);
    expect(final).toContain("“หนึ่ง”");
    expect(final).toContain("“สอง”");
    expect(final).toContain("[A]");
    expect(final).toContain("[B]");
    expect(final).toContain("【HP: 10】");
    expect(final).toContain("【MP: 20】");
  });

  it("removes a high-confidence English source block before the Thai translated heading", () => {
    const versions = runEditorialPreparationPipeline(
      payload([
        "Chapter 8 The Gate",
        "This is a sufficiently English source paragraph with many latin words.",
        "Another English source paragraph remains before the translated chapter.",
        "บทที่ 8 ประตู",
        "นี่คือเนื้อหาภาษาไทยหลังหัวบท",
        "นี่คือย่อหน้าภาษาไทยอีกย่อหน้า",
      ])
    );
    const english = versions.find(
      v => v.transformCode === "english_source_cleanup"
    );
    expect(english).toBeTruthy();
    const final = versions.at(-1)!.document.tabs[0].paragraphs.map(p => p.text);
    expect(final[0]).toBe("บทที่ 8 ประตู");
    expect(final.join("\n")).not.toContain("English source");
  });

  it("keeps uncertain English source and exposes a warning instead of deleting it", () => {
    const versions = runEditorialPreparationPipeline(
      payload([
        "Chapter 9 Maybe",
        "Short English.",
        "บทที่ 9 บางที",
        "ไทยหนึ่ง",
      ])
    );
    const final = versions.at(-1)!.document;
    expect(final.tabs[0].paragraphs.map(p => p.text)).toContain(
      "บทที่ 9 Maybe"
    );
    expect(final.warnings).toContain("ENGLISH_SOURCE_UNCERTAIN");
  });

  it("records source-no-chapter warning without deleting the note", () => {
    const versions = runEditorialPreparationPipeline(
      payload(["ต้นฉบับไม่มีเลขบท", "เนื้อหา"])
    );
    const final = versions.at(-1)!.document;
    expect(final.warnings).toContain("SOURCE_NO_CHAPTER_NOTE");
    expect(final.tabs[0].paragraphs.map(p => p.text)).toContain(
      "ต้นฉบับไม่มีเลขบท"
    );
  });

  it("retains duplicate-source occurrence identity through later paragraph splitting", () => {
    const versions = runEditorialPreparationPipeline(
      payload(["เหมือนกัน", "เหมือนกัน", "“หนึ่ง” “สอง”"])
    );
    const base = versions[0].document.tabs[0].paragraphs;
    expect(base[0].occurrenceCount).toBe(2);
    expect(base[0].sourceOccurrenceCount).toBe(2);
    expect(base[0].occurrenceOrdinal).toBe(1);
    expect(base[0].sourceOccurrenceOrdinal).toBe(1);
    expect(base[1].occurrenceOrdinal).toBe(2);
    expect(base[1].sourceOccurrenceOrdinal).toBe(2);

    const final = versions.at(-1)!.document.tabs[0].paragraphs;
    const splitChildren = final.filter(p => p.sourceParagraphIndex === 3);
    expect(splitChildren).toHaveLength(2);
    expect(splitChildren.every(p => p.occurrenceCount === 1)).toBe(true);
    expect(splitChildren.every(p => p.sourceOccurrenceCount === 1)).toBe(true);
    expect(new Set(splitChildren.map(p => p.paragraphKey)).size).toBe(2);
  });

  it("persists a stable paragraph key plus the full tab fingerprint sequence", () => {
    const versions = runEditorialPreparationPipeline(
      payload(["บทที่ 1", "ข้อความ"])
    );
    const final = versions.at(-1)!.document;
    expect(final.tabs[0].structuralSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(final.tabs[0].fingerprintSequence).toEqual(
      final.tabs[0].paragraphs.map(p => p.paragraphFingerprint)
    );
    expect(
      final.tabs[0].paragraphs.every(p => /^[a-f0-9]{64}$/.test(p.paragraphKey))
    ).toBe(true);
    expect(final.tabs[0].chapterNumber).toBe("1");
    expect(final.tabs[0].chapterTitle).toBeNull();
  });

  it("hashes preparation input deterministically without treating document-title metadata as draft content", () => {
    const input = payload(["บทที่ 1", "ข้อความ"]);
    const renamed = { ...input, title: "Renamed source document" };
    expect(sourcePayloadSha256(input)).toBe(sourcePayloadSha256(input));
    expect(sourcePayloadSha256(renamed)).toBe(sourcePayloadSha256(input));
    const final = runEditorialPreparationPipeline(input).at(-1)!.document;
    expect(editorialDraftSha256(final)).toMatch(/^[a-f0-9]{64}$/);
    expect(paragraphFingerprint("ข้อความ")).toMatch(/^[a-f0-9]{64}$/);
    expect(EDITORIAL_DRAFT_PRESENTATION).toEqual({
      fontFamily: "Sarabun",
      fontSizePt: 18,
      firstLineIndentPt: 36,
      spacingAfterPt: 10,
    });
  });

  it("creates a new hash/version only for content-changing transforms after source_base", () => {
    const versions = runEditorialPreparationPipeline(
      payload(["\uFEFFตอนที่ ๑: ชื่อ", "", "“ก” “ข”"])
    );
    expect(versions[0].transformCode).toBe("source_base");
    expect(new Set(versions.map(v => v.afterSha256)).size).toBe(
      versions.length
    );
    expect(versions.map(v => v.transformCode)).toEqual(
      expect.arrayContaining([
        "unicode_thai_digit_cleanup",
        "chapter_heading_cleanup",
        "quote_bracket_split",
        "blank_line_cleanup",
        "ending_cleanup",
      ])
    );
  });
});
