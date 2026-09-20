import { describe, expect, it } from "vitest";
import {
  analyzeEditorialEpisodeDraftBatch,
  buildEditorialEpisodeDraftPlan,
  editorialApprovalPayloadSha256,
  editorialEpisodeStagePayloadSha256,
  editorialEpisodeStagePayloadSha256V2,
  editorialEpisodeStateSha256,
  editorialEpisodeStateSha256V2,
  editorialQcEvidenceSha256,
  normalizeEditorialEpisodeNumber,
  parseEditorialEpisodeHeading,
} from "./editorialApproval.domain";

function input(overrides: Record<string, unknown> = {}) {
  return {
    workItemType: "new_episode" as const,
    episodeNumber: "12",
    episodeTitle: null,
    tabs: [
      {
        sourceTabId: "tab-12",
        tabOrder: 0,
        title: "ตอนที่ 12",
        chapterNumber: "12",
        chapterTitle: "ชื่อบท",
        paragraphs: [
          { paragraphOrder: 0, text: "บทที่ 12 ชื่อบท" },
          { paragraphOrder: 1, text: "ย่อหน้าแรกของเนื้อหา" },
          { paragraphOrder: 2, text: "ย่อหน้าที่สอง" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("Editorial approval/staging domain", () => {
  it("normalizes Thai digits and common range separators", () => {
    expect(normalizeEditorialEpisodeNumber(" ๕๘๑—๖๑๙ ")).toBe("581 - 619");
    expect(normalizeEditorialEpisodeNumber("12-15")).toBe("12 - 15");
  });

  it("parses Production-style episode/chapter title prefixes", () => {
    expect(parseEditorialEpisodeHeading("บทที่ ๑๒ ชื่อบท")).toEqual({
      episodeNumber: "12",
      titleRemainder: "ชื่อบท",
    });
    expect(parseEditorialEpisodeHeading("EP. 42: The Answer")).toEqual({
      episodeNumber: "42",
      titleRemainder: "The Answer",
    });
    expect(parseEditorialEpisodeHeading("#7 เปิดฉาก")).toEqual({
      episodeNumber: "7",
      titleRemainder: "เปิดฉาก",
    });
  });

  it("stages one NEW_EPISODE tab using first non-empty line as title and remaining paragraphs as content", () => {
    const plan = buildEditorialEpisodeDraftPlan(input());
    expect(plan).toMatchObject({
      episodeNumber: "12",
      title: "บทที่ 12 ชื่อบท",
      content: "ย่อหน้าแรกของเนื้อหา\n\nย่อหน้าที่สอง",
      contentFormat: "plain_text",
      wordCount: 2,
      sourceTabId: "tab-12",
      sourceTitleLine: "บทที่ 12 ชื่อบท",
    });
    expect(plan.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("prefers explicit intake episode title while preserving legacy first-line content split", () => {
    const plan = buildEditorialEpisodeDraftPlan(
      input({ episodeTitle: "ชื่อจาก Intake" })
    );
    expect(plan.title).toBe("ชื่อจาก Intake");
    expect(plan.content).not.toContain("บทที่ 12 ชื่อบท");
  });

  it("fails closed when heading episode number conflicts with intake metadata", () => {
    expect(() =>
      buildEditorialEpisodeDraftPlan(input({ episodeNumber: "13" }))
    ).toThrow("does not match work item episode number");
  });

  it("fails closed for NEW_STORY because it has no canonical Episode identity yet", () => {
    expect(() =>
      buildEditorialEpisodeDraftPlan(
        input({ workItemType: "new_story", episodeNumber: null })
      )
    ).toThrow("NEW_EPISODE");
  });

  it("fails closed for a multi-tab single-episode work item instead of guessing which tab to publish", () => {
    const base = input();
    expect(() =>
      buildEditorialEpisodeDraftPlan({
        ...base,
        tabs: [
          ...base.tabs,
          {
            ...base.tabs[0],
            sourceTabId: "tab-13",
            tabOrder: 1,
            title: "ตอนที่ 13",
            chapterNumber: "13",
          },
        ],
      })
    ).toThrow("exactly one Draft tab");
  });

  it("maps 036-085 deterministically to 50 Episode plans and preserves zero padding", () => {
    const tabs = Array.from({ length: 50 }, (_, index) => {
      const number = 36 + index;
      return {
        sourceTabId: `tab-${number}`,
        tabOrder: index,
        title: `แท็บ ${index + 1}`,
        chapterNumber: String(number),
        chapterTitle: `ชื่อบท ${number}`,
        paragraphs: [
          { paragraphOrder: 0, text: `บทที่ ${number} ชื่อบท ${number}` },
          { paragraphOrder: 1, text: `เนื้อหาตอน ${number} ${"ก".repeat(500)}` },
        ],
      };
    });
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "036 - 085",
      episodeTitle: null,
      tabs,
    });
    expect(batch.ready).toBe(true);
    expect(batch.mode).toBe("range");
    expect(batch.items).toHaveLength(50);
    expect(batch.items[0].episodeNumber).toBe("036");
    expect(batch.items[49].episodeNumber).toBe("085");
    expect(batch.blockers).toEqual([]);
  });

  it("maps out-of-order tabs by detected Episode number and reports a warning", () => {
    const base = Array.from({ length: 3 }, (_, index) => {
      const number = 36 + index;
      return {
        sourceTabId: `tab-${number}`,
        tabOrder: index,
        title: `แท็บ ${index + 1}`,
        chapterNumber: String(number),
        chapterTitle: null,
        paragraphs: [
          { paragraphOrder: 0, text: `บทที่ ${number} ชื่อบท` },
          { paragraphOrder: 1, text: `เนื้อหา ${"ข".repeat(500)}` },
        ],
      };
    });
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "036-038",
      episodeTitle: null,
      tabs: [base[1], base[0], base[2]].map((tab, tabOrder) => ({
        ...tab,
        tabOrder,
      })),
    });
    expect(batch.ready).toBe(true);
    expect(batch.items.map(item => item.episodeNumber)).toEqual([
      "036",
      "037",
      "038",
    ]);
    expect(batch.anomalies.map(item => item.code)).toContain(
      "TAB_NUMBER_OUT_OF_ORDER"
    );
  });

  it("fails closed for missing, duplicate, empty, or count-mismatched range tabs while surfacing anomalies", () => {
    const tabs = [
      {
        sourceTabId: "tab-36",
        tabOrder: 0,
        title: "แท็บ 1",
        chapterNumber: "36",
        chapterTitle: null,
        paragraphs: [
          { paragraphOrder: 0, text: "บทที่ 36 ชื่อบท" },
          { paragraphOrder: 1, text: "เนื้อหา " + "ค".repeat(500) },
        ],
      },
      {
        sourceTabId: "tab-36-dup",
        tabOrder: 1,
        title: "แท็บ 2",
        chapterNumber: "36",
        chapterTitle: null,
        paragraphs: [
          { paragraphOrder: 0, text: "บทที่ 36 ซ้ำ" },
          { paragraphOrder: 1, text: "เนื้อหา " + "ง".repeat(500) },
        ],
      },
      {
        sourceTabId: "tab-empty",
        tabOrder: 2,
        title: "แท็บ 3",
        chapterNumber: "38",
        chapterTitle: null,
        paragraphs: [],
      },
    ];
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "036-039",
      episodeTitle: null,
      tabs,
    });
    expect(batch.ready).toBe(false);
    expect(batch.blockers.map(item => item.code)).toEqual(
      expect.arrayContaining([
        "COUNT_MISMATCH",
        "TAB_NUMBER_DUPLICATE",
        "TAB_EMPTY",
        "EXPECTED_EPISODE_MISSING",
      ])
    );
  });

  it("excludes deterministic front matter before 001-035 while staging exactly 35 Episodes", () => {
    const episodeTabs = Array.from({ length: 35 }, (_, index) => {
      const number = index + 1;
      return {
        sourceTabId: `tab-${number}`,
        tabOrder: index + 1,
        title: `แท็บ ${index + 2}`,
        chapterNumber: String(number),
        chapterTitle: null,
        paragraphs: [
          { paragraphOrder: 0, text: `บทที่ ${number} ชื่อบท ${number}` },
          { paragraphOrder: 1, text: `เนื้อหา ${"ก".repeat(500)}` },
        ],
      };
    });
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "001 - 035",
      episodeTitle: null,
      tabs: [
        {
          sourceTabId: "front-intro",
          tabOrder: 0,
          title: "แท็บ 1",
          chapterNumber: null,
          chapterTitle: null,
          paragraphs: [
            { paragraphOrder: 0, text: "บทนำ" },
            { paragraphOrder: 1, text: "ข้อความบทนำ" },
          ],
        },
        ...episodeTabs,
      ],
    });
    expect(batch.ready).toBe(true);
    expect(batch.items).toHaveLength(35);
    expect(batch.items[0]).toMatchObject({ episodeNumber: "001", sourceTabId: "tab-1" });
    expect(batch.items[34]).toMatchObject({ episodeNumber: "035", sourceTabId: "tab-35" });
    expect(batch.excludedTabs).toEqual([
      expect.objectContaining({ sourceTabId: "front-intro", kind: "front_matter", label: "บทนำ" }),
    ]);
    expect(batch.blockers).toEqual([]);
  });

  it("supports deterministic front matter after a range without positional guessing", () => {
    const tabs = [1, 2].map((number, index) => ({
      sourceTabId: `tab-${number}`,
      tabOrder: index,
      title: `แท็บ ${index + 1}`,
      chapterNumber: String(number),
      chapterTitle: null,
      paragraphs: [
        { paragraphOrder: 0, text: `ตอนที่ ${number} ชื่อบท` },
        { paragraphOrder: 1, text: `เนื้อหา ${"ข".repeat(500)}` },
      ],
    }));
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "001-002",
      episodeTitle: null,
      tabs: [
        ...tabs,
        {
          sourceTabId: "front-prologue-after",
          tabOrder: 2,
          title: "Prologue",
          chapterNumber: null,
          chapterTitle: null,
          paragraphs: [{ paragraphOrder: 0, text: "Prologue" }],
        },
      ],
    });
    expect(batch.ready).toBe(true);
    expect(batch.items.map(item => item.episodeNumber)).toEqual(["001", "002"]);
    expect(batch.excludedTabs).toEqual([
      expect.objectContaining({ sourceTabId: "front-prologue-after", label: "Prologue" }),
    ]);
  });

  it("fails closed for an unknown unnumbered tab even when the Episode range itself is complete", () => {
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "001-002",
      episodeTitle: null,
      tabs: [
        {
          sourceTabId: "unknown",
          tabOrder: 0,
          title: "หมายเหตุผู้เขียน",
          chapterNumber: null,
          chapterTitle: null,
          paragraphs: [{ paragraphOrder: 0, text: "หมายเหตุพิเศษ" }],
        },
        ...[1, 2].map((number, index) => ({
          sourceTabId: `tab-${number}`,
          tabOrder: index + 1,
          title: `แท็บ ${index + 2}`,
          chapterNumber: String(number),
          chapterTitle: null,
          paragraphs: [
            { paragraphOrder: 0, text: `บทที่ ${number} ชื่อบท` },
            { paragraphOrder: 1, text: `เนื้อหา ${"ค".repeat(500)}` },
          ],
        })),
      ],
    });
    expect(batch.ready).toBe(false);
    expect(batch.excludedTabs).toEqual([]);
    expect(batch.blockers.map(item => item.code)).toEqual(
      expect.arrayContaining(["TAB_NUMBER_MISSING", "COUNT_MISMATCH"])
    );
  });

  it("excludes multiple explicitly recognized front-matter tabs and never turns them into Episodes", () => {
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "001-001",
      episodeTitle: null,
      tabs: [
        {
          sourceTabId: "preface",
          tabOrder: 0,
          title: "คำนำ",
          chapterNumber: null,
          chapterTitle: null,
          paragraphs: [{ paragraphOrder: 0, text: "คำนำ" }],
        },
        {
          sourceTabId: "intro",
          tabOrder: 1,
          title: "Introduction",
          chapterNumber: null,
          chapterTitle: null,
          paragraphs: [{ paragraphOrder: 0, text: "Introduction" }],
        },
        {
          sourceTabId: "tab-1",
          tabOrder: 2,
          title: "แท็บ 3",
          chapterNumber: "1",
          chapterTitle: null,
          paragraphs: [
            { paragraphOrder: 0, text: "บทที่ 1 ชื่อบท" },
            { paragraphOrder: 1, text: `เนื้อหา ${"ง".repeat(500)}` },
          ],
        },
      ],
    });
    expect(batch.ready).toBe(true);
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].episodeNumber).toBe("001");
    expect(batch.excludedTabs.map(tab => tab.sourceTabId)).toEqual(["preface", "intro"]);
  });
  it("reports unusually short range content as a warning without blocking an otherwise exact mapping", () => {
    const batch = analyzeEditorialEpisodeDraftBatch({
      workItemType: "new_episode",
      episodeNumber: "036-038",
      episodeTitle: null,
      tabs: [36, 37, 38].map((number, index) => ({
        sourceTabId: `tab-${number}`,
        tabOrder: index,
        title: `แท็บ ${index + 1}`,
        chapterNumber: String(number),
        chapterTitle: null,
        paragraphs: [
          { paragraphOrder: 0, text: `บทที่ ${number} ชื่อบท` },
          {
            paragraphOrder: 1,
            text:
              number === 38
                ? "สั้น"
                : `เนื้อหา ${"จ".repeat(1000)}`,
          },
        ],
      })),
    });
    expect(batch.ready).toBe(true);
    expect(batch.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TAB_CONTENT_SHORT",
          severity: "warning",
          episodeNumber: "038",
        }),
      ])
    );
  });

  it("requires body content after the title line", () => {
    const base = input();
    expect(() =>
      buildEditorialEpisodeDraftPlan({
        ...base,
        tabs: [
          {
            ...base.tabs[0],
            paragraphs: [{ paragraphOrder: 0, text: "บทที่ 12 ชื่อบท" }],
          },
        ],
      })
    ).toThrow("requires content");
  });

  it("hashes QC evidence independent of finding order but sensitive to disposition/version", () => {
    const a = editorialQcEvidenceSha256({
      runId: 9,
      draftId: 8,
      engineVersion: "checker-v1",
      allowListSha256: "a".repeat(64),
      findings: [
        {
          findingKey: "b".repeat(64),
          disposition: "ignored",
          resolutionVersion: 2,
        },
        {
          findingKey: "a".repeat(64),
          disposition: "accepted",
          resolutionVersion: 1,
        },
      ],
    });
    const b = editorialQcEvidenceSha256({
      runId: 9,
      draftId: 8,
      engineVersion: "checker-v1",
      allowListSha256: "A".repeat(64),
      findings: [
        {
          findingKey: "a".repeat(64),
          disposition: "accepted",
          resolutionVersion: 1,
        },
        {
          findingKey: "b".repeat(64),
          disposition: "ignored",
          resolutionVersion: 2,
        },
      ],
    });
    expect(a).toBe(b);
    expect(a).not.toBe(
      editorialQcEvidenceSha256({
        runId: 9,
        draftId: 8,
        engineVersion: "checker-v1",
        allowListSha256: "a".repeat(64),
        findings: [
          {
            findingKey: "a".repeat(64),
            disposition: "open",
            resolutionVersion: 2,
          },
          {
            findingKey: "b".repeat(64),
            disposition: "ignored",
            resolutionVersion: 2,
          },
        ],
      })
    );
  });

  it("binds approval and stage payload hashes to the exact draft/QC/episode state", () => {
    const plan = buildEditorialEpisodeDraftPlan(input());
    const approval = editorialApprovalPayloadSha256({
      workItemId: 1,
      draftId: 2,
      draftVersion: 3,
      draftSha256: "d".repeat(64),
      checkerRunId: 4,
      qcEvidenceSha256: "q".repeat(64).replace(/q/g, "a"),
    });
    expect(approval).toMatch(/^[a-f0-9]{64}$/);

    const stage = editorialEpisodeStagePayloadSha256({
      workItemId: 1,
      approvalId: 5,
      draftId: 2,
      draftSha256: "d".repeat(64),
      qcEvidenceSha256: "a".repeat(64),
      novelId: 6,
      plan,
    });
    expect(stage).toMatch(/^[a-f0-9]{64}$/);

    const state = editorialEpisodeStateSha256({
      novelId: 6,
      episodeNumber: plan.episodeNumber,
      title: plan.title,
      content: plan.content,
      contentFormat: plan.contentFormat,
      wordCount: plan.wordCount,
      isPublished: false,
    });
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(
      editorialEpisodeStateSha256({
        novelId: 6,
        episodeNumber: plan.episodeNumber,
        title: plan.title,
        content: plan.content + " เปลี่ยน",
        contentFormat: plan.contentFormat,
        wordCount: plan.wordCount,
        isPublished: false,
      })
    ).not.toBe(state);
  });

  it("preserves the historical v1 Episode state hash algorithm", () => {
    expect(editorialEpisodeStateSha256({
      novelId: 6,
      episodeNumber: "10",
      title: "Title",
      content: "Body",
      contentFormat: "plain_text",
      wordCount: 1,
      isPublished: false,
    })).toBe("bbfb407ee4ee3cce0063d384c4f25dd9314a81d69662a0661134b9ff19653d28");
  });

  it("binds v2 Episode state hash to saleMode", () => {
    const base = { novelId: 6, episodeNumber: "10", title: "T", content: "B", contentFormat: "plain_text", wordCount: 1, isPublished: false, price: "10.00", isFree: false } as const;
    expect(editorialEpisodeStateSha256V2({ ...base, saleMode: "chapter" })).not.toBe(
      editorialEpisodeStateSha256V2({ ...base, saleMode: "package" })
    );
  });

  it("binds v2 Episode state hash to normalized price", () => {
    const base = { novelId: 6, episodeNumber: "10", title: "T", content: "B", contentFormat: "plain_text", wordCount: 1, isPublished: false, saleMode: "chapter" as const, isFree: false };
    expect(editorialEpisodeStateSha256V2({ ...base, price: "10.00" })).not.toBe(
      editorialEpisodeStateSha256V2({ ...base, price: "11.00" })
    );
  });

  it("binds v2 Episode state hash to isFree", () => {
    const base = { novelId: 6, episodeNumber: "10", title: "T", content: "B", contentFormat: "plain_text", wordCount: 1, isPublished: false, saleMode: "chapter" as const, price: "0.00" };
    expect(editorialEpisodeStateSha256V2({ ...base, isFree: true })).not.toBe(
      editorialEpisodeStateSha256V2({ ...base, isFree: false })
    );
  });

  it("binds v2 stage payload hash to sale metadata", () => {
    const plan = buildEditorialEpisodeDraftPlan(input());
    const base = { workItemId: 1, approvalId: 2, draftId: 3, draftSha256: "d".repeat(64), qcEvidenceSha256: "a".repeat(64), novelId: 4, plan, saleMode: "chapter" as const, price: "10.00", isFree: false };
    const hash = editorialEpisodeStagePayloadSha256V2(base);
    expect(editorialEpisodeStagePayloadSha256V2({ ...base, price: "11.00" })).not.toBe(hash);
    expect(editorialEpisodeStagePayloadSha256V2({ ...base, saleMode: "package" })).not.toBe(hash);
    expect(editorialEpisodeStagePayloadSha256V2({ ...base, isFree: true })).not.toBe(hash);
  });
});
