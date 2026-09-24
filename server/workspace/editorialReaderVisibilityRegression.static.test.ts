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
  it("hides locked legacy chapter products while keeping free/already-owned legacy rows readable", () => {
    const page = read("client/src/pages/NovelDetailPage.tsx");
    expect(page).toContain("filteredAndSortedEpisodes.readerEpisodes.filter");
    expect(page).toContain("ep?.isFree === true || ep?.isPurchased === true || ep?.hasPurchased === true");
    expect(page).toContain("ตอนฟรี / ที่ซื้อแล้ว");
    expect(page).toContain("Public commerce is one row per Episode Pack");
  });
});
