import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(p, "utf8");
describe("IPE-056-K discoverability + public reader TOC regression", () => {
  it("puts tab exclusion directly on visible Draft structure rows", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("candidate.sourceTabId === tab.sourceTabId");
    expect(page).toContain("excludeEditorialTab.mutate");
  });
  it("allows anonymous users to fetch only published episode TOC metadata", () => {
    const router = read("server/routers.ts");
    expect(router).toContain("episodes: publicProcedure.input");
    expect(router).toContain("allEpisodes.filter((ep: any) => ep.isPublished === true)");
    expect(router).toContain("userId ? await readerService.hasPurchasedEpisode(userId, ep.id) : false");
  });
  it("keeps locked legacy chapter rows visible without restoring per-chapter commerce", () => {
    const page = read("client/src/pages/NovelDetailPage.tsx");
    expect(page).toContain("() => filteredAndSortedEpisodes.readerEpisodes");
    expect(page).toContain("<span>ล็อก</span>");
    expect(page).toContain("new commerce is package-only");
  });
});
