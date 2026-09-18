import { describe, expect, it } from "vitest";
import {
  buildEditorialEpisodeDraftPlan,
  editorialApprovalPayloadSha256,
  editorialEpisodeStagePayloadSha256,
  editorialEpisodeStateSha256,
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

  it("fails closed for a multi-tab NEW_EPISODE draft instead of guessing which tab to publish", () => {
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
});
