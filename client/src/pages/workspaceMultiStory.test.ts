import { describe, expect, it } from "vitest";

import {
  createStoryUiState,
  derivePackStatus,
  filterPacksByQuery,
  resolveStoryUiState,
  sortPacksByEpisode,
  storyKeyFor,
  storyOverallStatus,
  STORY_PACK_STATUS_LABEL,
  STORY_OVERALL_LABEL,
  summarizeStoryPacks,
  updateStoryUiState,
} from "./workspaceMultiStory";

describe("workspaceMultiStory — per-story UI state", () => {
  it("defaults a missing story to a clean editor state and never mutates the input", () => {
    const states: Record<string, ReturnType<typeof createStoryUiState>> = {};
    const resolved = resolveStoryUiState(states, "wn:1");
    expect(resolved).toEqual({
      packWorkItemId: null,
      chapterSourceTabId: null,
      activeTab: "editor",
      issuesOnly: false,
    });
    expect(states).toEqual({});
  });

  it("updates one story in isolation and keeps other stories untouched", () => {
    const initial = updateStoryUiState({}, "wn:1", { packWorkItemId: 11 });
    const next = updateStoryUiState(initial, "wn:2", { packWorkItemId: 22, activeTab: "stage" });
    expect(next["wn:1"].packWorkItemId).toBe(11);
    expect(next["wn:1"].activeTab).toBe("editor");
    expect(next["wn:2"].packWorkItemId).toBe(22);
    expect(next["wn:2"].activeTab).toBe("stage");
    // Switching back to story 1 restores its remembered selection.
    expect(resolveStoryUiState(next, "wn:1").packWorkItemId).toBe(11);
    expect(initial["wn:2"]).toBeUndefined();
  });

  it("derives a stable key per story from workspaceNovelId with a novel fallback", () => {
    expect(storyKeyFor(101, 7)).toBe("wn:101");
    expect(storyKeyFor(null, 7)).toBe("novel:7");
    expect(storyKeyFor(undefined, undefined)).toBe("story:?");
  });
});

describe("workspaceMultiStory — evidence rollup", () => {
  it("classifies pack status from the durable evidence flags", () => {
    expect(derivePackStatus(null)).toBe("not_checked");
    expect(derivePackStatus({ available: false, checkerRan: true })).toBe("anomalous");
    expect(derivePackStatus({ checkerRan: true, checker: true, published: true })).toBe("published");
    expect(derivePackStatus({ checkerRan: true, checker: true })).toBe("passed");
    expect(derivePackStatus({ checkerRan: true, checker: false })).toBe("needs_fix");
    expect(derivePackStatus({})).toBe("not_checked");
    expect(STORY_PACK_STATUS_LABEL.needs_fix).toBe("ต้องแก้");
  });

  it("summarizes a story's packs into the four operator counters", () => {
    const summary = summarizeStoryPacks([
      { evidence: { checkerRan: true, checker: true } },
      { evidence: { checkerRan: true, checker: true, published: true } },
      { evidence: { checkerRan: true, checker: false } },
      { evidence: { available: false } },
      { evidence: null },
    ]);
    expect(summary).toEqual({
      total: 5,
      published: 1,
      passed: 1,
      needsFix: 1,
      anomalous: 1,
      notChecked: 1,
    });
    expect(storyOverallStatus(summary)).toBe("anomalous");
  });

  it("rolls the story up as published only when every pack is published", () => {
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { published: true, checker: true } }]))).toBe("published");
    expect(STORY_OVERALL_LABEL.published).toBe("ลงแล้วทั้งหมด");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checker: true } }, { evidence: null }]))).toBe("in_progress");
    expect(storyOverallStatus(summarizeStoryPacks([]))).toBe("in_progress");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checker: true } }]))).toBe("passed");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checkerRan: true, checker: false } }]))).toBe("needs_fix");
  });
});

describe("workspaceMultiStory — pack list helpers", () => {
  it("filters packs by episode number, title, and note (Thai, trimmed)", () => {
    const cards = [
      { episodeNumber: "001-040", episodeTitle: "แพ็กแรก", note: null },
      { episodeNumber: "041-090", episodeTitle: null, note: "รอลง" },
    ];
    expect(filterPacksByQuery(cards, "").length).toBe(2);
    expect(filterPacksByQuery(cards, "  ")).toHaveLength(2);
    expect(filterPacksByQuery(cards, "041")).toEqual([cards[1]]);
    expect(filterPacksByQuery(cards, "แพ็กแรก")).toEqual([cards[0]]);
    expect(filterPacksByQuery(cards, "รอลง")).toEqual([cards[1]]);
    expect(filterPacksByQuery(cards, "ไม่มีจริง")).toEqual([]);
  });

  it("sorts packs by episode range numerically for the story", () => {
    const sorted = sortPacksByEpisode([
      { episodeNumber: "091-140" },
      { episodeNumber: "001-040" },
      { episodeNumber: "041-090" },
    ]);
    expect(sorted.map((card) => card.episodeNumber)).toEqual(["001-040", "041-090", "091-140"]);
  });
});
