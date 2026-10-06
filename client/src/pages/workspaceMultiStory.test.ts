import { describe, expect, it } from "vitest";

import {
  createStoryUiState,
  derivePackCardStatus,
  derivePackStatus,
  editorDraftBelongsToSelectedPack,
  filterPacksByQuery,
  groupStoriesByNovel,
  mergeEvidenceRowsSkippingInvalidated,
  reconcilableEvidenceIds,
  resolveStoryUiState,
  scopeNeedsReconciliation,
  sortPacksByEpisode,
  storyKeyFor,
  storyOverviewFooterLine,
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

  it("summarizes a story's packs into the operator counters", () => {
    const summary = summarizeStoryPacks([
      { evidence: { checkerRan: true, checker: true } },
      { evidence: { checkerRan: true, checker: true, published: true } },
      { evidence: { checkerRan: true, checker: false } },
      { evidence: { available: false } },
      { evidence: {} },
    ]);
    expect(summary).toEqual({
      total: 5,
      published: 1,
      passed: 1,
      needsFix: 1,
      anomalous: 1,
      notChecked: 1,
      unknown: 0,
    });
    expect(storyOverallStatus(summary)).toBe("anomalous");
  });

  // IPE-065: progressive loading semantics — a pack WITHOUT a loaded evidence
  // row is loading/unknown, never a genuine not_checked.
  it("keeps loading and unknown distinct from not_checked (loaded rows only)", () => {
    expect(derivePackCardStatus({ evidence: null, evidenceState: "loading" })).toBe("loading");
    expect(derivePackCardStatus({ evidence: null, evidenceState: "unavailable" })).toBe("unknown");
    // No signal at all fails closed to unknown.
    expect(derivePackCardStatus({ evidence: null })).toBe("unknown");
    expect(derivePackCardStatus({})).toBe("unknown");
    // A LOADED row maps through the unchanged success-path contract.
    expect(derivePackCardStatus({ evidence: {}, evidenceState: "loaded" })).toBe("not_checked");
    expect(derivePackCardStatus({ evidence: { checker: true }, evidenceState: "loaded" })).toBe("passed");
    expect(derivePackCardStatus({ evidence: { published: true, checker: true }, evidenceState: "loaded" })).toBe("published");
  });

  it("never promotes loading/unknown/error evidence into a checked or passed state", () => {
    for (const state of ["loading", "unknown"] as const) {
      const status = derivePackCardStatus({ evidence: null, evidenceState: state });
      expect(["passed", "published", "not_checked"]).not.toContain(status);
    }
    // A row that reports an error stays anomalous (fail closed), never PASS.
    expect(derivePackStatus({ available: false, error: "boom" })).toBe("anomalous");
    expect(derivePackCardStatus({ evidence: { available: false }, evidenceState: "loaded" })).toBe("anomalous");
  });

  it("counts missing-row packs as unknown, keeping notChecked genuine (IPE-065)", () => {
    const summary = summarizeStoryPacks([
      { evidence: { checkerRan: true, checker: true }, evidenceState: "loaded" },
      { evidence: null, evidenceState: "loading" },
      { evidence: null, evidenceState: "unavailable" },
    ]);
    expect(summary).toEqual({
      total: 3,
      published: 0,
      passed: 1,
      needsFix: 0,
      anomalous: 0,
      notChecked: 0,
      unknown: 2,
    });
    // Unknown packs keep the story neutral in-progress.
    expect(storyOverallStatus(summary)).toBe("in_progress");
  });

  it("rolls the story up as published only when every pack is published", () => {
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { published: true, checker: true } }]))).toBe("published");
    expect(STORY_OVERALL_LABEL.published).toBe("ลงแล้วทั้งหมด");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checker: true } }, { evidence: null }]))).toBe("in_progress");
    expect(storyOverallStatus(summarizeStoryPacks([]))).toBe("in_progress");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checker: true } }]))).toBe("passed");
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: { checkerRan: true, checker: false } }]))).toBe("needs_fix");
    // A full-unknown story never rolls up to passed/published (IPE-065).
    expect(storyOverallStatus(summarizeStoryPacks([{ evidence: null, evidenceState: "unavailable" }]))).toBe("in_progress");
  });
});

// IPE-065R1 (P2): the story-card footer is a pure decision — an
// unknown/loading story must NEVER render a PASS line.
describe("workspaceMultiStory — story overview footer (IPE-065R1)", () => {
  const summaryOf = (cards: Parameters<typeof summarizeStoryPacks>[number]) =>
    summarizeStoryPacks(cards);

  it("shows neutral รอสถานะ wording for a story with unknown/loading packs (never ผ่าน)", () => {
    const summary = summaryOf([
      { evidence: null, evidenceState: "loading" },
      { evidence: null, evidenceState: "unavailable" },
    ]);
    const footer = storyOverviewFooterLine({ focused: false, summary, overall: "in_progress" });
    expect(footer).toBe("รอสถานะ 2 แพ็ก");
    expect(footer).not.toContain(STORY_PACK_STATUS_LABEL.passed);
    expect(footer).not.toContain(STORY_PACK_STATUS_LABEL.published);
  });

  it("shows ยังไม่ตรวจ wording for genuinely-not-checked packs (not a PASS line)", () => {
    const footer = storyOverviewFooterLine({
      focused: false,
      summary: summaryOf([{ evidence: {} }]),
      overall: "in_progress",
    });
    expect(footer).toBe("ยังไม่ตรวจ 1 แพ็ก");
  });

  it("keeps the needs-fix/anomalous warning wording unchanged", () => {
    expect(
      storyOverviewFooterLine({
        focused: false,
        summary: summaryOf([{ evidence: { checkerRan: true, checker: false } }]),
        overall: "needs_fix",
      })
    ).toBe("มีงานรอแก้ 1 แพ็ก");
    expect(
      storyOverviewFooterLine({
        focused: false,
        summary: summaryOf([{ evidence: { available: false } }, { evidence: { checkerRan: true, checker: false } }]),
        overall: "anomalous",
      })
    ).toBe("มีงานรอแก้ 2 แพ็ก");
  });

  it("renders the PASS line only for a genuinely passed rollup", () => {
    const passed = storyOverviewFooterLine({
      focused: false,
      summary: summaryOf([{ evidence: { checker: true } }]),
      overall: "passed",
    });
    expect(passed).toBe(STORY_PACK_STATUS_LABEL.passed);
    // Mixed with a single unknown pack the same story stops being "ผ่าน".
    const withUnknown = storyOverviewFooterLine({
      focused: false,
      summary: summaryOf([{ evidence: { checker: true } }, { evidence: null, evidenceState: "unavailable" }]),
      overall: "in_progress",
    });
    expect(withUnknown).toBe("รอสถานะ 1 แพ็ก");
  });

  it("renders the published line only for a genuinely published rollup", () => {
    expect(
      storyOverviewFooterLine({
        focused: false,
        summary: summaryOf([{ evidence: { published: true, checker: true } }]),
        overall: "published",
      })
    ).toBe(STORY_PACK_STATUS_LABEL.published);
  });

  it("keeps the focused-story line for the story being worked on", () => {
    expect(
      storyOverviewFooterLine({
        focused: true,
        summary: summaryOf([{ evidence: { checker: true } }]),
        overall: "passed",
      })
    ).toBe("กำลังทำงานอยู่ — state ของเรื่องนี้ถูกจำไว้");
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

// ---------------------------------------------------------------------------
// IPE-065R2 — invalidation tombstone fence. Once an evidence-changing
// mutation succeeds for workItem X, no pre-mutation evidence row may become
// authoritative again until a successful post-fence fetch returns X — even
// when X's story is inactive, the cache is staleTime-fresh, or the post-
// mutation refetch fails.
// ---------------------------------------------------------------------------
describe("workspaceMultiStory — evidence tombstone fence (IPE-065R2)", () => {
  const rowA = { workItemId: 101, checker: true, approval: true, stage: true, readyToPublish: true, published: false };
  const rowAStale = { workItemId: 101, checker: true, approval: true, readyToPublish: true, published: false };
  const rowB = { workItemId: 202, checker: true, checkerRan: true, published: true };
  const cachedPass = new Map<number, any>([[101, rowA]]);

  it("scenario A: a tombstoned id is NEVER merged from cache — even staleTime-fresh story re-activation", () => {
    // Story A's old PASS arrives through the generic merge (cache observation
    // on scope re-activation) while A is tombstoned → skipped entirely.
    const merged = mergeEvidenceRowsSkippingInvalidated(new Map(), [rowA], new Set([101]));
    expect(merged).toBeNull();
    // And it cannot re-enter an existing map either.
    const mergedIntoExisting = mergeEvidenceRowsSkippingInvalidated(
      new Map([[202, rowB]]),
      [rowA],
      new Set([101])
    );
    // Nothing merged → null (bail out): the CURRENT map survives untouched,
    // so B's row stays and A's stale PASS never re-enters.
    expect(mergedIntoExisting).toBeNull();
    // Scope activation with a tombstoned id demands forced reconciliation —
    // staleTime must not suppress it.
    expect(scopeNeedsReconciliation([101, 202], new Set([101]))).toBe(true);
  });

  it("scenario B: a FAILED reconciliation keeps the tombstone — old PASS never returns", () => {
    // A failed refetch returns no rows → nothing is reconcilable → the
    // tombstone stays and the generic merge keeps skipping the cached PASS.
    expect(reconcilableEvidenceIds(new Set([101]), [])).toEqual([]);
    expect(reconcilableEvidenceIds(new Set([101]), undefined)).toEqual([]);
    const stillFenced = mergeEvidenceRowsSkippingInvalidated(new Map(), [rowA], new Set([101]));
    expect(stillFenced).toBeNull();
    // The only card-visible status for that pack remains fail-closed.
    expect(derivePackCardStatus({ evidence: null, evidenceState: "unavailable" })).toBe("unknown");
  });

  it("scenario C: invalidating A never clears or blocks unrelated B evidence", () => {
    const current = new Map<number, any>([[202, rowB]]);
    const merged = mergeEvidenceRowsSkippingInvalidated(current, [rowAStale, rowB], new Set([101]));
    expect(merged?.get(202)).toBe(rowB);
    expect(merged?.has(101)).toBe(false);
    // B needs no reconciliation.
    expect(scopeNeedsReconciliation([202], new Set([101]))).toBe(false);
  });

  it("scenario D: a successful post-fence fetch merges the fresh row and releases the tombstone", () => {
    const freshRow = { workItemId: 101, checker: false, checkerRan: true, approval: false };
    // The post-fence result contains A → exactly A is reconcilable.
    expect(reconcilableEvidenceIds(new Set([101]), [freshRow, rowB])).toEqual([101]);
    // Fresh row merges (empty fence on the post-fence branch)…
    const merged = mergeEvidenceRowsSkippingInvalidated(new Map(), [freshRow], new Set());
    expect(merged?.get(101)).toBe(freshRow);
    // …and once released, ordinary cache reuse is allowed again — the same
    // fresh row merges freely with an empty fence.
    const ordinaryReuse = mergeEvidenceRowsSkippingInvalidated(new Map([[101, freshRow]]), [freshRow], new Set());
    expect(ordinaryReuse?.get(101)).toBe(freshRow);
  });

  it("tombstones fence by id — an id absent from the fresh result stays fenced", () => {
    // A mutation may remove the pack: the fresh scope result lacks 101, so
    // nothing releases it and no stale row can come back for it.
    expect(reconcilableEvidenceIds(new Set([101, 303]), [rowB])).toEqual([]);
  });

  it("merge bails out (null) when rows are absent so no render churn occurs", () => {
    expect(mergeEvidenceRowsSkippingInvalidated(cachedPass, undefined, new Set())).toBeNull();
    expect(mergeEvidenceRowsSkippingInvalidated(cachedPass, [], new Set())).toBeNull();
    // Rows without a valid workItemId are never merged.
    expect(mergeEvidenceRowsSkippingInvalidated(new Map(), [{ workItemId: null, checker: true }], new Set())).toBeNull();
  });
});
