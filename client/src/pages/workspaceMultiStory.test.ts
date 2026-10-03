import { describe, expect, it } from "vitest";

import {
  createStoryUiState,
  derivePackStatus,
  editorDraftBelongsToSelectedPack,
  filterPacksByQuery,
  groupStoriesByNovel,
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

describe("workspaceMultiStory — story grouping covers every story (IPE-062R3 P2-A)", () => {
  it("keeps a story with packs visible", () => {
    const groups = groupStoriesByNovel(
      [{ id: 1, workspaceNovelId: 11, novel: { id: 7, title: "มีแพ็ก" } }],
      [{ workspaceNovel: { id: 11 }, novel: { id: 7, title: "มีแพ็ก" } }]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(1);
    expect(groups[0].workspaceNovelId).toBe(11);
  });

  it("shows a bound novel with zero packs instead of dropping it", () => {
    const groups = groupStoriesByNovel(
      [],
      [{ workspaceNovel: { id: 12 }, novel: { id: 8, title: "ยังไม่มีแพ็ก" } }]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(0);
    expect(groups[0].novel?.title).toBe("ยังไม่มีแพ็ก");
    // A zero-pack story is not an anomaly and not published.
    expect(summarizeStoryPacks(groups[0].cards).total).toBe(0);
    expect(storyOverallStatus(summarizeStoryPacks(groups[0].cards))).toBe("in_progress");
  });

  it("shows the story in a NEW_STORY-only workspace (never global-empty when stories exist)", () => {
    // NEW_STORY cards are excluded from the pack board, so the only trace of
    // this workspace's story is its bound-novel seed.
    const groups = groupStoriesByNovel(
      [],
      [
        { workspaceNovel: { id: 21 }, novel: { id: 31, title: "ใหม่เอี่ยม" } },
        { workspaceNovel: { id: 22 }, novel: { id: 32, title: "ใหม่อีกเรื่อง" } },
      ]
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.novel?.title)).toEqual(["ใหม่อีกเรื่อง", "ใหม่เอี่ยม"]);
  });

  it("shows every story in a mixed workspace (packs, packless, distinct rows)", () => {
    const groups = groupStoriesByNovel(
      [
        { id: 1, workspaceNovelId: 11, novel: { id: 7, title: "A" } },
        { id: 2, workspaceNovelId: 11, novel: { id: 7, title: "A" } },
        { id: 3, workspaceNovelId: 13, novel: { id: 9, title: "B" } },
      ],
      [
        { workspaceNovel: { id: 11 }, novel: { id: 7, title: "A" } },
        { workspaceNovel: { id: 12 }, novel: { id: 8, title: "ไม่มีแพ็ก" } },
        { workspaceNovel: { id: 13 }, novel: { id: 9, title: "B" } },
      ]
    );
    expect(groups).toHaveLength(3);
    const cardsByTitle = (title: string) =>
      groups.find((group) => group.novel?.title === title)?.cards.length ?? -1;
    expect(cardsByTitle("A")).toBe(2);
    expect(cardsByTitle("ไม่มีแพ็ก")).toBe(0);
    expect(cardsByTitle("B")).toBe(1);
  });

  it("merges a card with a missing workspaceNovelId into its novel's seeded group", () => {
    const groups = groupStoriesByNovel(
      [{ id: 1, workspaceNovelId: null, novel: { id: 7, title: "A" } }],
      [{ workspaceNovel: { id: 11 }, novel: { id: 7, title: "A" } }]
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].workspaceNovelId).toBe(11);
    expect(groups[0].cards).toHaveLength(1);
  });

  it("keeps the story set canonical regardless of which cards are passed (global filters stay scoped to the table view)", () => {
    const allCards = [
      { id: 1, workspaceNovelId: 11, novel: { id: 7, title: "A" } },
      { id: 2, workspaceNovelId: 13, novel: { id: 9, title: "B" } },
    ];
    const bound = [
      { workspaceNovel: { id: 11 }, novel: { id: 7, title: "A" } },
      { workspaceNovel: { id: 13 }, novel: { id: 9, title: "B" } },
    ];
    // The page always groups the FULL board for the overview; a filtered list
    // (the legacy table view) still cannot invent or drop stories there.
    expect(groupStoriesByNovel(allCards, bound)).toHaveLength(2);
    expect(groupStoriesByNovel([allCards[0]], bound).map((group) => group.cards.length)).toEqual([1, 0]);
  });
});

describe("workspaceMultiStory — editor save identity invariant (IPE-062R3 P2-B)", () => {
  it("allows a save only when the editor target IS the selected pack's latest draft", () => {
    expect(editorDraftBelongsToSelectedPack(501, 501)).toBe(true);
  });

  it("rejects stale editor targets after a pack switch (identity mismatch = no save)", () => {
    expect(editorDraftBelongsToSelectedPack(501, 502)).toBe(false);
  });

  it("fails closed when either identity is missing (unloaded/unknown)", () => {
    expect(editorDraftBelongsToSelectedPack(undefined, 501)).toBe(false);
    expect(editorDraftBelongsToSelectedPack(501, undefined)).toBe(false);
    expect(editorDraftBelongsToSelectedPack(null, null)).toBe(false);
    expect(editorDraftBelongsToSelectedPack("501", 501)).toBe(true);
  });
});
