import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import { getDb } from "./db";
import {
  novels,
  episodes,
  orders,
  orderItems,
  payments,
  wishlists,
  users,
} from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Top Selling Novels Analytics - Regression Tests", () => {
  let testUserId: number;
  let testNovelId: number;
  let testEpisodeId: number;

  beforeAll(async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create test user
    const userResult = await database.insert(users).values({
      openId: `test-user-${Date.now()}`,
      name: "Test User",
    });
    testUserId = (userResult as any).insertId;

    // Create test novel using db helper (returns { id })
    const novelCreated = await db.createNovel({
      title: `Test Novel ${Date.now()}`,
      author: "Test Author",
    });
    testNovelId = novelCreated.id;

    // Create test episodes
    const episodeResult = await database.insert(episodes).values({
      novelId: testNovelId,
      episodeNumber: 1,
      title: "Episode 1",
      content: "Test content",
    });
    testEpisodeId = (episodeResult as any).insertId;
  });

  afterAll(async () => {
    // Cleanup is handled by test isolation
  });

  it("Case 1: One novel with 2 approved orderItems (30.00 total) and 3 wishlist rows should not multiply revenue", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create order with 2 items totaling 30.00
    const orderResult = await database.insert(orders).values({
      orderNumber: `TEST-CASE1-${Date.now()}`,
      userId: testUserId,
      subtotal: "30.00",
      totalAmount: "30.00",
      status: "approved",
      paymentStatus: "approved",
    });
    const orderId = (orderResult as any).insertId;

    // Create 2 orderItems
    await database.insert(orderItems).values([
      {
        orderId,
        novelId: testNovelId,
        episodeId: testEpisodeId,
        unitPrice: "15.00",
        finalPrice: "15.00",
      },
      {
        orderId,
        novelId: testNovelId,
        episodeId: testEpisodeId + 1,
        unitPrice: "15.00",
        finalPrice: "15.00",
      },
    ]);

    // Create payment
    await database.insert(payments).values({
      orderId,
      status: "approved",
    });

    // Create 3 wishlist entries for same novel
    await database.insert(wishlists).values([
      { userId: testUserId, novelId: testNovelId },
      { userId: testUserId + 1, novelId: testNovelId },
      { userId: testUserId + 2, novelId: testNovelId },
    ]);

    // Query should show revenue = 30.00, NOT 30.00 * 3 = 90.00
    const results = await db.getTopSellingNovels("all", 100);
    const novelResult = results.find((r) => r.novelId === testNovelId);

    expect(novelResult).toBeDefined();
    expect(novelResult?.totalRevenue).toBe(30.0);
    expect(novelResult?.purchaseCount).toBe(2); // 2 orderItems
    expect(novelResult?.wishlistCount).toBe(3); // 3 wishlist entries

    // Cleanup
    await database.delete(wishlists).where(eq(wishlists.novelId, testNovelId));
    await database.delete(orderItems).where(eq(orderItems.orderId, orderId));
    await database.delete(payments).where(eq(payments.orderId, orderId));
    await database.delete(orders).where(eq(orders.id, orderId));
  });

  it("Case 2: Multiple purchases + wishlist rows should not inflate counts", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create 2 separate orders for same novel
    const orders1 = await database.insert(orders).values({
      orderNumber: `TEST-CASE2A-${Date.now()}`,
      userId: testUserId,
      subtotal: "20.00",
      totalAmount: "20.00",
      status: "approved",
      paymentStatus: "approved",
    });
    const orderId1 = (orders1 as any).insertId;

    const orders2 = await database.insert(orders).values({
      orderNumber: `TEST-CASE2B-${Date.now()}`,
      userId: testUserId,
      subtotal: "25.00",
      totalAmount: "25.00",
      status: "approved",
      paymentStatus: "approved",
    });
    const orderId2 = (orders2 as any).insertId;

    // Create orderItems for both orders
    await database.insert(orderItems).values([
      {
        orderId: orderId1,
        novelId: testNovelId,
        episodeId: testEpisodeId,
        unitPrice: "20.00",
        finalPrice: "20.00",
      },
      {
        orderId: orderId2,
        novelId: testNovelId,
        episodeId: testEpisodeId + 1,
        unitPrice: "25.00",
        finalPrice: "25.00",
      },
    ]);

    // Create payments
    await database.insert(payments).values([
      { orderId: orderId1, status: "approved" },
      { orderId: orderId2, status: "approved" },
    ]);

    // Create 2 wishlist entries
    await database.insert(wishlists).values([
      { userId: testUserId, novelId: testNovelId },
      { userId: testUserId + 1, novelId: testNovelId },
    ]);

    const results = await db.getTopSellingNovels("all", 100);
    const novelResult = results.find((r) => r.novelId === testNovelId);

    expect(novelResult).toBeDefined();
    expect(novelResult?.totalRevenue).toBe(45.0); // 20 + 25, not multiplied
    expect(novelResult?.purchaseCount).toBe(2); // 2 orderItems
    expect(novelResult?.wishlistCount).toBe(2); // 2 distinct wishlist users

    // Cleanup
    await database.delete(wishlists).where(eq(wishlists.novelId, testNovelId));
    await database.delete(orderItems).where(eq(orderItems.orderId, orderId1));
    await database.delete(orderItems).where(eq(orderItems.orderId, orderId2));
    await database.delete(payments).where(eq(payments.orderId, orderId1));
    await database.delete(payments).where(eq(payments.orderId, orderId2));
    await database.delete(orders).where(eq(orders.id, orderId1));
    await database.delete(orders).where(eq(orders.id, orderId2));
  });

  it("Case 3: Period filter should only count orders within selected period", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create old order (before today)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);

    const oldOrderResult = await database.insert(orders).values({
      orderNumber: `TEST-CASE3-OLD-${Date.now()}`,
      userId: testUserId,
      subtotal: "50.00",
      totalAmount: "50.00",
      status: "approved",
      paymentStatus: "approved",
      createdAt: oldDate,
    });
    const oldOrderId = (oldOrderResult as any).insertId;

    // Create today's order
    const todayOrderResult = await database.insert(orders).values({
      orderNumber: `TEST-CASE3-TODAY-${Date.now()}`,
      userId: testUserId,
      subtotal: "30.00",
      totalAmount: "30.00",
      status: "approved",
      paymentStatus: "approved",
    });
    const todayOrderId = (todayOrderResult as any).insertId;

    // Add orderItems
    await database.insert(orderItems).values([
      {
        orderId: oldOrderId,
        novelId: testNovelId,
        episodeId: testEpisodeId,
        unitPrice: "50.00",
        finalPrice: "50.00",
      },
      {
        orderId: todayOrderId,
        novelId: testNovelId,
        episodeId: testEpisodeId + 1,
        unitPrice: "30.00",
        finalPrice: "30.00",
      },
    ]);

    // Add payments
    await database.insert(payments).values([
      { orderId: oldOrderId, status: "approved" },
      { orderId: todayOrderId, status: "approved" },
    ]);

    // Query for today only
    const todayResults = await db.getTopSellingNovels("today", 100);
    const todayNovelResult = todayResults.find((r) => r.novelId === testNovelId);

    // Should only count today's order (30.00)
    expect(todayNovelResult?.totalRevenue).toBe(30.0);
    expect(todayNovelResult?.purchaseCount).toBe(1);

    // Query for all time
    const allResults = await db.getTopSellingNovels("all", 100);
    const allNovelResult = allResults.find((r) => r.novelId === testNovelId);

    // Should count both (50 + 30 = 80)
    expect(allNovelResult?.totalRevenue).toBe(80.0);
    expect(allNovelResult?.purchaseCount).toBe(2);

    // Cleanup
    await database.delete(orderItems).where(eq(orderItems.orderId, oldOrderId));
    await database.delete(orderItems).where(eq(orderItems.orderId, todayOrderId));
    await database.delete(payments).where(eq(payments.orderId, oldOrderId));
    await database.delete(payments).where(eq(payments.orderId, todayOrderId));
    await database.delete(orders).where(eq(orders.id, oldOrderId));
    await database.delete(orders).where(eq(orders.id, todayOrderId));
  });

  it("Case 4: Aggregated stats should exactly match real approved orderItems", async () => {
    const database = await getDb();
    if (!database) throw new Error("Database not available");

    // Create 3 approved orders with different amounts
    const orderIds: number[] = [];
    const amounts = [10.0, 20.0, 15.0];

    for (let i = 0; i < 3; i++) {
      const orderResult = await database.insert(orders).values({
        orderNumber: `TEST-CASE4-${i}-${Date.now()}`,
        userId: testUserId,
        subtotal: amounts[i].toString(),
        totalAmount: amounts[i].toString(),
        status: "approved",
        paymentStatus: "approved",
      });
      orderIds.push((orderResult as any).insertId);
    }

    // Create orderItems
    for (let i = 0; i < 3; i++) {
      await database.insert(orderItems).values({
        orderId: orderIds[i],
        novelId: testNovelId,
        episodeId: testEpisodeId + i,
        unitPrice: amounts[i].toString(),
        finalPrice: amounts[i].toString(),
      });
    }

    // Create payments
    for (let i = 0; i < 3; i++) {
      await database.insert(payments).values({
        orderId: orderIds[i],
        status: "approved",
      });
    }

    // Get stats
    const stats = await db.getTopSellingNovelsStats("all");

    // Total revenue should be 10 + 20 + 15 = 45
    expect(stats.totalRevenue).toBe(45.0);
    // Total purchases should be 3 (3 orderItems)
    expect(stats.totalPurchases).toBe(3);
    // Novel count should include our test novel
    expect(stats.novelCount).toBeGreaterThanOrEqual(1);

    // Cleanup
    for (const orderId of orderIds) {
      await database.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await database.delete(payments).where(eq(payments.orderId, orderId));
      await database.delete(orders).where(eq(orders.id, orderId));
    }
  });

  // Original tests
  it("should return top selling novels with correct structure", async () => {
    const result = await db.getTopSellingNovels("all", 20);

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);

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

      expect(typeof topNovel.rank).toBe("number");
      expect(typeof topNovel.novelId).toBe("number");
      expect(typeof topNovel.novelTitle).toBe("string");
      expect(typeof topNovel.totalRevenue).toBe("number");
      expect(typeof topNovel.purchaseCount).toBe("number");
      expect(typeof topNovel.soldEpisodesCount).toBe("number");
      expect(typeof topNovel.wishlistCount).toBe("number");

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

    expect(statsAll).toHaveProperty("totalRevenue");
    expect(statsToday).toHaveProperty("totalRevenue");
    expect(stats7d).toHaveProperty("totalRevenue");
    expect(statsMonth).toHaveProperty("totalRevenue");
  });
});
