import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";

describe("Browse Catalog - Archived Novel Filtering", () => {
  let archivedNovelId: number;
  let publishedNovelId: number;

  beforeAll(async () => {
    // Create test novels
    archivedNovelId = await db.createNovel({
      title: "Test Browse Archived Novel",
      publicationStatus: "archived",
      storyStatus: "ongoing",
    });

    publishedNovelId = await db.createNovel({
      title: "Test Browse Published Novel",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
  });

  afterAll(async () => {
    // Clean up test data
    const database = await getDb();
    if (database) {
      await database.execute(`DELETE FROM novels WHERE title LIKE 'Test Browse %'`);
    }
  });

  describe("Browse Catalog Filtering", () => {
    it("should NOT return archived novels in browse catalog", async () => {
      const result = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
        limit: 100,
        offset: 0,
      });

      const archivedFound = result.some((novel) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(false);
    });

    it("should return published novels in browse catalog", async () => {
      const result = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
        limit: 100,
        offset: 0,
      });

      const publishedFound = result.some((novel) => novel.id === publishedNovelId);
      expect(publishedFound).toBe(true);
    });

    it("should filter archived novels even with free filter", async () => {
      const result = await db.getBrowseCatalog({
        sort: "new",
        filter: "free",
        limit: 100,
        offset: 0,
      });

      const archivedFound = result.some((novel) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(false);
    });

    it("should filter archived novels even with search", async () => {
      const result = await db.getBrowseCatalog({
        sort: "new",
        filter: "all",
        search: "Test Browse",
        limit: 100,
        offset: 0,
      });

      const archivedFound = result.some((novel) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(false);

      const publishedFound = result.some((novel) => novel.id === publishedNovelId);
      expect(publishedFound).toBe(true);
    });

    it("should filter archived novels with all combinations", async () => {
      const result = await db.getBrowseCatalog({
        sort: "popular",
        filter: "all",
        search: "Test Browse",
        limit: 100,
        offset: 0,
      });

      const archivedFound = result.some((novel) => novel.id === archivedNovelId);
      expect(archivedFound).toBe(false);
    });
  });
});
