import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(p, "utf8");
describe("IPE-056-K discoverability + public reader TOC regression", () => {
  it("puts tab exclusion directly on the visible draft structure (tools rail)", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    // IPE-062R4D: exclusion targets the open chapter's tab via the same
    // guarded mutation (the old per-row buttons retired with the navigator).
    expect(page).toContain("candidate.sourceTabId === chapterEditorTarget.sourceTabId");
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
    // Package split: a chapter covered by an owned package is readable too.
    // The coverage lookup is optional personalization exactly like the
    // purchase enrichment above - its failure must never hide the TOC.
    expect(router).toContain("const canRead = isFree || hasPurchased || isCoveredByOwnedPackage || isAdmin");
    expect(router).toContain("Package coverage enrichment failed");
    expect(page).toContain("error: episodesError");
    expect(page).toContain("โหลดรายการตอนที่เผยแพร่ไม่สำเร็จ");
    expect(page).toContain('episodesError ? "—" : episodesLoading ? "…" : totalReadableChapterCount');
  });
  // Package -> chapter split (supersedes the IPE-056-K "hide locked legacy
  // chapter products" policy): chapter rows are sold individually again, but
  // a chapter already covered by an owned package is readable and NEVER
  // offered for sale, and the P3 upgrade entry point is still driven only by
  // chapters the user actually owns.
  it("lists chapter rows for sale while never offering a package-covered chapter, and keeps the upgrade CTA on PAID chapters only", () => {
    const page = read("client/src/pages/NovelDetailPage.tsx");
    expect(page).toContain("const visibleReaderEpisodes = filteredAndSortedEpisodes.readerEpisodes;");
    expect(page).toContain("ep?.hasPaidPurchase === true && ep?.isFree !== true");
    expect(page).toContain("paidReaderEpisodes.length > 0 && novel?.packageUpgradeEnabled === true");
    expect(page).toContain('episode.coveredByOwnedPackage === true');
    expect(page).toContain("ปลดล็อกผ่านแพ็ก");
    expect(page).toContain("Public commerce is one row per Episode Pack");
  });
});
