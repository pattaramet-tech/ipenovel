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
  });
  it("keeps the published TOC visible when optional user enrichment fails", () => {
    const router = read("server/routers.ts");
    const page = read("client/src/pages/NovelDetailPage.tsx");
    expect(router).toContain("Public TOC visibility must not depend on optional per-user progress.");
    expect(router).toContain("Entitlement enrichment is optional storefront personalization.");
    expect(router).toContain("hasPurchased = false");
    expect(router).toContain("const canRead = isFree || hasPurchased || isAdmin");
    expect(page).toContain("error: episodesError");
    expect(page).toContain("โหลดรายการตอนที่เผยแพร่ไม่สำเร็จ");
    expect(page).toContain('episodesError ? "—" : episodesLoading ? "…" : totalReadableChapterCount');
  });
  it("keeps locked legacy chapter rows visible without restoring per-chapter commerce", () => {
    const page = read("client/src/pages/NovelDetailPage.tsx");
    expect(page).toContain("() => filteredAndSortedEpisodes.readerEpisodes");
    expect(page).toContain("<span>ล็อก</span>");
    expect(page).toContain("new commerce is package-only");
  });
});
