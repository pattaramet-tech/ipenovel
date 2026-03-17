import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Top Selling Novels Analytics", () => {
  it("should return top selling novels with correct structure", async () => {
    const result = await db.getTopSellingNovels("all", 20);
    
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    
    // Check structure of results if any exist
    if (result.length > 0) {
      const topNovel = result[0];
      expect(topNovel).toHaveProperty("rank");
      expect(topNovel).toHaveProperty("novelId");
      expect(topNovel).toHaveProperty("novelTitle");
      expect(topNovel).toHaveProperty("coverImageUrl");
      expect(topNovel).toHaveProperty("totalRevenue");
      expect(topNovel).toHaveProperty("purchaseCount");
      expect(topNovel).toHaveProperty("soldEpisodesCount");
      expect(topNovel).toHaveProperty("wishlistCount");
      expect(topNovel).toHaveProperty("createdAt");
      
      // Verify types
      expect(typeof topNovel.rank).toBe("number");
      expect(typeof topNovel.novelId).toBe("number");
      expect(typeof topNovel.novelTitle).toBe("string");
      expect(typeof topNovel.totalRevenue).toBe("number");
      expect(typeof topNovel.purchaseCount).toBe("number");
      expect(typeof topNovel.soldEpisodesCount).toBe("number");
      expect(typeof topNovel.wishlistCount).toBe("number");
      
      // Verify ranking starts at 1
      expect(topNovel.rank).toBe(1);
    }
  });

  it("should filter by time period", async () => {
    const allTime = await db.getTopSellingNovels("all", 20);
    const today = await db.getTopSellingNovels("today", 20);
    const sevenDays = await db.getTopSellingNovels("7d", 20);
    const month = await db.getTopSellingNovels("month", 20);
    
    expect(allTime).toBeDefined();
    expect(today).toBeDefined();
    expect(sevenDays).toBeDefined();
    expect(month).toBeDefined();
    
    // All should be arrays
    expect(Array.isArray(allTime)).toBe(true);
    expect(Array.isArray(today)).toBe(true);
    expect(Array.isArray(sevenDays)).toBe(true);
    expect(Array.isArray(month)).toBe(true);
  });

  it("should return stats with correct structure", async () => {
    const stats = await db.getTopSellingNovelsStats("all");
    
    expect(stats).toBeDefined();
    expect(stats).toHaveProperty("totalRevenue");
    expect(stats).toHaveProperty("totalPurchases");
    expect(stats).toHaveProperty("novelCount");
    
    expect(typeof stats.totalRevenue).toBe("number");
    expect(typeof stats.totalPurchases).toBe("number");
    expect(typeof stats.novelCount).toBe("number");
    
    // Values should be non-negative
    expect(stats.totalRevenue).toBeGreaterThanOrEqual(0);
    expect(stats.totalPurchases).toBeGreaterThanOrEqual(0);
    expect(stats.novelCount).toBeGreaterThanOrEqual(0);
  });

  it("should respect limit parameter", async () => {
    const result5 = await db.getTopSellingNovels("all", 5);
    const result20 = await db.getTopSellingNovels("all", 20);
    const result100 = await db.getTopSellingNovels("all", 100);
    
    expect(result5.length).toBeLessThanOrEqual(5);
    expect(result20.length).toBeLessThanOrEqual(20);
    expect(result100.length).toBeLessThanOrEqual(100);
  });

  it("should return stats for different time periods", async () => {
    const statsAll = await db.getTopSellingNovelsStats("all");
    const statsToday = await db.getTopSellingNovelsStats("today");
    const stats7d = await db.getTopSellingNovelsStats("7d");
    const statsMonth = await db.getTopSellingNovelsStats("month");
    
    // All should return valid stats objects
    expect(statsAll).toHaveProperty("totalRevenue");
    expect(statsToday).toHaveProperty("totalRevenue");
    expect(stats7d).toHaveProperty("totalRevenue");
    expect(statsMonth).toHaveProperty("totalRevenue");
  });
});
