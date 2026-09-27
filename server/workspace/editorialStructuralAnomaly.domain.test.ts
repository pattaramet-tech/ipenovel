import { describe, expect, it } from "vitest";

import {
  editorialDuplicateSimilarity,
  evaluateEditorialStructuralAnomalies,
  parseEditorialEpisodeRange,
  type EditorialStructuralTabInput,
} from "./editorialStructuralAnomaly.domain";

function tab(input: {
  sourceTabId: string;
  tabOrder: number;
  chapterNumber?: string | null;
  chapterTitle?: string | null;
  tabTitle?: string;
  paragraphs: string[];
}): EditorialStructuralTabInput {
  return {
    sourceTabId: input.sourceTabId,
    tabOrder: input.tabOrder,
    tabTitle:
      input.tabTitle ??
      (input.chapterNumber
        ? `บทที่ ${input.chapterNumber}${input.chapterTitle ? ` ${input.chapterTitle}` : ""}`
        : `แท็บ ${input.tabOrder + 1}`),
    chapterNumber: input.chapterNumber ?? null,
    chapterTitle: input.chapterTitle ?? null,
    paragraphs: input.paragraphs.map((text, index) => ({
      paragraphKey: `${input.sourceTabId}:p:${index + 1}`,
      paragraphOrder: index + 1,
      sourceParagraphIndex: index + 1,
      text,
    })),
  };
}

describe("Editorial Structural Anomaly domain", () => {
  it("parses episode ranges with zero padding", () => {
    expect(parseEditorialEpisodeRange("046-100")).toEqual({
      start: 46,
      end: 100,
      count: 55,
    });
    expect(parseEditorialEpisodeRange("001 — 040")).toEqual({
      start: 1,
      end: 40,
      count: 40,
    });
  });

  it("detects five end-only tabs and the exact missing chapter numbers in a 046-100 pack", () => {
    const missing = new Set([78, 82, 83, 87, 88]);
    const tabs: EditorialStructuralTabInput[] = [];
    for (let chapter = 46; chapter <= 100; chapter += 1) {
      const tabOrder = chapter - 46;
      tabs.push(
        missing.has(chapter)
          ? tab({
              sourceTabId: `tab-${tabOrder + 1}`,
              tabOrder,
              paragraphs: ["จบตอน"],
            })
          : tab({
              sourceTabId: `tab-${tabOrder + 1}`,
              tabOrder,
              chapterNumber: String(chapter),
              paragraphs: [
                `บทที่ ${chapter}`,
                `เนื้อเรื่องบทที่ ${chapter} มีเหตุการณ์ต่อเนื่องและข้อความจริง`,
                "จบตอน",
              ],
            })
      );
    }

    const result = evaluateEditorialStructuralAnomalies({
      tabs,
      episodeNumber: "046-100",
    });

    expect(result.summary.tabCount).toBe(55);
    expect(result.summary.expectedTabCount).toBe(55);
    expect(result.summary.missingChapterNumbers).toEqual([78, 82, 83, 87, 88]);
    expect(result.summary.counts.end_only_tab).toBe(5);
    expect(result.summary.counts.missing_expected_chapter).toBe(5);
    expect(result.summary.counts.tab_count_mismatch).toBe(0);
  });

  it("distinguishes an originally empty tab from a source tab that literally contains only จบตอน", () => {
    const generatedEndOnly = tab({
      sourceTabId: "empty",
      tabOrder: 0,
      paragraphs: ["จบตอน"],
    });
    generatedEndOnly.paragraphs[0]!.sourceParagraphIndex = 0;
    const sourceEndOnly = tab({
      sourceTabId: "end-only",
      tabOrder: 1,
      paragraphs: ["จบตอน"],
    });
    const result = evaluateEditorialStructuralAnomalies({
      tabs: [generatedEndOnly, sourceEndOnly],
    });
    expect(result.summary.counts.empty_tab).toBe(1);
    expect(result.summary.counts.end_only_tab).toBe(1);
  });

  it("detects heading-only and source-note-only tabs", () => {
    const result = evaluateEditorialStructuralAnomalies({
      episodeNumber: "13-14",
      tabs: [
        tab({
          sourceTabId: "note",
          tabOrder: 0,
          chapterNumber: "13",
          chapterTitle: "หมายเหตุต้นฉบับ",
          paragraphs: ["บทที่ 13 หมายเหตุต้นฉบับ", "จบตอน"],
        }),
        tab({
          sourceTabId: "heading",
          tabOrder: 1,
          chapterNumber: "14",
          paragraphs: ["บทที่ 14", "จบตอน"],
        }),
      ],
    });
    expect(result.summary.counts.source_note_only).toBe(1);
    expect(result.summary.counts.heading_only_tab).toBe(1);
    expect(
      result.anomalies.find(row => row.anomalyType === "source_note_only")
        ?.message
    ).toContain("หมายเหตุจากต้นฉบับ");
  });

  it("detects 304/305-style near-identical chapter bodies", () => {
    const shared =
      "เดิมทีเดรคคิดว่าคุโรกาเนะ อิตารุมาเพียงเพื่อพาอัสคารีกับทาทาระ ยูอิมาเท่านั้น แต่หลังตกลงทุกอย่างเรียบร้อย อีกฝ่ายกลับยังไม่รีบจากไป ชิโนมิยะ คุโรกาเนะเห็นว่าเขามีเรื่องจะพูด จึงถามถึงข่าวก่อนหน้านี้ ".repeat(
        8
      );
    const result = evaluateEditorialStructuralAnomalies({
      episodeNumber: "301-350",
      tabs: [
        tab({
          sourceTabId: "304",
          tabOrder: 3,
          chapterNumber: "304",
          paragraphs: ["บทที่ 304", shared + "อาการของชิซึกุหนักไหม", "จบตอน"],
        }),
        tab({
          sourceTabId: "305",
          tabOrder: 4,
          chapterNumber: "305",
          paragraphs: ["บทที่ 305", shared + "อาการของชิซึกุเป็นอย่างไร", "จบตอน"],
        }),
      ],
    });
    expect(
      result.anomalies.some(
        row =>
          row.anomalyType === "duplicate_content_near" &&
          row.details.leftChapterNumber === "304" &&
          row.details.rightChapterNumber === "305"
      )
    ).toBe(true);
  });

  it("detects contained duplicates like 366/367 even when one chapter has substantial extra text", () => {
    const shared =
      "เดรคยืนยันอีกครั้งว่าตนขาดฝีปากอันยอดเยี่ยม หลังจัดการซูซาคุ เดรคก็กลับไปข้างสเตลลา ทั้งสเตลลากับคางุระต่างเอาชนะคู่ต่อสู้ของตนแล้ว พลังควบคุมกระดูกถูกพลังมังกรบดขยี้ ".repeat(
        10
      );
    const extra =
      "จากนั้นเรื่องราวดำเนินต่อไปยังเหตุการณ์อีกช่วงหนึ่งซึ่งมีรายละเอียดใหม่จำนวนมาก ".repeat(
        14
      );
    const similarity = editorialDuplicateSimilarity(shared, shared + extra);
    expect(similarity.containment).toBeGreaterThanOrEqual(0.95);

    const result = evaluateEditorialStructuralAnomalies({
      tabs: [
        tab({
          sourceTabId: "366",
          tabOrder: 15,
          chapterNumber: "366",
          paragraphs: ["บทที่ 366", shared, "จบตอน"],
        }),
        tab({
          sourceTabId: "367",
          tabOrder: 16,
          chapterNumber: "367",
          paragraphs: ["บทที่ 367", shared + extra, "จบตอน"],
        }),
      ],
      episodeNumber: "351-400",
    });
    expect(
      result.anomalies.some(
        row =>
          row.anomalyType === "duplicate_content_near" &&
          Number(row.details.containment) >= 0.95
      )
    ).toBe(true);
  });

  it("keeps ordinary distinct chapters out of duplicate warnings", () => {
    const a =
      "ตัวละครเดินทางเข้าสู่เมืองหลวงและเริ่มการแข่งขันกับเหล่าจอมเวท ".repeat(12);
    const b =
      "กองเรือออกสู่ทะเลพร้อมเผชิญพายุและค้นหาเกาะลึกลับแห่งใหม่ ".repeat(12);
    const result = evaluateEditorialStructuralAnomalies({
      tabs: [
        tab({
          sourceTabId: "a",
          tabOrder: 0,
          chapterNumber: "1",
          paragraphs: ["บทที่ 1", a, "จบตอน"],
        }),
        tab({
          sourceTabId: "b",
          tabOrder: 1,
          chapterNumber: "2",
          paragraphs: ["บทที่ 2", b, "จบตอน"],
        }),
      ],
      episodeNumber: "1-2",
    });
    expect(
      result.anomalies.filter(row =>
        row.anomalyType.startsWith("duplicate_content")
      )
    ).toHaveLength(0);
  });
});
