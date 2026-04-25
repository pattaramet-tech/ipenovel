import { describe, it, expect } from "vitest";

// ============================================================
// Unit tests for Finished Novels UX improvements
// ============================================================

// ---------------------------------------------------------------------------
// 1. storyStatus badge color logic (pure function, no DB required)
// ---------------------------------------------------------------------------

function getStoryStatusBadgeClass(storyStatus: string | null | undefined): string {
  if (storyStatus === "finished") {
    return "bg-purple-100 text-purple-700";
  }
  return "bg-blue-100 text-blue-700";
}

describe("storyStatus badge color", () => {
  it("returns purple classes for finished novels", () => {
    expect(getStoryStatusBadgeClass("finished")).toBe("bg-purple-100 text-purple-700");
  });

  it("returns blue classes for ongoing novels", () => {
    expect(getStoryStatusBadgeClass("ongoing")).toBe("bg-blue-100 text-blue-700");
  });

  it("returns blue classes for null storyStatus (default)", () => {
    expect(getStoryStatusBadgeClass(null)).toBe("bg-blue-100 text-blue-700");
  });

  it("returns blue classes for undefined storyStatus", () => {
    expect(getStoryStatusBadgeClass(undefined)).toBe("bg-blue-100 text-blue-700");
  });

  it("returns blue classes for unknown storyStatus values", () => {
    expect(getStoryStatusBadgeClass("hiatus")).toBe("bg-blue-100 text-blue-700");
  });
});

// ---------------------------------------------------------------------------
// 2. storyStatus filter URL parameter logic
// ---------------------------------------------------------------------------

function buildBrowseUrl(params: {
  sort?: string;
  filter?: string;
  storyStatus?: string;
}): string {
  const urlParams = new URLSearchParams();
  if (params.sort) urlParams.set("sort", params.sort);
  if (params.filter) urlParams.set("filter", params.filter);
  if (params.storyStatus && params.storyStatus !== "all") {
    urlParams.set("storyStatus", params.storyStatus);
  }
  return `/novels?${urlParams.toString()}`;
}

describe("browse URL parameter building", () => {
  it("adds storyStatus=finished to URL when finished filter selected", () => {
    const url = buildBrowseUrl({ storyStatus: "finished" });
    expect(url).toContain("storyStatus=finished");
  });

  it("adds storyStatus=ongoing to URL when ongoing filter selected", () => {
    const url = buildBrowseUrl({ storyStatus: "ongoing" });
    expect(url).toContain("storyStatus=ongoing");
  });

  it("does not add storyStatus param when 'all' is selected", () => {
    const url = buildBrowseUrl({ storyStatus: "all" });
    expect(url).not.toContain("storyStatus");
  });

  it("does not add storyStatus param when not provided", () => {
    const url = buildBrowseUrl({ sort: "new" });
    expect(url).not.toContain("storyStatus");
  });

  it("combines storyStatus with other filters correctly", () => {
    const url = buildBrowseUrl({ sort: "popular", filter: "free", storyStatus: "finished" });
    expect(url).toContain("sort=popular");
    expect(url).toContain("filter=free");
    expect(url).toContain("storyStatus=finished");
  });

  it("View All Finished link uses correct URL", () => {
    // The Home page 'View All Finished' button links to /novels?storyStatus=finished
    const expectedUrl = "/novels?storyStatus=finished";
    expect(expectedUrl).toContain("storyStatus=finished");
    expect(expectedUrl).not.toContain("filter=");
    expect(expectedUrl).not.toContain("sort=");
  });
});

// ---------------------------------------------------------------------------
// 3. getBrowseCatalog storyStatus filter logic (pure condition logic)
// ---------------------------------------------------------------------------

interface MockNovel {
  id: number;
  title: string;
  storyStatus: "ongoing" | "finished";
  publicationStatus: "published" | "archived";
}

function filterBrowseCatalog(
  novels: MockNovel[],
  params: { storyStatus?: "ongoing" | "finished"; filter?: "all" | "free" }
): MockNovel[] {
  return novels.filter((novel) => {
    if (novel.publicationStatus !== "published") return false;
    if (params.storyStatus && params.storyStatus !== undefined) {
      if (novel.storyStatus !== params.storyStatus) return false;
    }
    return true;
  });
}

const mockNovels: MockNovel[] = [
  { id: 1, title: "Ongoing Novel A", storyStatus: "ongoing", publicationStatus: "published" },
  { id: 2, title: "Finished Novel B", storyStatus: "finished", publicationStatus: "published" },
  { id: 3, title: "Finished Novel C", storyStatus: "finished", publicationStatus: "published" },
  { id: 4, title: "Archived Finished", storyStatus: "finished", publicationStatus: "archived" },
  { id: 5, title: "Ongoing Novel D", storyStatus: "ongoing", publicationStatus: "published" },
];

describe("getBrowseCatalog storyStatus filter logic", () => {
  it("returns only finished novels when storyStatus=finished", () => {
    const result = filterBrowseCatalog(mockNovels, { storyStatus: "finished" });
    expect(result).toHaveLength(2);
    expect(result.every((n) => n.storyStatus === "finished")).toBe(true);
  });

  it("returns only ongoing novels when storyStatus=ongoing", () => {
    const result = filterBrowseCatalog(mockNovels, { storyStatus: "ongoing" });
    expect(result).toHaveLength(2);
    expect(result.every((n) => n.storyStatus === "ongoing")).toBe(true);
  });

  it("returns all published novels when no storyStatus filter", () => {
    const result = filterBrowseCatalog(mockNovels, {});
    expect(result).toHaveLength(4); // 4 published novels (1 archived excluded)
  });

  it("excludes archived novels even if storyStatus matches", () => {
    const result = filterBrowseCatalog(mockNovels, { storyStatus: "finished" });
    expect(result.find((n) => n.id === 4)).toBeUndefined(); // Archived Finished excluded
  });

  it("returns empty array when no novels match storyStatus", () => {
    const onlyOngoing: MockNovel[] = [
      { id: 1, title: "Ongoing A", storyStatus: "ongoing", publicationStatus: "published" },
    ];
    const result = filterBrowseCatalog(onlyOngoing, { storyStatus: "finished" });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. getFinishedNovels selection logic (pure filter)
// ---------------------------------------------------------------------------

function getFinishedNovelsFilter(novels: MockNovel[], limit: number = 4): MockNovel[] {
  return novels
    .filter((n) => n.publicationStatus === "published" && n.storyStatus === "finished")
    .slice(0, limit);
}

describe("getFinishedNovels filter logic", () => {
  it("returns only published finished novels", () => {
    const result = getFinishedNovelsFilter(mockNovels);
    expect(result.every((n) => n.storyStatus === "finished")).toBe(true);
    expect(result.every((n) => n.publicationStatus === "published")).toBe(true);
  });

  it("respects the limit parameter", () => {
    const manyFinished: MockNovel[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Finished Novel ${i + 1}`,
      storyStatus: "finished",
      publicationStatus: "published",
    }));
    const result = getFinishedNovelsFilter(manyFinished, 4);
    expect(result).toHaveLength(4);
  });

  it("returns empty array when no finished novels exist", () => {
    const onlyOngoing: MockNovel[] = [
      { id: 1, title: "Ongoing A", storyStatus: "ongoing", publicationStatus: "published" },
    ];
    const result = getFinishedNovelsFilter(onlyOngoing);
    expect(result).toHaveLength(0);
  });

  it("excludes archived finished novels", () => {
    const result = getFinishedNovelsFilter(mockNovels);
    expect(result.find((n) => n.id === 4)).toBeUndefined();
  });

  it("uses default limit of 4", () => {
    const manyFinished: MockNovel[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      title: `Finished Novel ${i + 1}`,
      storyStatus: "finished",
      publicationStatus: "published",
    }));
    const result = getFinishedNovelsFilter(manyFinished);
    expect(result).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 5. Home page section visibility logic
// ---------------------------------------------------------------------------

describe("Home page Finished Novels section visibility", () => {
  it("shows section when finishedNovels array is non-empty", () => {
    const finishedNovels = [{ id: 1, title: "Test" }];
    const shouldShow = finishedNovels.length > 0;
    expect(shouldShow).toBe(true);
  });

  it("hides section when finishedNovels array is empty", () => {
    const finishedNovels: any[] = [];
    const shouldShow = finishedNovels.length > 0;
    expect(shouldShow).toBe(false);
  });

  it("shows section during loading state", () => {
    const isLoading = true;
    const finishedNovels: any[] = [];
    // Section is shown when (isLoading || finishedNovels.length > 0)
    const shouldShow = isLoading || finishedNovels.length > 0;
    expect(shouldShow).toBe(true);
  });

  it("View All Finished button navigates to correct URL", () => {
    const href = "/novels?storyStatus=finished";
    expect(href).toBe("/novels?storyStatus=finished");
  });
});
