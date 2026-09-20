import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("IPE-056-S Reader Episode Pack TOC projection + entitlement UI", () => {
  it("returns safe package TOC metadata without returning package prose", () => {
    const router = readFileSync("server/routers.ts", "utf8");
    expect(router).toContain("const { content, fileUrl, ...safeEpisode } = ep");
    expect(router).toContain("projectPackageToc(content)");
    expect(router).toContain("packageChapterCount: packageToc.length");
  });

  it("keeps package TOC metadata for counts/reader flow without rendering projected chapter rows on the public storefront", () => {
    const page = readFileSync("client/src/pages/NovelDetailPage.tsx", "utf8");
    expect(page).toContain("projectedPackageChapters");
    expect(page).toContain("packageId: pkg.id");
    expect(page).toContain("pkg.isPurchased === true || pkg.hasPurchased === true");
    expect(page).not.toContain("ตอนในแพ็ก (");
    expect(page).toContain("แพ็กสำหรับซื้อ");
    expect(page).toContain("packageEpisodes.map(renderPackageEpisodeCard)");
  });

  it("deep-links an unlocked projected chapter into the package reader TOC", () => {
    const reader = readFileSync("client/src/pages/ReaderPage.tsx", "utf8");
    expect(reader).toContain('new URLSearchParams(window.location.search).get("chapter")');
    expect(reader).toContain("findTocEntryByChapterNumber(toc, requestedChapter)");
  });
});
