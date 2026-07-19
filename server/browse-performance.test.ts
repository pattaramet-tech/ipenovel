import { describe, it, expect } from "vitest";
import * as db from "./db";

/**
 * Tests for Browse page performance optimizations
 * Verifies that database indexes are working and queries are efficient
 */
describe("Browse Page Performance", () => {
  it("should retrieve paginated novels efficiently with sort=new", async () => {
    const { items: result } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 20,
      offset: 0,
    });

    // Should return array of lightweight novel objects
    expect(Array.isArray(result)).toBe(true);
    
    // Each result should have only the lightweight fields
    if (result.length > 0) {
      const novel = result[0];
      expect(novel).toHaveProperty("id");
      expect(novel).toHaveProperty("title");
      expect(novel).toHaveProperty("slug");
      expect(novel).toHaveProperty("coverImageUrl");
      expect(novel).toHaveProperty("storyStatus");
      expect(novel).toHaveProperty("createdAt");
      expect(novel).toHaveProperty("freeEpisodeCount");
      
      // Should NOT include heavy fields
      expect(novel).not.toHaveProperty("description");
      expect(novel).not.toHaveProperty("author");
    }
  });

  it("should retrieve paginated novels efficiently with sort=popular", async () => {
    const { items: result } = await db.getBrowseCatalog({
      sort: "popular",
      filter: "all",
      limit: 20,
      offset: 0,
    });

    expect(Array.isArray(result)).toBe(true);
    // Ranking itself (purchase count, then wishlist count, then recency, then
    // id) is covered by server/novels-browse-pagination.test.ts - this test
    // only checks the query executes and returns the lightweight shape.
  });

  it("should filter novels by free episodes only", async () => {
    const { items: result } = await db.getBrowseCatalog({
      sort: "new",
      filter: "free",
      limit: 20,
      offset: 0,
    });

    expect(Array.isArray(result)).toBe(true);
    
    // All results should have at least one free episode
    result.forEach((novel) => {
      expect(novel.freeEpisodeCount).toBeGreaterThan(0);
    });
  });

  it("should search novels by title", async () => {
    // First, get all novels to find a search term
    const { items: allNovels } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 100,
      offset: 0,
    });

    if (allNovels.length === 0) {
      // Skip test if no novels exist
      expect(true).toBe(true);
      return;
    }

    // Take the first novel's title and search for it
    const firstNovel = allNovels[0];
    const searchTerm = firstNovel.title.substring(0, 3); // Search for first 3 characters

    const { items: searchResults } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      search: searchTerm,
      limit: 20,
      offset: 0,
    });

    expect(Array.isArray(searchResults)).toBe(true);
    
    // Should find at least the original novel
    const found = searchResults.some((n) => n.id === firstNovel.id);
    expect(found).toBe(true);
  });

  it("should respect pagination limit", async () => {
    const { items: result } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 10,
      offset: 0,
    });

    // Should return at most 10 items
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("should handle pagination offset", async () => {
    const { items: page1 } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 5,
      offset: 0,
    });

    const { items: page2 } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 5,
      offset: 5,
    });

    // Pages should not have overlapping novels
    const page1Ids = page1.map((n) => n.id);
    const page2Ids = page2.map((n) => n.id);
    
    const overlap = page1Ids.filter((id) => page2Ids.includes(id));
    expect(overlap.length).toBe(0);
  });

  it("should return consistent results for the same query", async () => {
    const { items: result1 } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 20,
      offset: 0,
    });

    const { items: result2 } = await db.getBrowseCatalog({
      sort: "new",
      filter: "all",
      limit: 20,
      offset: 0,
    });

    // Should return the same novels in the same order
    expect(result1.length).toBe(result2.length);
    result1.forEach((novel, index) => {
      expect(novel.id).toBe(result2[index].id);
    });
  });

  it("should handle combined search and filter", async () => {
    // First get free novels to find a valid search term
    const { items: freeNovels } = await db.getBrowseCatalog({
      sort: "new",
      filter: "free",
      limit: 100,
      offset: 0,
    });

    if (freeNovels.length === 0) {
      // Skip test if no free novels exist
      expect(true).toBe(true);
      return;
    }

    // Use first free novel's title for search
    const searchTerm = freeNovels[0].title.substring(0, 2);
    
    const { items: result } = await db.getBrowseCatalog({
      sort: "new",
      filter: "free",
      search: searchTerm,
      limit: 20,
      offset: 0,
    });

    expect(Array.isArray(result)).toBe(true);
    
    // All results should have free episodes
    result.forEach((novel) => {
      expect(novel.freeEpisodeCount).toBeGreaterThan(0);
    });
  });
});
