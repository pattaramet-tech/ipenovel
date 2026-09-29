import { describe, expect, it } from "vitest";
import {
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
  EDITORIAL_FOREIGN_CHECKER_RULES,
  editorialAllowListSha256,
  evaluateEditorialForeignDraft,
  getEditorialCheckerStaleReason,
  evaluateEditorialForeignParagraph,
  isLikelyKaomoji,
  normalizeEditorialAllowedWord,
  type EditorialCheckerParagraphInput,
} from "./editorialForeignChecker.domain";

function paragraph(
  text: string,
  overrides: Partial<EditorialCheckerParagraphInput> = {}
): EditorialCheckerParagraphInput {
  return {
    sourceTabId: "tab-1",
    tabTitle: "ตอน 1",
    paragraphKey: "p-key-1",
    paragraphOrder: 1,
    paragraphFingerprint: "p-fingerprint-1",
    text,
    ...overrides,
  };
}

describe("Editorial deterministic foreign-word checker", () => {
  it("ports the Production foreign-script ranges and returns full sentence/context with stable offsets", () => {
    const text = "เขาพูดว่า テスト แล้วเดินต่อไป。ประโยคถัดไป";
    const findings = evaluateEditorialForeignParagraph(
      paragraph(text),
      new Set()
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.ruleKey).toBe(EDITORIAL_FOREIGN_CHECKER_RULES.foreignScript);
    expect(finding.token).toBe("テスト");
    expect(text.slice(finding.startOffset, finding.endOffset)).toBe("テスト");
    expect(finding.sentenceText).toBe("เขาพูดว่า テスト แล้วเดินต่อไป。");
    expect(finding.contextText).toBe(text);
    expect(finding.findingKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects Devanagari U+0900-U+097F inside Thai narrative", () => {
    const text = "มันคือโปเกมอนโอมา\u093E\u0907\u091Fกับคาบูโตะ";
    const findings = evaluateEditorialForeignParagraph(
      paragraph(text),
      new Set()
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleKey: EDITORIAL_FOREIGN_CHECKER_RULES.foreignScript,
      token: "\u093E\u0907\u091F",
    });
    expect(
      Array.from(findings[0].token).map(char =>
        "U+" + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
      )
    ).toEqual(["U+093E", "U+0907", "U+091F"]);
  });

  it("flags a source-junk tail block from the first strong marker through chapter end", () => {
    const rows = [
      paragraph("เนื้อเรื่องปกติ", { paragraphKey: "p1", paragraphOrder: 1 }),
      paragraph("ขอบคุณสำหรับพาวเวอร์สโตนทั้งหมด", { paragraphKey: "p2", paragraphOrder: 2 }),
      paragraph("โดยเฉพาะสิบอันดับแรกของพาวเวอร์สโตน", { paragraphKey: "p3", paragraphOrder: 3 }),
      paragraph("Unown", { paragraphKey: "p4", paragraphOrder: 4 }),
      paragraph("Oboro", { paragraphKey: "p5", paragraphOrder: 5 }),
      paragraph("--------------------------------", { paragraphKey: "p6", paragraphOrder: 6 }),
      paragraph("หากคุณอยากอ่านตอนถัดไปก่อนใคร หรือเพียงอยากสนับสนุนผม", { paragraphKey: "p7", paragraphOrder: 7 }),
      paragraph("ความคิดของผู้สร้าง", { paragraphKey: "p8", paragraphOrder: 8 }),
      paragraph("alex02373 alex02373", { paragraphKey: "p9", paragraphOrder: 9 }),
      paragraph("จบตอน", { paragraphKey: "p10", paragraphOrder: 10 }),
    ];
    const result = evaluateEditorialForeignDraft({ paragraphs: rows });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(junk[0].message).toContain("ข้อความขยะ/ข้อความท้ายต้นฉบับ");
    expect(result.status).toBe("failed");
  });

  it("bounds an inline author-note junk block and preserves narrative that resumes afterward", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("บท 225 ตอนที่ 256: เข้าหลอม (II)", {
          paragraphKey: "mid-title",
          paragraphOrder: 1,
        }),
        paragraph("หมายเหตุผู้เขียน: พระเจ้า ผู้แต่งลงสองวันติดกัน โลกกำลังจะแตกหรืออะไรสักอย่าง", {
          paragraphKey: "mid-note",
          paragraphOrder: 2,
        }),
        paragraph("...", {
          paragraphKey: "mid-ellipsis",
          paragraphOrder: 3,
        }),
        paragraph("ช่วงเช้ากับโยรุอิจิทิ้งให้คาซึยะไม่มีเอนเท่าใดนัก ความสุขบริสุทธิ์สีสิบบนที่กับชุนซุยย่อมพลิกอารมณ์ทั้งหมด แต่เขารู้สึกประหลาดเล็กน้อยที่จะมีเซ็กซ์ ทั้งที่อุโนฮานะนั่งอยู่ชั้นล่างเพียงหนึ่งชั้น", {
          paragraphKey: "mid-story-1",
          paragraphOrder: 4,
        }),
        paragraph("‘ตอนนี้ไม่ได้’", {
          paragraphKey: "mid-story-2",
          paragraphOrder: 5,
        }),
        paragraph("ขณะที่กำลังจะใส่เสื้อแจ็กเก็ต เขาเห็นฮาริเบลหยิบเสื้อแจ็กเก็ตของชุนซุยจากพื้นและสวมกลับให้", {
          paragraphKey: "mid-story-3",
          paragraphOrder: 6,
        }),
        paragraph("จบตอน", {
          paragraphKey: "mid-end",
          paragraphOrder: 7,
        }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([2, 3]);
    expect(junk.map(finding => finding.token)).toEqual([
      "หมายเหตุผู้เขียน: พระเจ้า ผู้แต่งลงสองวันติดกัน โลกกำลังจะแตกหรืออะไรสักอย่าง",
      "...",
    ]);
  });

  it("keeps reader-directed note prose after an inline note anchor but stops when narrative resumes", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงช้า", { paragraphKey: "inline-prose-anchor", paragraphOrder: 1 }),
        paragraph("หวังว่าทุกคนจะชอบและสนุกกับตอนนี้", { paragraphKey: "inline-prose-body", paragraphOrder: 2 }),
        paragraph("คาซึยะเปิดประตูแล้วเดินกลับเข้าไปในห้องอย่างเงียบงัน", { paragraphKey: "inline-prose-story", paragraphOrder: 3 }),
        paragraph("จบตอน", { paragraphKey: "inline-prose-end", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2]);
  });

  it("does not extend an inline junk block into ordinary prose or narrative containing an embedded link", () => {
    const ordinary = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงช้า", { paragraphKey: "common-prose-anchor", paragraphOrder: 1 }),
        paragraph("ตอนนี้เขาเขียนจดหมายได้ยากเพราะมือสั่น", { paragraphKey: "common-prose-story", paragraphOrder: 2 }),
        paragraph("เขาวางปากกาลงบนโต๊ะ", { paragraphKey: "common-prose-story-2", paragraphOrder: 3 }),
      ],
    });
    expect(
      ordinary.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);

    const proDropNarrative = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงช้า", { paragraphKey: "pro-drop-anchor", paragraphOrder: 1 }),
        paragraph("ตอนนี้เขียนจดหมายได้ยากเพราะมือสั่น", { paragraphKey: "pro-drop-story", paragraphOrder: 2 }),
        paragraph("จากนั้นจึงวางปากกาลงบนโต๊ะ", { paragraphKey: "pro-drop-story-2", paragraphOrder: 3 }),
      ],
    });
    expect(
      proDropNarrative.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);

    const embeddedLink = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงช้า", { paragraphKey: "link-prose-anchor", paragraphOrder: 1 }),
        paragraph("เขาเปิด https://example.com แล้วอ่านข้อความบนหน้าจอ", { paragraphKey: "link-prose-story", paragraphOrder: 2 }),
        paragraph("จากนั้นเขาก็ปิดหน้าต่างเบราว์เซอร์", { paragraphKey: "link-prose-story-2", paragraphOrder: 3 }),
      ],
    });
    expect(
      embeddedLink.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);
  });

  it("can detect another source-junk block after narrative resumes without contaminating the story between blocks", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงสองตอน", { paragraphKey: "multi-note-1", paragraphOrder: 1 }),
        paragraph("...", { paragraphKey: "multi-note-2", paragraphOrder: 2 }),
        paragraph("ตัวละครเดินกลับเข้าไปในห้องและปิดประตูอย่างเงียบงัน", { paragraphKey: "multi-story", paragraphOrder: 3 }),
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "multi-tail-1", paragraphOrder: 4 }),
        paragraph("alex02373 alex02373", { paragraphKey: "multi-tail-2", paragraphOrder: 5 }),
        paragraph("จบตอน", { paragraphKey: "multi-tail-3", paragraphOrder: 6 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2, 4, 5, 6]);
  });

  it("does not duplicate source-junk findings when the block ends with an empty paragraph", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "empty-tail-anchor", paragraphOrder: 1 }),
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "empty-tail-heading", paragraphOrder: 2 }),
        paragraph("", { paragraphKey: "empty-tail-terminal", paragraphOrder: 3 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2]);
    expect(new Set(junk.map(finding => finding.findingKey)).size).toBe(junk.length);
  });

  it("does not classify ordinary narrative support wording as source junk", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เพื่อนของเขายังคงสนับสนุนแผนการต่อสู้ครั้งนี้", {
          paragraphKey: "narrative-1",
          paragraphOrder: 1,
        }),
        paragraph("จบตอน", {
          paragraphKey: "narrative-2",
          paragraphOrder: 2,
        }),
      ],
    });
    expect(
      result.findings.filter(
        finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
      )
    ).toEqual([]);
  });

  it("does not turn a DxD tab-50 inline parenthetical author note into a source-junk tail", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ทุกคนเหนี่ยวไกพร้อมกัน ลูกแก้วขนาดเล็กปรากฏเหนือสิ่งปลูกสร้างและขยายใหญ่ขึ้นเรื่อย ๆ จนกลืนพื้นที่ทั้งหมด ทำลายสิ่งปลูกสร้างเหล่านั้นจนสิ้นซาก (หมายเหตุผู้เขียน: ร่างแยกใช้แมททีเรียลเบิร์สต์)", {
          sourceTabId: "tab-50",
          tabTitle: "บทที่ 185 จุดจบของสภา",
          paragraphKey: "tab50-note",
          paragraphOrder: 1,
        }),
        paragraph("เหล่าปีศาจพูดไม่ออก เจ้าของดินแดนเหล่านั้นไม่อาจคิดอย่างมีเหตุผลและจ้องจออยู่นาน", {
          sourceTabId: "tab-50",
          tabTitle: "บทที่ 185 จุดจบของสภา",
          paragraphKey: "tab50-story-2",
          paragraphOrder: 2,
        }),
        paragraph("ทัตสึยะพยักหน้าและอธิบายว่าเป็นภาพสด", {
          sourceTabId: "tab-50",
          tabTitle: "บทที่ 185 จุดจบของสภา",
          paragraphKey: "tab50-story-3",
          paragraphOrder: 3,
        }),
        paragraph("จบตอน", {
          sourceTabId: "tab-50",
          tabTitle: "บทที่ 185 จุดจบของสภา",
          paragraphKey: "tab50-end",
          paragraphOrder: 4,
        }),
      ],
    });
    expect(
      result.findings.filter(
        finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
      )
    ).toEqual([]);
  });

  it("still detects a genuine trailing author-note/source-junk section", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เนื้อเรื่องปกติ", {
          sourceTabId: "tab-tail",
          paragraphKey: "tail-story",
          paragraphOrder: 1,
        }),
        paragraph("หมายเหตุผู้เขียน", {
          sourceTabId: "tab-tail",
          paragraphKey: "tail-note",
          paragraphOrder: 2,
        }),
        paragraph("ฉันตั้งใจเขียนฉากนี้มานานแล้ว", {
          sourceTabId: "tab-tail",
          paragraphKey: "tail-message",
          paragraphOrder: 3,
        }),
        paragraph("จบตอน", {
          sourceTabId: "tab-tail",
          paragraphKey: "tail-end",
          paragraphOrder: 4,
        }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([2, 3, 4]);
  });

  it("keeps resumed narrative clean between two junk blocks (story→junk→story→note)", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เขาเดินนำทางให้เพื่อน ๆ อย่างมั่นใจ", { paragraphKey: "two-story-1", paragraphOrder: 1 }),
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงสองตอน", { paragraphKey: "two-note-1", paragraphOrder: 2 }),
        paragraph("...", { paragraphKey: "two-ellipsis", paragraphOrder: 3 }),
        paragraph("รุ่งเช้าเขาตื่นมาพร้อมแสงแดดที่ส่องเข้ามาในห้อง", { paragraphKey: "two-story-2", paragraphOrder: 4 }),
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "two-heading", paragraphOrder: 5 }),
        paragraph("ตอนนี้เขียนยากมาก และหวังว่าทุกคนจะชอบ", { paragraphKey: "two-note-2", paragraphOrder: 6 }),
        paragraph("https://www.patreon.com/author", { paragraphKey: "two-link", paragraphOrder: 7 }),
        paragraph("ขอบคุณทุกคนที่ติดตามกันมาตลอด แล้วเจอกันตอนหน้า ครับ", { paragraphKey: "two-note-3", paragraphOrder: 8 }),
        paragraph("จบตอน", { paragraphKey: "two-end", paragraphOrder: 9 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([
      2, 3, 5, 6, 7, 8, 9,
    ]);
    expect(
      junk.some(finding => finding.paragraphOrder === 4)
    ).toBe(false);
  });

  it("closes a mid-chapter heading section immediately when narrative resumes even with a later end marker", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เขาลุกขึ้นยืนช้า ๆ แล้วมองไปรอบห้อง", { paragraphKey: "close-story-1", paragraphOrder: 1 }),
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "close-heading", paragraphOrder: 2 }),
        paragraph("ตอนนี้เขียนฉากนี้ยากมาก และหวังว่าจะได้รับกำลังใจจากทุกคน", { paragraphKey: "close-note", paragraphOrder: 3 }),
        paragraph("เช้ามืดเขาออกเดินทางต่อโดยไม่บอกใคร", { paragraphKey: "close-story-2", paragraphOrder: 4 }),
        paragraph("จบตอน", { paragraphKey: "close-end", paragraphOrder: 5 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([2, 3]);
  });

  it("detects a genuine long trailing author-note section longer than six paragraphs", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เนื้อเรื่องปกติ", { paragraphKey: "long-story", paragraphOrder: 1 }),
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "long-heading", paragraphOrder: 2 }),
        paragraph("ตอนนี้ยาวมาก และหวังว่าทุกคนจะชอบจังหวะของมัน", { paragraphKey: "long-note-1", paragraphOrder: 3 }),
        paragraph("ช่วงนี้ไม่สบายอยู่ ขออภัยที่ลงช้า ครับ", { paragraphKey: "long-note-2", paragraphOrder: 4 }),
        paragraph("https://www.patreon.com/author", { paragraphKey: "long-link", paragraphOrder: 5 }),
        paragraph("รายชื่อผู้สนับสนุน", { paragraphKey: "long-supporters", paragraphOrder: 6 }),
        paragraph("Unown", { paragraphKey: "long-handle-1", paragraphOrder: 7 }),
        paragraph("Oboro", { paragraphKey: "long-handle-2", paragraphOrder: 8 }),
        paragraph("ฝากติดตามกันได้ในตอนถัดไป แล้วพบกันใหม่ครับ", { paragraphKey: "long-note-3", paragraphOrder: 9 }),
        paragraph("จบตอน", { paragraphKey: "long-end", paragraphOrder: 10 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("lets a supporter-list signal open context before boundary evaluation so plain handles stay in the junk block", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("เนื้อเรื่องปกติ", { paragraphKey: "sup-story", paragraphOrder: 1 }),
        paragraph("https://www.patreon.com/author", { paragraphKey: "sup-patreon", paragraphOrder: 2 }),
        paragraph("รายชื่อผู้สนับสนุนประจำเดือนกันยายน", { paragraphKey: "sup-heading", paragraphOrder: 3 }),
        paragraph("@Unown", { paragraphKey: "sup-handle-1", paragraphOrder: 4 }),
        paragraph("Oboro", { paragraphKey: "sup-handle-2", paragraphOrder: 5 }),
        paragraph("เขายิ้มให้เพื่อนแล้วเดินกลับบ้านในความมืด", { paragraphKey: "sup-story-2", paragraphOrder: 6 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([2, 3, 4, 5]);
  });

  it("does not treat narrative sentences beginning with supporter wording as supporter-list headings", () => {
    const thai = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "sup-neg-anchor-th", paragraphOrder: 1 }),
        paragraph("ผู้สนับสนุนประจำตระกูลเดินเข้ามาในห้อง", { paragraphKey: "sup-neg-story-th", paragraphOrder: 2 }),
        paragraph("เขาหันไปมองประตูทันที", { paragraphKey: "sup-neg-story-th-2", paragraphOrder: 3 }),
      ],
    });
    expect(
      thai.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);

    const english = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "sup-neg-anchor-en", paragraphOrder: 1 }),
        paragraph("Supporters of the king entered the hall", { paragraphKey: "sup-neg-story-en", paragraphOrder: 2 }),
        paragraph("เขาเดินตามหลังพวกเขาเข้าไป", { paragraphKey: "sup-neg-story-en-2", paragraphOrder: 3 }),
      ],
    });
    expect(
      english.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);

    const shortNarrative = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "sup-neg-short-anchor", paragraphOrder: 1 }),
        paragraph("Supporters cheered", { paragraphKey: "sup-neg-short-en", paragraphOrder: 2 }),
        paragraph("เขาคือผู้สนับสนุน", { paragraphKey: "sup-neg-short-th", paragraphOrder: 3 }),
      ],
    });
    expect(
      shortNarrative.findings.filter(finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk).map(finding => finding.paragraphOrder)
    ).toEqual([1]);
  });

  it("keeps plain handles out of the junk block when no supporter-list context is open", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "no-sup-patreon", paragraphOrder: 1 }),
        paragraph("เขายิ้มให้เพื่อนแล้วเดินกลับบ้านในความมืด", { paragraphKey: "no-sup-story", paragraphOrder: 2 }),
        paragraph("Unown", { paragraphKey: "no-sup-handle", paragraphOrder: 3 }),
        paragraph("เช้ามืดเขาออกเดินทางต่อโดยไม่บอกใคร", { paragraphKey: "no-sup-story-2", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("does not treat a plain English token as a supporter handle inside a trailing note unless supporter context is active", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "plain-heading", paragraphOrder: 1 }),
        paragraph("Unown", { paragraphKey: "plain-token", paragraphOrder: 2 }),
        paragraph("เขากล่าวตอบด้วยน้ำเสียงสุภาพครับ", { paragraphKey: "plain-story", paragraphOrder: 3 }),
        paragraph("จบตอน", { paragraphKey: "plain-end", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("does not let generic audience words extend a note block into resumed narrative", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "aud-heading", paragraphOrder: 1 }),
        paragraph("ทุกคนหันไปมองประตูเมื่อได้ยินเสียงดัง", { paragraphKey: "aud-story-1", paragraphOrder: 2 }),
        paragraph("เขาชักดาบออกมาทันทีและยืนขวางทางเข้า", { paragraphKey: "aud-story-2", paragraphOrder: 3 }),
        paragraph("จบตอน", { paragraphKey: "aud-end", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("does not treat narrative uses of farewell wording as author-note prose", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "farewell-heading", paragraphOrder: 1 }),
        paragraph("หลายปีต่อมา ทั้งสองพบกันใหม่ที่หน้าประตู", { paragraphKey: "farewell-story-1", paragraphOrder: 2 }),
        paragraph("เขายกมือทักทายก่อนจะเดินเข้าไปด้านใน", { paragraphKey: "farewell-story-2", paragraphOrder: 3 }),
        paragraph("จบตอน", { paragraphKey: "farewell-end", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("does not classify numbered resumed narrative as junk without supporter-list context", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("หมายเหตุผู้เขียน: วันนี้ลงสองตอน", { paragraphKey: "num-note", paragraphOrder: 1 }),
        paragraph("...", { paragraphKey: "num-gap", paragraphOrder: 2 }),
        paragraph("1. เขาเดินกลับเข้าไปในห้องแล้วปิดประตู", { paragraphKey: "num-story", paragraphOrder: 3 }),
        paragraph("เขาวางดาบลงบนโต๊ะอย่างระมัดระวัง", { paragraphKey: "num-story-2", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2]);
  });

  it("keeps numbered entries inside an explicit supporter list", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ขอบคุณสำหรับพาวเวอร์สโตนทั้งหมด", { paragraphKey: "num-sup-anchor", paragraphOrder: 1 }),
        paragraph("ผู้สนับสนุน", { paragraphKey: "num-sup-heading", paragraphOrder: 2 }),
        paragraph("1. Unown", { paragraphKey: "num-sup-1", paragraphOrder: 3 }),
        paragraph("2. @Oboro21", { paragraphKey: "num-sup-2", paragraphOrder: 4 }),
        paragraph("1. เขาเดินกลับเข้าไปในห้อง", { paragraphKey: "num-sup-story", paragraphOrder: 5 }),
        paragraph("เขานั่งลงข้างหน้าต่างอย่างเงียบ ๆ", { paragraphKey: "num-sup-story-2", paragraphOrder: 6 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2, 3, 4]);
  });

  it("keeps @-prefixed handles in the junk block only when a supporter-list signal opened context", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "at-sup-patreon", paragraphOrder: 1 }),
        paragraph("Supporters", { paragraphKey: "at-sup-heading", paragraphOrder: 2 }),
        paragraph("@Unown", { paragraphKey: "at-sup-handle-1", paragraphOrder: 3 }),
        paragraph("@Oboro21", { paragraphKey: "at-sup-handle-2", paragraphOrder: 4 }),
        paragraph("@user_name", { paragraphKey: "at-sup-handle-3", paragraphOrder: 5 }),
        paragraph("เขายิ้มให้เพื่อนแล้วเดินกลับบ้านในความมืด", { paragraphKey: "at-sup-story", paragraphOrder: 6 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not let an @-prefixed handle extend a junk block without supporter-list context", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "at-no-sup-patreon", paragraphOrder: 1 }),
        paragraph("เขายิ้มให้เพื่อนแล้วเดินกลับบ้านในความมืด", { paragraphKey: "at-no-sup-story", paragraphOrder: 2 }),
        paragraph("@Unown", { paragraphKey: "at-no-sup-handle", paragraphOrder: 3 }),
        paragraph("เช้ามืดเขาออกเดินทางต่อโดยไม่บอกใคร", { paragraphKey: "at-no-sup-story-2", paragraphOrder: 4 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("keeps numbered @-prefixed handles inside an explicit supporter list but stops at numbered narrative", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("https://www.patreon.com/author", { paragraphKey: "at-num-patreon", paragraphOrder: 1 }),
        paragraph("ผู้สนับสนุน", { paragraphKey: "at-num-heading", paragraphOrder: 2 }),
        paragraph("1. @Unown", { paragraphKey: "at-num-handle-1", paragraphOrder: 3 }),
        paragraph("2. @Oboro21", { paragraphKey: "at-num-handle-2", paragraphOrder: 4 }),
        paragraph("1. เขาเดินกลับเข้าไปในห้อง", { paragraphKey: "at-num-story", paragraphOrder: 5 }),
        paragraph("เขานั่งลงข้างหน้าต่างอย่างเงียบ ๆ", { paragraphKey: "at-num-story-2", paragraphOrder: 6 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2, 3, 4]);
  });

  it("still flags genuine reader-directed farewell lines as author-note junk", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "bye-heading", paragraphOrder: 1 }),
        paragraph("แล้วพบกันใหม่ตอนหน้า", { paragraphKey: "bye-1", paragraphOrder: 2 }),
        paragraph("เจอกันตอนหน้า", { paragraphKey: "bye-2", paragraphOrder: 3 }),
        paragraph("แล้วเจอกันใหม่ในตอนถัดไป ครับ", { paragraphKey: "bye-3", paragraphOrder: 4 }),
        paragraph("จบตอน", { paragraphKey: "bye-end", paragraphOrder: 5 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not keep a note block open for a bare meeting verb without farewell context", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ความคิดของผู้สร้าง", { paragraphKey: "meet-heading", paragraphOrder: 1 }),
        paragraph("พบกัน", { paragraphKey: "meet-story", paragraphOrder: 2 }),
        paragraph("เขาเดินต่อไปตามทางเดิม", { paragraphKey: "meet-story-2", paragraphOrder: 3 }),
      ],
    });
    const junk = result.findings.filter(
      finding => finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.sourceJunk
    );
    expect(junk.map(finding => finding.paragraphOrder)).toEqual([1]);
  });

  it("ignores basic A-Z/a-z alphabet words and acronyms", () => {
    const text = "เขาบอกว่าจะ support BLUE WGO เรื่องนี้ให้เต็มที่";
    expect(
      evaluateEditorialForeignParagraph(paragraph(text), new Set())
    ).toEqual([]);
  });

  it("ignores isolated and multi-letter ASCII alphabet tokens while preserving non-ASCII foreign scripts", () => {
    const findings = evaluateEditorialForeignParagraph(
      paragraph("ประตู A ปิดอยู่ BLUE WGO support แล้วเจอ テスト"),
      new Set()
    );
    expect(findings.map(item => item.token)).toEqual(["テスト"]);
  });

  it("normalizes ASCII allow words case-insensitively while keeping non-Latin tokens exact", () => {
    expect(normalizeEditorialAllowedWord("  Support  ")).toBe("support");
    expect(normalizeEditorialAllowedWord(" テスト ")).toBe("テスト");
    const findings = evaluateEditorialForeignParagraph(
      paragraph("SUPPORT テスト"),
      new Set(["support", "テスト"])
    );
    expect(findings).toHaveLength(0);
  });

  it("does not flag URLs, emails, or bare domains as English-word findings", () => {
    const text =
      "ดู https://example.com/test และ mail@example.com หรือ example.org/path";
    expect(
      evaluateEditorialForeignParagraph(paragraph(text), new Set())
    ).toEqual([]);
  });

  it("flags long English spans while ordinary ASCII words remain non-blocking", () => {
    const text =
      "นี่คือ The quick brown fox jumps over the lazy dog while another person keeps writing a sufficiently long untranslated English sentence ต่อด้วยไทย";
    const findings = evaluateEditorialForeignParagraph(paragraph(text), new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleKey: EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish,
    });
    expect(findings[0].message).toContain("พบประโยคภาษาอังกฤษยาว");
  });

  it("flags leaked write_control revision payloads as long English/control spans", () => {
    const text =
      'อิชูนะถอนหายใจ ”}}],"write_control":{"requiredRevisionId":"ANLCKQltefh534_M0rfjVhNAJM9PmNmBCaSHz22Skd9a2MV0Jf447IJ3Z1T4V00Z3st_fX5D-rKYWSSVPYw-PYFxw1m6xDr9uZ60TpCMm3M อิชูนะประสานอินเพิ่ม';
    const findings = evaluateEditorialForeignParagraph(paragraph(text), new Set());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleKey: EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish,
    });
    expect(findings[0].token).toContain('"write_control"');
    expect(findings[0].token).toContain('"requiredRevisionId"');
    expect(text.slice(findings[0].startOffset, findings[0].endOffset)).toBe(
      findings[0].token
    );
  });

  it("does not treat short English names or skill labels as long-English spans", () => {
    const findings = evaluateEditorialForeignParagraph(
      paragraph("เขาใช้ Fire Ball แล้ววิ่งต่อ"),
      new Set(["fire", "ball"])
    );
    expect(findings).toEqual([]);
  });

  it("preserves the Production kaomoji exemption without hiding nearby real foreign words", () => {
    expect(isLikelyKaomoji("Σ(っ °Д °;)っ")).toBe(true);
    const findings = evaluateEditorialForeignParagraph(
      paragraph(
        "Σ(っ °Д °;)っ แล้วเดินต่อไปอีกไกลมากจนพ้นบริบทใบหน้า แล้วเจอ テスト"
      ),
      new Set()
    );
    expect(findings.map(item => item.token)).toEqual(["テスト"]);
  });

  it("keeps the Production middle-dot exemption when it appears by itself", () => {
    const findings = evaluateEditorialForeignParagraph(
      paragraph("ชื่อ ・ ต่อ"),
      new Set()
    );
    expect(findings).toEqual([]);
  });

  it("creates distinct identities for byte-identical duplicate paragraphs because paragraphKey is part of finding identity", () => {
    const first = evaluateEditorialForeignParagraph(
      paragraph("พบ テスト", { paragraphKey: "paragraph-a" }),
      new Set()
    )[0];
    const second = evaluateEditorialForeignParagraph(
      paragraph("พบ テスト", { paragraphKey: "paragraph-b" }),
      new Set()
    )[0];
    expect(first.findingKey).not.toBe(second.findingKey);
  });

  it("keeps finding identity stable for the same paragraph content and offsets across deterministic rechecks", () => {
    const input = paragraph("เขาบอกว่า テスト เรื่องนี้");
    const first = evaluateEditorialForeignParagraph(input, new Set())[0];
    const second = evaluateEditorialForeignParagraph(input, new Set())[0];
    expect(second).toEqual(first);
  });

  it("changes finding identity when paragraph content changes even if the foreign token remains at the same offset", () => {
    const first = evaluateEditorialForeignParagraph(
      paragraph("ไทย テスト", {
        paragraphFingerprint: "fingerprint-before",
      }),
      new Set()
    ).find(item => item.token === "テスト")!;
    const second = evaluateEditorialForeignParagraph(
      paragraph("ไทย テスト", {
        paragraphFingerprint: "fingerprint-after",
      }),
      new Set()
    ).find(item => item.token === "テスト")!;
    expect(first.findingKey).not.toBe(second.findingKey);
  });

  it("orders draft findings deterministically by tab, paragraph, offset and key", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ไทย テスト", {
          sourceTabId: "tab-b",
          paragraphKey: "p-b",
          paragraphOrder: 1,
        }),
        paragraph("ไทย Привет", {
          sourceTabId: "tab-a",
          paragraphKey: "p-a",
          paragraphOrder: 2,
        }),
      ],
    });
    expect(result.engineVersion).toBe(EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION);
    expect(result.status).toBe("failed");
    expect(result.findings.map(item => item.sourceTabId)).toEqual([
      "tab-a",
      "tab-b",
    ]);
  });

  it("passes clean Thai and hashes allowlists independent of order/duplicates/case", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [paragraph("ข้อความภาษาไทยปกติ")],
      allowWords: ["Support"],
    });
    expect(result.status).toBe("passed");
    expect(result.findings).toEqual([]);
    expect(editorialAllowListSha256(["Support", "เทสต์", "support"])).toBe(
      editorialAllowListSha256(["เทสต์", "SUPPORT"])
    );
  });

  it("treats allow-list drift as checker staleness even when Draft and engine are unchanged", () => {
    const base = {
      currentDraftId: 42,
      runDraftId: 42,
      runEngineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      currentEngineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      runAllowListSha256: editorialAllowListSha256([]),
      currentAllowListSha256: editorialAllowListSha256([]),
    };
    expect(getEditorialCheckerStaleReason(base)).toBeNull();
    expect(
      getEditorialCheckerStaleReason({
        ...base,
        currentAllowListSha256: editorialAllowListSha256(["つ"]),
      })
    ).toBe("ALLOW_LIST_CHANGED");
    expect(
      getEditorialCheckerStaleReason({ ...base, currentDraftId: 43 })
    ).toBe("DRAFT_CHANGED");
    expect(
      getEditorialCheckerStaleReason({ ...base, currentEngineVersion: "next" })
    ).toBe("ENGINE_CHANGED");
  });
});
