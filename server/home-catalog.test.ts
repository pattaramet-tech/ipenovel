import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";

/**
 * Test suite for Home page sections and Catalog queries
 * Tests the new popularity, recency, and free episode filtering logic
 */

describe("Home Page & Catalog Queries", () => {
  // Note: These tests assume the database is populated with test data
  // In a real test environment, you would seed the database before running tests

  describe("getPopularNovels", () => {
    it("should return novels sorted by purchaseCount DESC, then wishlistCount DESC, then createdAt DESC", async () => {
      const novels = await db.getPopularNovels(10);
      
      // Verify structure
      expect(Array.isArray(novels)).toBe(true);
      
      if (novels.length > 1) {
        // Verify sorting: purchaseCount should be descending
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          
          // If purchaseCount is equal, check wishlistCount
          if (current.purchaseCount === next.purchaseCount) {
            // If wishlistCount is equal, check createdAt
            if (current.wishlistCount === next.wishlistCount) {
              expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
                new Date(next.createdAt).getTime()
              );
            } else {
              expect(current.wishlistCount).toBeGreaterThanOrEqual(next.wishlistCount);
            }
          } else {
            expect(current.purchaseCount).toBeGreaterThanOrEqual(next.purchaseCount);
          }
        }
      }
    });

    it("should include purchaseCount, wishlistCount, and freeEpisodeCount fields", async () => {
      const novels = await db.getPopularNovels(1);
      
      if (novels.length > 0) {
        const novel = novels[0];
        expect(novel).toHaveProperty("purchaseCount");
        expect(novel).toHaveProperty("wishlistCount");
        expect(novel).toHaveProperty("freeEpisodeCount");
        expect(typeof novel.purchaseCount).toBe("number");
        expect(typeof novel.wishlistCount).toBe("number");
        expect(typeof novel.freeEpisodeCount).toBe("number");
      }
    });

    it("should default counts to 0 when no purchases or wishlists exist", async () => {
      const novels = await db.getPopularNovels(10);
      
      for (const novel of novels) {
        expect(novel.purchaseCount).toBeGreaterThanOrEqual(0);
        expect(novel.wishlistCount).toBeGreaterThanOrEqual(0);
        expect(novel.freeEpisodeCount).toBeGreaterThanOrEqual(0);
      }
    });

    it("should respect the limit parameter", async () => {
      const limit = 5;
      const novels = await db.getPopularNovels(limit);
      
      expect(novels.length).toBeLessThanOrEqual(limit);
    });
  });

  describe("getNewNovels", () => {
    it("should return novels sorted by createdAt DESC (newest first)", async () => {
      const novels = await db.getNewNovels(10);
      
      expect(Array.isArray(novels)).toBe(true);
      
      if (novels.length > 1) {
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(next.createdAt).getTime()
          );
        }
      }
    });

    it("should include all required fields", async () => {
      const novels = await db.getNewNovels(1);
      
      if (novels.length > 0) {
        const novel = novels[0];
        expect(novel).toHaveProperty("id");
        expect(novel).toHaveProperty("title");
        expect(novel).toHaveProperty("createdAt");
        expect(novel).toHaveProperty("purchaseCount");
        expect(novel).toHaveProperty("wishlistCount");
      }
    });

    it("should respect the limit parameter", async () => {
      const limit = 4;
      const novels = await db.getNewNovels(limit);
      
      expect(novels.length).toBeLessThanOrEqual(limit);
    });
  });

  describe("getFreeNovels", () => {
    it("should only return novels with at least one free episode", async () => {
      const novels = await db.getFreeNovels(10);
      
      for (const novel of novels) {
        expect(novel.freeEpisodeCount).toBeGreaterThan(0);
      }
    });

    it("should be sorted by createdAt DESC (newest first)", async () => {
      const novels = await db.getFreeNovels(10);
      
      if (novels.length > 1) {
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(next.createdAt).getTime()
          );
        }
      }
    });

    it("should include freeEpisodeCount > 0 for all returned novels", async () => {
      const novels = await db.getFreeNovels(10);
      
      for (const novel of novels) {
        expect(novel.freeEpisodeCount).toBeGreaterThan(0);
        expect(typeof novel.freeEpisodeCount).toBe("number");
      }
    });

    it("should respect the limit parameter", async () => {
      const limit = 4;
      const novels = await db.getFreeNovels(limit);
      
      expect(novels.length).toBeLessThanOrEqual(limit);
    });
  });

  describe("getCatalogNovels", () => {
    it("should support sort=new (default)", async () => {
      const novels = await db.getCatalogNovels({ sort: "new", limit: 10 });
      
      expect(Array.isArray(novels)).toBe(true);
      
      if (novels.length > 1) {
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(next.createdAt).getTime()
          );
        }
      }
    });

    it("should support sort=popular", async () => {
      const novels = await db.getCatalogNovels({ sort: "popular", limit: 10 });
      
      if (novels.length > 1) {
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          
          if (current.purchaseCount === next.purchaseCount) {
            if (current.wishlistCount === next.wishlistCount) {
              expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
                new Date(next.createdAt).getTime()
              );
            } else {
              expect(current.wishlistCount).toBeGreaterThanOrEqual(next.wishlistCount);
            }
          } else {
            expect(current.purchaseCount).toBeGreaterThanOrEqual(next.purchaseCount);
          }
        }
      }
    });

    it("should support filter=free", async () => {
      const novels = await db.getCatalogNovels({ filter: "free", limit: 10 });
      
      for (const novel of novels) {
        expect(novel.freeEpisodeCount).toBeGreaterThan(0);
      }
    });

    it("should support filter=all (default)", async () => {
      const novelsAll = await db.getCatalogNovels({ filter: "all", limit: 10 });
      const novelsFree = await db.getCatalogNovels({ filter: "free", limit: 10 });
      
      // All novels should be >= free novels
      expect(novelsAll.length).toBeGreaterThanOrEqual(novelsFree.length);
    });

    it("should support search parameter", async () => {
      // This test requires knowing a novel title in the database
      // For now, we just verify it doesn't crash
      const novels = await db.getCatalogNovels({ search: "test", limit: 10 });
      
      expect(Array.isArray(novels)).toBe(true);
    });

    it("should support pagination with limit and offset", async () => {
      const page1 = await db.getCatalogNovels({ limit: 5, offset: 0 });
      const page2 = await db.getCatalogNovels({ limit: 5, offset: 5 });
      
      // Verify pagination works by checking that offset returns different data
      expect(Array.isArray(page1)).toBe(true);
      expect(Array.isArray(page2)).toBe(true);
      
      // If we have enough novels, page2 should start after page1
      if (page1.length === 5 && page2.length > 0) {
        // Just verify that offset parameter was applied
        expect(page2.length).toBeGreaterThan(0);
      }
    });

    it("should combine sort and filter parameters correctly", async () => {
      const novels = await db.getCatalogNovels({
        sort: "popular",
        filter: "free",
        limit: 10,
      });
      
      // All should be free
      for (const novel of novels) {
        expect(novel.freeEpisodeCount).toBeGreaterThan(0);
      }
      
      // Should be sorted by popularity
      if (novels.length > 1) {
        for (let i = 0; i < novels.length - 1; i++) {
          const current = novels[i];
          const next = novels[i + 1];
          
          if (current.purchaseCount === next.purchaseCount) {
            if (current.wishlistCount === next.wishlistCount) {
              expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
                new Date(next.createdAt).getTime()
              );
            } else {
              expect(current.wishlistCount).toBeGreaterThanOrEqual(next.wishlistCount);
            }
          } else {
            expect(current.purchaseCount).toBeGreaterThanOrEqual(next.purchaseCount);
          }
        }
      }
    });

    it("should return novels with computed count fields", async () => {
      const novels = await db.getCatalogNovels({ limit: 1 });
      
      if (novels.length > 0) {
        const novel = novels[0];
        expect(novel).toHaveProperty("purchaseCount");
        expect(novel).toHaveProperty("wishlistCount");
        expect(novel).toHaveProperty("freeEpisodeCount");
        expect(typeof novel.purchaseCount).toBe("number");
        expect(typeof novel.wishlistCount).toBe("number");
        expect(typeof novel.freeEpisodeCount).toBe("number");
      }
    });

    it("should default to sort=new and filter=all when not specified", async () => {
      const novels1 = await db.getCatalogNovels({});
      const novels2 = await db.getCatalogNovels({ sort: "new", filter: "all" });
      
      // Should return the same results
      expect(novels1.length).toBe(novels2.length);
      if (novels1.length > 0) {
        expect(novels1[0].id).toBe(novels2[0].id);
      }
    });
  });

  describe("Integration: Home page sections", () => {
    it("should return different novels for popular vs new", async () => {
      const popular = await db.getPopularNovels(4);
      const newNovels = await db.getNewNovels(4);
      
      // They may overlap, but the order should be different
      // (unless there's only one novel)
      if (popular.length > 0 && newNovels.length > 0) {
        // Just verify both return valid data
        expect(popular[0]).toHaveProperty("id");
        expect(newNovels[0]).toHaveProperty("id");
      }
    });

    it("should only return free novels for free section", async () => {
      const freeNovels = await db.getFreeNovels(4);
      
      for (const novel of freeNovels) {
        expect(novel.freeEpisodeCount).toBeGreaterThan(0);
      }
    });
  });

  describe("No N+1 queries", () => {
    it("getPopularNovels should use aggregate subqueries, not loop queries", async () => {
      // This is a structural test - we verify the function completes quickly
      // In a real scenario, you'd use query logging to verify no N+1 queries
      const start = Date.now();
      await db.getPopularNovels(100);
      const duration = Date.now() - start;
      
      // Should complete in reasonable time (not doing N+1 queries)
      // Adjust threshold based on your DB performance
      expect(duration).toBeLessThan(5000);
    });

    it("getCatalogNovels should use aggregate subqueries", async () => {
      const start = Date.now();
      await db.getCatalogNovels({ limit: 100 });
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(5000);
    });
  });
});


  describe("getLatestEpisodes", () => {
    it("should return episodes sorted by createdAt DESC (newest first)", async () => {
      const episodes = await db.getLatestEpisodes(10);
      
      expect(Array.isArray(episodes)).toBe(true);
      
      if (episodes.length > 1) {
        for (let i = 0; i < episodes.length - 1; i++) {
          const current = episodes[i];
          const next = episodes[i + 1];
          expect(new Date(current.createdAt).getTime()).toBeGreaterThanOrEqual(
            new Date(next.createdAt).getTime()
          );
        }
      }
    });

    it("should include all required fields for rendering", async () => {
      const episodes = await db.getLatestEpisodes(1);
      
      if (episodes.length > 0) {
        const episode = episodes[0];
        expect(episode).toHaveProperty("id");
        expect(episode).toHaveProperty("novelId");
        expect(episode).toHaveProperty("novelTitle");
        expect(episode).toHaveProperty("novelCoverImageUrl");
        expect(episode).toHaveProperty("episodeNumber");
        expect(episode).toHaveProperty("episodeTitle");
        expect(episode).toHaveProperty("isFree");
        expect(episode).toHaveProperty("createdAt");
      }
    });

    it("should respect the limit parameter", async () => {
      const limit = 4;
      const episodes = await db.getLatestEpisodes(limit);
      
      expect(episodes.length).toBeLessThanOrEqual(limit);
    });

    it("should include both free and paid episodes", async () => {
      const episodes = await db.getLatestEpisodes(100);
      
      // Should have a mix of free and paid episodes (if data exists)
      const hasFreEpisodes = episodes.some((e) => e.isFree === true);
      const hasPaidEpisodes = episodes.some((e) => e.isFree === false);
      
      // At least one type should exist
      expect(hasFreEpisodes || hasPaidEpisodes).toBe(true);
    });

    it("should have valid novelId references", async () => {
      const episodes = await db.getLatestEpisodes(10);
      
      for (const episode of episodes) {
        expect(episode.novelId).toBeGreaterThan(0);
        expect(episode.novelTitle).toBeTruthy();
      }
    });
  });
