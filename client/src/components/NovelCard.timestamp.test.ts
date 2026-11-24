import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

describe("IpeNovel public/admin timestamp display contract", () => {
  it("public cover cards show updated timestamp, not creation metadata", () => {
    const card = source("client/src/components/NovelCard.tsx");
    expect(card).toContain("updatedAt?: Date | string | null");
    expect(card).toContain("อัปเดตล่าสุด: {updatedLabel}");
    expect(card).not.toContain("สร้าง:");
  });

  it("home and catalog forward effective novel timestamps and episode updates", () => {
    const home = source("client/src/pages/Home.tsx");
    const catalog = source("client/src/pages/NovelsPage.tsx");
    const detail = source("client/src/pages/NovelDetailPage.tsx");
    expect(home).toContain("updatedAt={publishedEpisodeDisplayTime(episode)}");
    expect(home).toContain("updatedAt={novel.displayUpdatedAt ?? novel.updatedAt}");
    expect(catalog).toContain("updatedAt={novel.displayUpdatedAt ?? novel.updatedAt}");
    expect(detail).toContain("formatContentTimestamp(novel.novel.displayUpdatedAt ?? novel.novel.updatedAt)");
    expect(detail).toContain("formatContentTimestamp(publishedEpisodeDisplayTime(episode))");
    expect(detail).not.toContain("formatContentTimestamp(episode.createdAt)");
  });

  it("admin novel and episode listings show both timestamps", () => {
    const novels = source("client/src/pages/AdminNovelsPage.tsx");
    const episodes = source("client/src/pages/AdminEpisodesPage.tsx");
    const manage = source("client/src/pages/AdminNovelManagePage.tsx");
    expect(novels).toContain("formatContentTimestamp(novel.createdAt)");
    expect(novels).toContain("formatContentTimestamp(novel.displayUpdatedAt ?? novel.updatedAt)");
    expect(episodes).toContain("formatContentTimestamp(episode.createdAt)");
    expect(episodes).toContain("formatContentTimestamp(episode.updatedAt)");
    expect(manage).toContain("formatContentTimestamp(novel.novel.createdAt)");
    expect(manage).toContain("formatContentTimestamp(episode.updatedAt)");
  });

  it("effective novel update timestamp aggregates published episodes only", () => {
    const database = source("server/db.ts");
    const fn = database.slice(
      database.indexOf("export async function withPublishedEpisodeUpdateTime"),
      database.indexOf("export async function getNovelById")
    );
    expect(fn).toContain("MAX(UNIX_TIMESTAMP(GREATEST(");
    expect(fn).toContain("COALESCE(${episodes.publishedAt}, ${episodes.createdAt})");
    expect(fn).toContain("eq(episodes.isPublished, true)");
    expect(fn).toContain("resolveNovelDisplayUpdatedAt(row.createdAt");
  });
});
