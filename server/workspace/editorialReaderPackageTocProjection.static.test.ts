import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("IPE-056-S Reader Episode Pack TOC projection + entitlement UI", () => {
  it("returns safe package TOC metadata without returning package prose", () => {
    const router = readFileSync("server/routers.ts", "utf8");
    expect(router).toContain("const { content, fileUrl, ...safeEpisode } = ep");
    expect(router).toContain("projectPackageToc(content)");
    expect(router).toContain("packageChapterCount: packageToc.length");
  });

  it("keeps package TOC metadata out of the public storefront and renders one commercial row per package", () => {
    const page = readFileSync("client/src/pages/NovelDetailPage.tsx", "utf8");
    expect(page).not.toContain("projectedPackageChapters");
    expect(page).not.toContain("ตอนในแพ็ก (");
    expect(page).toContain("ขายแพ็ก");
    expect(page).toContain("packageEpisodes.map(renderPackageEpisodeCard)");
    expect(page).toContain("visibleReaderEpisodes.length + packageEpisodes.length");
  });

  it("deep-links an unlocked projected chapter into the package reader TOC", () => {
    const reader = readFileSync("client/src/pages/ReaderPage.tsx", "utf8");
    expect(reader).toContain('new URLSearchParams(window.location.search).get("chapter")');
    expect(reader).toContain("findTocEntryByChapterNumber(toc, requestedChapter)");
  });
});
