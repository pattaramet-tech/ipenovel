import { describe, expect, it } from "vitest";

import { buildNqaPrePublishHygieneGate } from "./hygiene";

describe("NQA pre-publish content hygiene gate", () => {
  it("remediates the row-1744 Patreon/WebNovel tail before publish", () => {
    const content = [
      "บทที่ 81",
      "นี่คือเนื้อเรื่องจริง",
      "Patreon(.)com/Bleam",
      "... ขณะนี้คุณสามารถอ่านล่วงหน้าได้ถึง 100 บทก่อนคนอื่น!",
      "ความคิดเห็น",
      "ความคิดเห็น 14",
      "โหวต",
    ].join("\n");

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "plain_text",
    });

    expect(gate).toMatchObject({
      decision: "READY_FOR_PUBLISH",
      remediationApplied: true,
      sanitizedContent: "บทที่ 81\nนี่คือเนื้อเรื่องจริง",
      residualSignals: [],
    });
    expect(gate.removalReasons).toEqual(
      expect.arrayContaining([
        "PATREON_PROMO",
        "ADVANCE_CHAPTER_PROMO",
        "WEBNOVEL_UI",
      ])
    );
  });

  it("remediates the WebNovel rating/recommendation/comments footer", () => {
    const content = [
      "บทที่ 1",
      "เนื้อเรื่องจริง",
      "4.88",
      "486 โหวต",
      "คุณอาจชอบ",
      "เรื่องแนะนำ",
      "ความคิดเห็น",
      "ส่งความคิดเห็น",
      "หัวข้อ",
      "ตอน",
    ].join("\n");

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "plain_text",
    });

    expect(gate.decision).toBe("READY_FOR_PUBLISH");
    expect(gate.remediationApplied).toBe(true);
    expect(gate.sanitizedContent).toBe("บทที่ 1\nเนื้อเรื่องจริง");
    expect(gate.residualSignals).toEqual([]);
  });

  it("preserves story prefix when an inline translated author note is attached to the same paragraph", () => {
    const content =
      "xxx นับจากนี้ผมตั้งใจจะแก้ไขข้อผิดพลาดทุกอย่างที่ทุกคนช่วยชี้ให้เห็น " +
      "เพราะฉะนั้น หากพบจุดไหนผิดพลาด โปรดบอกผมในช่องความคิดเห็นได้เลย " +
      "นี่คือเป้าหมายประจำสัปดาห์นี้ สโตนมากกว่า 500 ชิ้น สำหรับบทโบนัสแรก " +
      "ขอบคุณมากสำหรับการสนับสนุนจากทุกคน หากต้องการอ่านล่วงหน้ามากกว่า 20 บท " +
      "เข้าไปดู Patreon ของผมได้ที่ Patreon.com/Kamidemond ความคิดเห็น ความคิดเห็น 5 โหวต";

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "plain_text",
    });

    expect(gate.decision).toBe("READY_FOR_PUBLISH");
    expect(gate.remediationApplied).toBe(true);
    expect(gate.sanitizedContent).toBe("xxx");
    expect(gate.removalReasons).toEqual(
      expect.arrayContaining([
        "PATREON_PROMO",
        "AUTHOR_NOTE",
        "ADVANCE_CHAPTER_PROMO",
        "WEBNOVEL_UI",
      ])
    );
  });

  it("blocks instead of deleting a narrative line that merely mentions Patreon", () => {
    const content = [
      "บทที่ 10",
      "เขาหัวเราะแล้วพูดว่า Patreon.com/Kamidemond เป็นชื่อเว็บไซต์ประหลาด",
    ].join("\n");

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "plain_text",
    });

    expect(gate).toMatchObject({
      decision: "BLOCKED",
      remediationApplied: false,
      sanitizedContent: content,
    });
    expect(gate.residualSignals).toContain("PATREON_PROMO");
  });

  it("blocks contaminated HTML rather than risking destructive auto-remediation", () => {
    const content =
      "<p>เนื้อเรื่องจริง</p><p>Patreon.com/Kamidemond</p><p>20 advance chapters</p>";

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "html",
    });

    expect(gate).toMatchObject({
      decision: "BLOCKED",
      remediationApplied: false,
      sanitizedContent: content,
    });
    expect(gate.residualSignals).toEqual(
      expect.arrayContaining(["PATREON_PROMO", "ADVANCE_CHAPTER_PROMO"])
    );
  });

  it("does not alter clean story text or a lone narrative use of the word comments", () => {
    const content =
      "บทที่ 9\nตัวละครอ่านข้อความในความคิดเห็นแล้วเดินออกจากห้อง\nเนื้อเรื่องจบตามปกติ";

    const gate = buildNqaPrePublishHygieneGate({
      content,
      contentFormat: "plain_text",
    });

    expect(gate).toMatchObject({
      decision: "READY_FOR_PUBLISH",
      remediationApplied: false,
      sanitizedContent: content,
      residualSignals: [],
    });
  });
});
