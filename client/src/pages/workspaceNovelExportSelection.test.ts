// IPE-064R4B review round 28 (P2) — unit contract for the recovery picker
// reconciliation: returned sourceEpisodes IDs are the authoritative picker
// set; the selection automatically intersects with that set.

import { describe, expect, it } from "vitest";

import { pruneEpisodeSelection } from "./workspaceNovelExportSelection";

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
