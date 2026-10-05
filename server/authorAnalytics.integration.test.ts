import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import {
  users,
  novels,
  episodes,
  orders,
  orderItems,
  payments,
  episodePurchases,
  wishlists,
} from "../drizzle/schema";

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

function adminContext(id: number, name: string): TrpcContext {
  return {
    user: {
      id,
      openId: `ipe063-admin-${id}`,
      email: `ipe063-admin-${id}@example.test`,
      name,
      loginMethod: "test",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("IPE-063 Author Analysis integration", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 12);
  let authorAId = 0;
  let authorBId = 0;
  let buyerId = 0;
  // IPE-064/063: hoisted to describe scope — test 2 asserts B-owned novels
  // are untouched by the rename propagation.
  let novelBId = 0;
  const novelIds: number[] = [];
  const episodeIds: number[] = [];
  const orderIds: number[] = [];
  const orderItemIds: number[] = [];
  const paymentIds: number[] = [];
  const walletPurchaseIds: number[] = [];
  const wishlistIds: number[] = [];

  beforeAll(async () => {
    authorAId = insertId(await db.insert(users).values({
      openId: `ipe063-author-a-${tag}`,
      name: "Author A",
      email: `author-a-${tag}@example.test`,
      loginMethod: "test",
      role: "admin",
    }));
    authorBId = insertId(await db.insert(users).values({
      openId: `ipe063-author-b-${tag}`,
      name: "Author B",
      email: `author-b-${tag}@example.test`,
      loginMethod: "test",
      role: "admin",
    }));
    buyerId = insertId(await db.insert(users).values({
      openId: `ipe063-buyer-${tag}`,
      name: "Reader",
      email: `buyer-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
  });

  afterAll(async () => {
    if (walletPurchaseIds.length) {
      await db.delete(episodePurchases).where(inArray(episodePurchases.id, walletPurchaseIds));
    }
    if (wishlistIds.length) {
      await db.delete(wishlists).where(inArray(wishlists.id, wishlistIds));
    }
    if (paymentIds.length) {
      await db.delete(payments).where(inArray(payments.id, paymentIds));
    }
    if (orderItemIds.length) {
      await db.delete(orderItems).where(inArray(orderItems.id, orderItemIds));
    }
    if (orderIds.length) {
      await db.delete(orders).where(inArray(orders.id, orderIds));
    }
    if (episodeIds.length) {
      await db.delete(episodes).where(inArray(episodes.id, episodeIds));
    }
    if (novelIds.length) {
      await db.delete(novels).where(inArray(novels.id, novelIds));
    }
    const userIds = [authorAId, authorBId, buyerId].filter(Boolean);
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  async function createOwnedNovel(authorUserId: number, author: string, suffix: string) {
    const result = await db.insert(novels).values({
      title: `IPE063 ${suffix} ${tag}`,
      slug: `ipe063-${suffix.toLowerCase()}-${tag}`,
      author,
      authorUserId,
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
    const id = insertId(result);
    novelIds.push(id);
    return id;
  }

  async function createEpisode(novelId: number, suffix: string) {
    const result = await db.insert(episodes).values({
      novelId,
      episodeNumber: `ipe063-${suffix}-${tag}`,
      title: `Episode ${suffix}`,
      price: "100.00",
      isFree: false,
      isPublished: true,
      saleMode: "chapter",
    });
    const id = insertId(result);
    episodeIds.push(id);
    return id;
  }

  async function createApprovedOrderSale(
    novelId: number,
    episodeId: number,
    amount: string,
    suffix: string,
    amounts?: { subtotal: string; discountAmount: string; totalAmount: string }
  ) {
    const orderResult = await db.insert(orders).values({
      orderNumber: `IPE063-${suffix}-${tag}`,
      userId: buyerId,
      subtotal: amounts?.subtotal ?? amount,
      discountAmount: amounts?.discountAmount ?? "0.00",
      totalAmount: amounts?.totalAmount ?? amount,
      status: "approved",
      paymentStatus: "approved",
    });
    const orderId = insertId(orderResult);
    orderIds.push(orderId);

    const itemResult = await db.insert(orderItems).values({
      orderId,
      novelId,
      episodeId,
      unitPrice: amount,
      finalPrice: amount,
    });
    orderItemIds.push(insertId(itemResult));

    const paymentResult = await db.insert(payments).values({
      orderId,
      status: "approved",
      ocrConfidence: 100,
      ocrDecision: "auto_approved",
      approvalSource: "manual",
    });
    paymentIds.push(insertId(paymentResult));
  }

  it("isolates each admin Author and combines approved-order plus wallet-direct sales", async () => {
    const novelA = await createOwnedNovel(authorAId, "Author A", "A");
    // IPE-063R7: describe-scope so the pen-name propagation test below can
    // assert B-owned novels are untouched (P2, exact-head review a42c647).
    novelBId = await createOwnedNovel(authorBId, "Author B", "B");
    const legacyResult = await db.insert(novels).values({
      title: `IPE063 Legacy ${tag}`,
      slug: `ipe063-legacy-${tag}`,
      author: "Author A",
      authorUserId: null,
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
    const legacyNovelId = insertId(legacyResult);
    novelIds.push(legacyNovelId);

    const aOrderEpisode = await createEpisode(novelA, "a-order");
    const aWalletEpisode = await createEpisode(novelA, "a-wallet");
    const bOrderEpisode = await createEpisode(novelBId, "b-order");

    await createApprovedOrderSale(novelA, aOrderEpisode, "120.00", "AORDER");
    await createApprovedOrderSale(novelBId, bOrderEpisode, "999.00", "BORDER");
    // IPE-063R7 regression: an order-level coupon discount lives on the
    // header (subtotal 200 → paid 150) while the line stays gross — the
    // author's revenue must include only the allocated 150, not 200.
    const bDiscountedEpisode = await createEpisode(novelBId, "b-discount");
    await createApprovedOrderSale(novelBId, bDiscountedEpisode, "200.00", "BDISC", {
      subtotal: "200.00",
      discountAmount: "50.00",
      totalAmount: "150.00",
    });

    const walletResult = await db.insert(episodePurchases).values({
      userId: buyerId,
      novelId: novelA,
      episodeId: aWalletEpisode,
      pricePaid: "30.00",
    });
    walletPurchaseIds.push(insertId(walletResult));

    const wishlistA = await db.insert(wishlists).values({ userId: buyerId, novelId: novelA });
    wishlistIds.push(insertId(wishlistA));
    const wishlistB = await db.insert(wishlists).values({ userId: buyerId, novelId: novelBId });
    wishlistIds.push(insertId(wishlistB));

    const callerA = appRouter.createCaller(adminContext(authorAId, "Author A"));
    const resultA = await callerA.admin.authorAnalytics.summary({ period: "all" });

    expect(resultA.author).toEqual({ userId: authorAId, displayName: "Author A" });
    expect(resultA.totalNovels).toBe(1);
    expect(resultA.totalRevenue).toBe(150);
    expect(resultA.totalPurchases).toBe(2);
    expect(resultA.currentWishlistCount).toBe(1);
    expect(resultA.salesChannels).toEqual({
      orderRevenue: 120,
      walletRevenue: 30,
      orderPurchases: 1,
      walletPurchases: 1,
    });
    expect(resultA.novels).toHaveLength(1);
    expect(resultA.novels[0]).toMatchObject({
      novelId: novelA,
      author: "Author A",
      revenue: 150,
      purchases: 2,
      currentWishlistCount: 1,
    });
    expect(resultA.novels.some((row) => row.novelId === novelBId)).toBe(false);
    expect(resultA.novels.some((row) => row.novelId === legacyNovelId)).toBe(false);

    const callerB = appRouter.createCaller(adminContext(authorBId, "Author B"));
    const resultB = await callerB.admin.authorAnalytics.summary({ period: "all" });
    expect(resultB.totalNovels).toBe(1);
    // 999 gross order + 150 allocated from the discounted 200/150 order —
    // WITHOUT the proportional allocation this would be 1149 + 50 = 1199.
    expect(resultB.totalRevenue).toBe(1149);
    expect(resultB.totalPurchases).toBe(2);
    expect(resultB.currentWishlistCount).toBe(1);
    expect(resultB.novels[0]?.novelId).toBe(novelBId);
  });

  it("IPE-063R1 propagates the pen name to owned novels only and falls back on clear", async () => {
    // A owns one more novel; a legacy novel keeps authorUserId = NULL.
    const ownedNovel = await createOwnedNovel(authorAId, "Old Pen Name", "Rename");
    const legacyResult = await db.insert(novels).values({
      title: `IPE063 Legacy Rename ${tag}`,
      slug: `ipe063-legacy-rename-${tag}`,
      author: "Old Pen Name",
      authorUserId: null,
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
    const legacyId = insertId(legacyResult);
    novelIds.push(legacyId);

    const callerA = appRouter.createCaller(adminContext(authorAId, "Author A"));

    // Rename: users.authorName set + every A-owned novel synced.
    const renamed = await callerA.admin.authorProfile.update({
      authorName: "Renamed Pen Name",
    });
    expect(renamed).toMatchObject({
      userId: authorAId,
      authorName: "Renamed Pen Name",
      effectiveAuthorName: "Renamed Pen Name",
    });
    const [userARow] = await db.select().from(users).where(eq(users.id, authorAId));
    expect(userARow.authorName).toBe("Renamed Pen Name");
    const ownedRows = await db
      .select()
      .from(novels)
      .where(eq(novels.authorUserId, authorAId));
    expect(ownedRows.length).toBeGreaterThan(0);
    for (const row of ownedRows) expect(row.author).toBe("Renamed Pen Name");

    // B-owned and legacy novels are untouched.
    const [novelBRow] = await db.select().from(novels).where(eq(novels.id, novelBId));
    expect(novelBRow.authorUserId).toBe(authorBId);
    expect(novelBRow.author).toBe("Author B");
    const [legacyRow] = await db.select().from(novels).where(eq(novels.id, legacyId));
    expect(legacyRow.authorUserId).toBeNull();
    expect(legacyRow.author).toBe("Old Pen Name");

    // Clear: authorName NULL + fallback to the account name across owned novels.
    const cleared = await callerA.admin.authorProfile.update({ authorName: "" });
    expect(cleared).toMatchObject({
      authorName: null,
      effectiveAuthorName: "Author A",
    });
    const ownedRowsAfterClear = await db
      .select()
      .from(novels)
      .where(eq(novels.authorUserId, authorAId));
    for (const row of ownedRowsAfterClear) expect(row.author).toBe("Author A");
    const [legacyAfterClear] = await db.select().from(novels).where(eq(novels.id, legacyId));
    expect(legacyAfterClear.author).toBe("Old Pen Name");
  });
});
