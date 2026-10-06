// IPE-064R4B review round 28 (P2) — unit contract for the recovery picker
// reconciliation: returned sourceEpisodes IDs are the authoritative picker
// set; the selection automatically intersects with that set.

import { describe, expect, it } from "vitest";

import {
  pruneEpisodeSelection,
  thaiOverLimitBlocksDownload,
} from "./workspaceNovelExportSelection";

describe("pruneEpisodeSelection", () => {
  it("drops selected IDs absent from the returned picker set", () => {
    const selection = [10, 11, 12];
    const picker = [10, 12];
    expect(pruneEpisodeSelection(selection, picker)).toEqual([10, 12]);
  });

  it("keeps every valid selection in its original order without re-sorting", () => {
    const selection = [12, 10];
    const picker = [10, 11, 12];
    expect(pruneEpisodeSelection(selection, picker)).toEqual([12, 10]);
  });

  it("returns the SAME array reference when nothing needs pruning (loop guard)", () => {
    const selection = [10, 11];
    const picker = [10, 11, 12];
    expect(pruneEpisodeSelection(selection, picker)).toBe(selection);
  });

  it("clears the selection only when the picker genuinely contains none of it", () => {
    const selection = [10, 11];
    expect(pruneEpisodeSelection(selection, [])).toEqual([]);
    expect(pruneEpisodeSelection(selection, [99, 100])).toEqual([]);
  });

  it("never resurrects IDs and never adds picker-only IDs to the selection", () => {
    const selection = [10];
    const picker = [10, 11, 12];
    expect(pruneEpisodeSelection(selection, picker)).toEqual([10]);
  });
});

// IPE-064R4B review round 30 (P2 #1): the Thai expansion limit is a THAI-mode
// constraint and must never gate the independently valid Backup download.
describe("thaiOverLimitBlocksDownload", () => {
  const limit = { itemCount: 600, maxItems: 500 };

  it("A. blocks the Thai whole-scope download when the expansion exceeds the limit", () => {
    expect(thaiOverLimitBlocksDownload("thainovel", "whole", limit)).toBe(true);
  });

  it("B. does NOT block Backup — the cached Thai limit must not leak across modes", () => {
    expect(thaiOverLimitBlocksDownload("backup", "whole", limit)).toBe(false);
  });

  it("C. does not block a Thai subset download (per-pack subsets are the way out)", () => {
    expect(thaiOverLimitBlocksDownload("thainovel", "subset", limit)).toBe(false);
    expect(thaiOverLimitBlocksDownload("backup", "subset", limit)).toBe(false);
  });

  it("D. no over-limit data → nothing blocked in any mode/scope (switching back to Thai re-arms once data returns)", () => {
    expect(thaiOverLimitBlocksDownload("thainovel", "whole", null)).toBe(false);
    expect(thaiOverLimitBlocksDownload("backup", "whole", null)).toBe(false);
  });
});
