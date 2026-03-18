import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Admin Novels Visibility", () => {
  let archivedNovelId: number;
  let publishedNovelId: number;

  beforeAll(async () => {
    // Create test novels
    archivedNovelId = await db.createNovel({
      title: "Test Admin Archived Novel",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    publishedNovelId = await db.createNovel({
      title: "Test Admin Published Novel",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test Admin %'`);
    }
  });

  describe("Public Queries (getAllNovels)", () => {
    it("should NOT return archived novels to public users", async () => {
      const result = await db.getAllNovels();
      const archivedFound = result.some((novel: any) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(false);
    });

    it("should return published novels to public users", async () => {
      const result = await db.getAllNovels();
      const publishedFound = result.some((novel: any) => novel.id === publishedNovelId);
      expect(publishedFound).toBe(true);
    });
  });

  describe("Admin Queries (getAllNovelsForAdmin)", () => {
    it("should return archived novels to admin", async () => {
      const result = await db.getAllNovelsForAdmin();
      const archivedFound = result.some((novel: any) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(true);
    });

    it("should return published novels to admin", async () => {
      const result = await db.getAllNovelsForAdmin();
      const publishedFound = result.some((novel: any) => novel.id === publishedNovelId);
      expect(publishedFound).toBe(true);
    });

    it("should return both archived and published novels", async () => {
      const result = await db.getAllNovelsForAdmin();
      const archivedFound = result.some((novel: any) => novel.id === archivedNovelId);
      const publishedFound = result.some((novel: any) => novel.id === publishedNovelId);
      expect(archivedFound && publishedFound).toBe(true);
    });
  });

  describe("Admin Detail Access", () => {
    it("should allow admin to access archived novel detail (publicOnly=false)", async () => {
      const novel = await db.getNovelById(archivedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("archived");
    });

    it("should allow admin to access published novel detail (publicOnly=false)", async () => {
      const novel = await db.getNovelById(publishedNovelId, false);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });

  describe("Public Detail Access", () => {
    it("should NOT allow public to access archived novel detail (publicOnly=true)", async () => {
      const novel = await db.getNovelById(archivedNovelId, true);
      expect(novel).toBeUndefined();
    });

    it("should allow public to access published novel detail (publicOnly=true)", async () => {
      const novel = await db.getNovelById(publishedNovelId, true);
      expect(novel).toBeDefined();
      expect(novel?.publicationStatus).toBe("published");
    });
  });
});
