import { describe, expect, it } from "vitest";

import type { NqaDocumentParagraph } from "./contracts";
import { sanitizeNqaChapterTail } from "./sanitizer";

function paragraphs(lines: string[]): NqaDocumentParagraph[] {
  let cursor = 1;
  return lines.map(text => {
    const startIndex = cursor;
    const endIndex = startIndex + text.length;
    cursor = endIndex + 1;
    return { text, startIndex, endIndex, tabId: "t.0" };
  });
}

describe("NQA chapter tail sanitizer", () => {
  it("trims the row-1744-style Patreon and copied WebNovel UI tail", () => {
    const input = paragraphs([
      "บทที่ 81 กิจกรรมส่งเสริมการขาย",
      "โอโรจิมารุเริ่มเล่าเหตุการณ์ที่เกิดขึ้น",
      "นี่คือย่อหน้าสุดท้ายของเนื้อเรื่องจริง",
      "Patreon(.)com/Bleam",
      "... ขณะนี้คุณสามารถอ่านล่วงหน้าได้ถึง 100 บทก่อนคนอื่น!",
      "ความคิดเห็น",
      "ความคิดเห็น 14",
      "โหวต",
      "จบตอน",
    ]);

    const result = sanitizeNqaChapterTail(input);

    expect(result.paragraphs.map(item => item.text)).toEqual([
      "บทที่ 81 กิจกรรมส่งเสริมการขาย",
      "โอโรจิมารุเริ่มเล่าเหตุการณ์ที่เกิดขึ้น",
      "นี่คือย่อหน้าสุดท้ายของเนื้อเรื่องจริง",
    ]);
    expect(result.removedParagraphCount).toBe(6);
    expect(result.cutParagraphIndex).toBe(3);
  });

  it("backs up over a thanks-for-reading lead-in before a promo anchor", () => {
    const input = paragraphs([
      "บทที่ 82",
      "เนื้อเรื่องจริง",
      "ขอบคุณที่อ่านค่ะ!",
      "Patreon(.)com/Bleam",
      "ความคิดเห็น",
      "โหวต",
      "จบตอน",
    ]);

    const result = sanitizeNqaChapterTail(input);

    expect(result.paragraphs.map(item => item.text)).toEqual([
      "บทที่ 82",
      "เนื้อเรื่องจริง",
    ]);
  });

  it("recognizes observed English advance-chapter Patreon variants", () => {
    for (const tail of [
      "For 20 advance chapters: patreon.com/michaeltranslates",
      "I will post some extra Chapters in Patreon, you can check it out. >> patreon.com/TitoVillar",
      "Visit my Patreon/belamy20",
    ]) {
      const result = sanitizeNqaChapterTail(
        paragraphs(["บท 10: 9. Test", "Actual story ending.", tail])
      );
      expect(result.paragraphs.map(item => item.text)).toEqual([
        "บท 10: 9. Test",
        "Actual story ending.",
      ]);
    }
  });

  it("trims a copied WebNovel recommendation/comments footer including rating and vote prefix", () => {
    const input = paragraphs([
      "บทที่ 1 คู่ต่อสู้ในตำนาน",
      "นี่คือย่อหน้าสุดท้ายของเนื้อเรื่องจริง",
      "4.88",
      "486 โหวต",
      "คุณอาจชอบ",
      "อีกเรื่องที่ระบบแนะนำ",
      "ความคิดเห็น",
      "ส่งความคิดเห็น",
      "หัวข้อ",
      "ตอน",
    ]);

    const result = sanitizeNqaChapterTail(input);

    expect(result.paragraphs.map(item => item.text)).toEqual([
      "บทที่ 1 คู่ต่อสู้ในตำนาน",
      "นี่คือย่อหน้าสุดท้ายของเนื้อเรื่องจริง",
    ]);
    expect(result.cutParagraphIndex).toBe(2);
  });

  it("trims a copied comments/vote UI cluster even without a Patreon line", () => {
    const result = sanitizeNqaChapterTail(
      paragraphs([
        "บทที่ 9",
        "เนื้อเรื่องจริง",
        "ความคิดเห็น",
        "ความคิดเห็น 12",
        "โหวต",
        "จบตอน",
      ])
    );

    expect(result.paragraphs.map(item => item.text)).toEqual([
      "บทที่ 9",
      "เนื้อเรื่องจริง",
    ]);
  });

  it("does not remove ordinary story text with similar words unless a validated tail block exists", () => {
    const lines = [
      "บทที่ 9",
      "ตัวละครพูดถึงความคิดเห็นของเขาเกี่ยวกับภารกิจ",
      "เขาบอกว่า Patreon เป็นชื่อเล่นประหลาดที่เพื่อนตั้งให้",
      ...Array.from({ length: 25 }, (_, index) => "เนื้อเรื่องต่อ " + index),
    ];
    const input = paragraphs(lines);

    const result = sanitizeNqaChapterTail(input);

    expect(result.removedParagraphCount).toBe(0);
    expect(result.paragraphs).toEqual(input);
  });
});
