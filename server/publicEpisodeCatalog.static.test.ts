import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routersPath = path.resolve(process.cwd(), "server/routers.ts");
const source = fs.readFileSync(routersPath, "utf8");
const start = source.indexOf("episodes: publicProcedure");
const end = source.indexOf("categories: router({", start);
const episodesProcedure = source.slice(start, end);

describe("public episode catalog contract", () => {
  it("keeps novel episode/package metadata public for anonymous storefront visitors", () => {
    expect(start).toBeGreaterThan(-1);
    expect(episodesProcedure).toContain("const user = ctx.user");
    expect(episodesProcedure).toContain(
      'const isAdmin = user?.role === "admin"'
    );
  });

  it("does not require user-specific purchase or progress lookups for anonymous visitors", () => {
    expect(episodesProcedure).toContain("const progressMap = user");
    expect(episodesProcedure).toContain("? await db.getReadingProgressBatch(");
    expect(episodesProcedure).toContain("user.id");
    expect(episodesProcedure).toContain("const hasPurchased = user");
    expect(episodesProcedure).toContain(
      "? await readerService.hasPurchasedEpisode(user.id, ep.id)"
    );
    expect(episodesProcedure).toContain(": false");
    expect(episodesProcedure).not.toContain("ctx.user.id");
  });

  it("continues stripping content and gates raw fileUrl on canRead", () => {
    expect(episodesProcedure).toContain(
      "const { content, fileUrl, ...safeEpisode } = ep"
    );
    expect(episodesProcedure).toContain("fileUrl: canRead");
  });
});
