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

// IPE-070: Admin/Author sales by selected date. The fixture pins exact
// instants around Bangkok midnight (UTC+7, no DST): local 2024-01-15
// 00:00 == 2024-01-14T17:00:00Z, so rows can be placed on either side of
// a calendar boundary and the resolved range must sort them identically.

function insertId(result: any): number {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Insert did not return a valid id");
  return id;
}

function contextFor(user: { id: number; role: string; name: string }): TrpcContext {
  return {
    user: {
      id: user.id,
      openId: `ipe070-${user.id}`,
      email: `ipe070-${user.id}@example.test`,
      name: user.name,
      loginMethod: "test",
      role: user.role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const guestCaller = () => appRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as any);

// Bangkok calendar instants used by the fixture.
const bangkok = (isoUtc: string) => new Date(isoUtc);
const DAY15 = "2024-01-15"; // [2024-01-14T17:00Z, 2024-01-15T17:00Z)

describe("IPE-070 Author Sales by selected date", () => {
  const db = getTestDb();
  const tag = randomUUID().replace(/-/g, "").slice(0, 12);
  let adminAId = 0;
  let adminBId = 0;
  let authorCId = 0;
  let plainUserId = 0;
  let buyerId = 0;
  let novelA1Id = 0;
  let novelA2Id = 0;
  let novelB1Id = 0;
  let novelC1Id = 0;
  let novelLegacyId = 0;
  let episodeA1Id = 0;
  let episodeA2Id = 0;
  let episodeB1Id = 0;
  const novelIds: number[] = [];
  const episodeIds: number[] = [];
  const orderIds: number[] = [];
  const orderItemIds: number[] = [];
  const paymentIds: number[] = [];
  const walletPurchaseIds: number[] = [];
  const wishlistIds: number[] = [];

  beforeAll(async () => {
    // A and B deliberately share one pen name — grouping must stay by
    // authorUserId so the two accounts are never merged.
    adminAId = insertId(await db.insert(users).values({
      openId: `ipe070-a-${tag}`,
      name: "Admin A",
      authorName: "Shared Pen",
      email: `a-${tag}@example.test`,
      loginMethod: "test",
      role: "admin",
    }));
    adminBId = insertId(await db.insert(users).values({
      openId: `ipe070-b-${tag}`,
      name: "Admin B",
      authorName: "Shared Pen",
      email: `b-${tag}@example.test`,
      loginMethod: "test",
      role: "admin",
    }));
    authorCId = insertId(await db.insert(users).values({
      openId: `ipe070-c-${tag}`,
      name: "Author C",
      email: `c-${tag}@example.test`,
      loginMethod: "test",
      role: "author",
    }));
    plainUserId = insertId(await db.insert(users).values({
      openId: `ipe070-u-${tag}`,
      name: "Plain User",
      email: `u-${tag}@example.test`,
      loginMethod: "test",
      role: "user",
    }));
    buyerId = insertId(await db.insert(users).values({
      openId: `ipe070-buyer-${tag}`,
      name: "Buyer",
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
    const userIds = [adminAId, adminBId, authorCId, plainUserId, buyerId].filter(Boolean);
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  async function createOwnedNovel(authorUserId: number | null, author: string, suffix: string) {
    const result = await db.insert(novels).values({
      title: `IPE070 ${suffix} ${tag}`,
      slug: `ipe070-${suffix.toLowerCase()}-${tag}`,
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
      episodeNumber: `ipe070-${suffix}-${tag}`,
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

  async function createApprovedOrder(input: {
    lines: Array<{ novelId: number; episodeId: number; amount: string }>;
    subtotal: string;
    totalAmount: string;
    discountAmount?: string;
    createdAt: Date;
    suffix: string;
  }) {
    const orderResult = await db.insert(orders).values({
      orderNumber: `IPE070-${input.suffix}-${tag}`,
      userId: buyerId,
      subtotal: input.subtotal,
      discountAmount: input.discountAmount ?? "0.00",
      totalAmount: input.totalAmount,
      status: "approved",
      paymentStatus: "approved",
      createdAt: input.createdAt,
    });
    const orderId = insertId(orderResult);
    orderIds.push(orderId);
    for (const line of input.lines) {
      const itemResult = await db.insert(orderItems).values({
        orderId,
        novelId: line.novelId,
        episodeId: line.episodeId,
        unitPrice: line.amount,
        finalPrice: line.amount,
      });
      orderItemIds.push(insertId(itemResult));
    }
    const paymentResult = await db.insert(payments).values({
      orderId,
      status: "approved",
      ocrConfidence: 100,
      ocrDecision: "auto_approved",
      approvalSource: "manual",
    });
    paymentIds.push(insertId(paymentResult));
    return orderId;
  }

  async function createWalletPurchase(novelId: number, episodeId: number, pricePaid: string, purchasedAt: Date) {
    const result = await db.insert(episodePurchases).values({
      userId: buyerId,
      novelId,
      episodeId,
      pricePaid,
      purchasedAt,
    });
    walletPurchaseIds.push(insertId(result));
  }

  it("fixtures: two admins, one author, novels, and dated sales", async () => {
    novelA1Id = await createOwnedNovel(adminAId, "Shared Pen", "A1");
    novelA2Id = await createOwnedNovel(adminAId, "Shared Pen", "A2");
    novelB1Id = await createOwnedNovel(adminBId, "Shared Pen", "B1");
    novelC1Id = await createOwnedNovel(authorCId, "Author C", "C1");
    novelLegacyId = await createOwnedNovel(null, "Shared Pen", "Legacy");

    const e1 = await createEpisode(novelA1Id, "e1");
    const e2 = await createEpisode(novelA2Id, "e2");
    const e3 = await createEpisode(novelB1Id, "e3");
    episodeA1Id = e1;
    episodeA2Id = e2;
    episodeB1Id = e3;
    const e4 = await createEpisode(novelC1Id, "e4");
    const eLegacy = await createEpisode(novelLegacyId, "e-legacy");
    const ew1 = await createEpisode(novelA1Id, "ew1");
    const ew3 = await createEpisode(novelB1Id, "ew3");
    const ew4 = await createEpisode(novelC1Id, "ew4");

    // Bangkok 2024-01-15 10:00 — inside DAY15.
    await createApprovedOrder({
      lines: [{ novelId: novelA1Id, episodeId: e1, amount: "100.00" }],
      subtotal: "100.00",
      totalAmount: "100.00",
      createdAt: bangkok("2024-01-15T03:00:00.000Z"),
      suffix: "O1",
    });
    // Bangkok 2024-01-14 23:59:59 — one second BEFORE DAY15 starts.
    await createApprovedOrder({
      lines: [{ novelId: novelA2Id, episodeId: e2, amount: "80.00" }],
      subtotal: "80.00",
      totalAmount: "80.00",
      createdAt: bangkok("2024-01-14T16:59:59.000Z"),
      suffix: "O2",
    });
    // Bangkok 2024-01-15 23:59:59 — inside DAY15, last second.
    await createApprovedOrder({
      lines: [{ novelId: novelB1Id, episodeId: e3, amount: "55.00" }],
      subtotal: "55.00",
      totalAmount: "55.00",
      createdAt: bangkok("2024-01-15T16:59:59.000Z"),
      suffix: "O3",
    });
    // Bangkok 2024-01-16 00:00:00 — exactly the exclusive END of DAY15.
    await createApprovedOrder({
      lines: [{ novelId: novelA1Id, episodeId: e1, amount: "70.00" }],
      subtotal: "70.00",
      totalAmount: "70.00",
      createdAt: bangkok("2024-01-15T17:00:00.000Z"),
      suffix: "O4",
    });
    // Discounted order on B's novel: subtotal 200 → paid 150 (allocated).
    await createApprovedOrder({
      lines: [{ novelId: novelB1Id, episodeId: e3, amount: "200.00" }],
      subtotal: "200.00",
      totalAmount: "150.00",
      createdAt: bangkok("2024-01-15T05:00:00.000Z"),
      suffix: "O5",
    });
    // Zero-subtotal (fully free) order on the LEGACY novel — contributes 0
    // and its ownerlessness keeps it out of every author report.
    await createApprovedOrder({
      lines: [{ novelId: novelLegacyId, episodeId: eLegacy, amount: "0.00" }],
      subtotal: "0.00",
      totalAmount: "0.00",
      createdAt: bangkok("2024-01-15T05:30:00.000Z"),
      suffix: "O6",
    });
    // Multi-line order across two novels of the SAME author: allocation
    // 80/100 per line → 32 + 48, never doubled by the payment join.
    await createApprovedOrder({
      lines: [
        { novelId: novelA1Id, episodeId: e1, amount: "40.00" },
        { novelId: novelA2Id, episodeId: e2, amount: "60.00" },
      ],
      subtotal: "100.00",
      totalAmount: "80.00",
      createdAt: bangkok("2024-01-15T06:00:00.000Z"),
      suffix: "O7",
    });

    await createWalletPurchase(novelA1Id, ew1, "30.00", bangkok("2024-01-15T05:30:00.000Z"));
    await createWalletPurchase(novelB1Id, ew3, "20.00", bangkok("2024-02-29T05:00:00.000Z")); // leap day
    await createWalletPurchase(novelC1Id, ew4, "15.00", bangkok("2024-01-15T05:00:00.000Z"));

    const wishlist = await db.insert(wishlists).values({ userId: buyerId, novelId: novelA1Id });
    wishlistIds.push(insertId(wishlist));

    expect(novelIds).toHaveLength(5);
  });

  it("admin all-authors report on a single Bangkok day: exact rows, shared pen names unmerged", async () => {
    const caller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    const report = await caller.admin.authorSales.authors({ startDate: DAY15, endDate: DAY15 });

    expect(report.dateRange).toEqual({ startDate: DAY15, endDate: DAY15 });
    expect(report.period).toBeNull();

    // Every owner with novels is listed (zero-sales rows included); totals
    // equal the full row set, never a Top-N.
    expect(report.authors).toHaveLength(3); // A, B, C — legacy has no owner
    const rowA = report.authors.find((r: any) => r.authorUserId === adminAId);
    const rowB = report.authors.find((r: any) => r.authorUserId === adminBId);
    const rowC = report.authors.find((r: any) => r.authorUserId === authorCId);

    // A: O1 100 + O7 allocated 32+48 = 180 order revenue; wallet 30.
    expect(rowA).toMatchObject({
      displayName: "Shared Pen",
      novelCount: 2,
      revenue: 210,
      purchases: 4,
      salesChannels: { orderRevenue: 180, walletRevenue: 30, orderPurchases: 3, walletPurchases: 1 },
    });
    // B: O3 55 + O5 allocated 150 = 205; no wallet on DAY15.
    expect(rowB).toMatchObject({
      displayName: "Shared Pen",
      novelCount: 1,
      revenue: 205,
      purchases: 2,
      salesChannels: { orderRevenue: 205, walletRevenue: 0, orderPurchases: 2, walletPurchases: 0 },
    });
    // C: wallet only.
    expect(rowC).toMatchObject({
      displayName: "Author C",
      novelCount: 1,
      revenue: 15,
      purchases: 1,
      salesChannels: { orderRevenue: 0, walletRevenue: 15, orderPurchases: 0, walletPurchases: 1 },
    });

    // Same pen name, two separate owner rows.
    const sharedPenRows = report.authors.filter((r: any) => r.displayName === "Shared Pen");
    expect(sharedPenRows).toHaveLength(2);
    expect(new Set(sharedPenRows.map((r: any) => r.authorUserId).sort())).toEqual(
      new Set([adminAId, adminBId].sort())
    );

    expect(report.totals).toEqual({
      totalAuthors: 3,
      totalNovels: 4, // legacy novel excluded
      totalRevenue: 430,
      totalPurchases: 7,
      salesChannels: { orderRevenue: 385, walletRevenue: 45, orderPurchases: 5, walletPurchases: 2 },
    });

    // Grand totals reconcile with the displayed rows exactly.
    const sumOrder = report.authors.reduce((s: number, r: any) => s + r.salesChannels.orderRevenue, 0);
    const sumWallet = report.authors.reduce((s: number, r: any) => s + r.salesChannels.walletRevenue, 0);
    const sumPurchases = report.authors.reduce((s: number, r: any) => s + r.purchases, 0);
    expect(sumOrder).toBe(report.totals.salesChannels.orderRevenue);
    expect(sumWallet).toBe(report.totals.salesChannels.walletRevenue);
    expect(sumPurchases).toBe(report.totals.totalPurchases);
  });

  it("single-day bounds exclude rows one second outside Bangkok midnight", async () => {
    const caller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    // 2024-01-14: includes O2 (23:59:59 local), excludes everything of DAY15.
    const day14 = await caller.admin.authorSales.authors({ startDate: "2024-01-14", endDate: "2024-01-14" });
    const rowA14 = day14.authors.find((r: any) => r.authorUserId === adminAId);
    expect(rowA14.salesChannels).toEqual({
      orderRevenue: 80, walletRevenue: 0, orderPurchases: 1, walletPurchases: 0,
    });
    // 2024-01-16: includes only O4 (paid exactly at local midnight — start
    // inclusive, previous day's end exclusive).
    const day16 = await caller.admin.authorSales.authors({ startDate: "2024-01-16", endDate: "2024-01-16" });
    const rowA16 = day16.authors.find((r: any) => r.authorUserId === adminAId);
    expect(rowA16.salesChannels).toEqual({
      orderRevenue: 70, walletRevenue: 0, orderPurchases: 1, walletPurchases: 0,
    });
    const rowB16 = day16.authors.find((r: any) => r.authorUserId === adminBId);
    expect(rowB16.revenue).toBe(0);
  });

  it("ranges crossing months and the leap day include their calendar days", async () => {
    const caller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    const leapRange = await caller.admin.authorSales.authors({ startDate: "2024-02-28", endDate: "2024-03-01" });
    const rowB = leapRange.authors.find((r: any) => r.authorUserId === adminBId);
    expect(rowB.salesChannels.walletRevenue).toBe(20);

    const leapDayOnly = await caller.admin.authorSales.authors({ startDate: "2024-02-29", endDate: "2024-02-29" });
    expect(leapDayOnly.authors.find((r: any) => r.authorUserId === adminBId).salesChannels.walletRevenue).toBe(20);
    expect(leapDayOnly.authors.find((r: any) => r.authorUserId === adminAId).revenue).toBe(0);

    // 2023-12-31 .. 2025-01-01 spans every fixture row.
    const all = await caller.admin.authorSales.authors({ startDate: "2023-12-31", endDate: "2025-01-01" });
    expect(all.totals.salesChannels.orderRevenue).toBe(535); // 100+80+55+70+150+80
    expect(all.totals.salesChannels.walletRevenue).toBe(65); // 30+20+15
    expect(all.totals.totalRevenue).toBe(600);
    // Legacy zero-subtotal order adds nothing and belongs to no author.
    const legacyExposed = all.authors.some((r: any) => r.authorUserId == null);
    expect(legacyExposed).toBe(false);
  });

  it("admin drill-down returns one author's per-novel detail on the same date filter", async () => {
    const caller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    const detail = await caller.admin.authorSales.author({
      authorUserId: adminAId,
      startDate: DAY15,
      endDate: DAY15,
    });

    expect(detail.author).toEqual({ userId: adminAId, displayName: "Shared Pen" });
    expect(detail.dateRange).toEqual({ startDate: DAY15, endDate: DAY15 });
    expect(detail.totalRevenue).toBe(210);
    expect(detail.totalPurchases).toBe(4);
    expect(detail.salesChannels).toEqual({
      orderRevenue: 180, walletRevenue: 30, orderPurchases: 3, walletPurchases: 1,
    });
    // Exactly A's two novels — B's novel and the legacy novel never leak in.
    const detailNovelIds = detail.novels.map((n: any) => n.novelId).sort((a: number, b: number) => a - b);
    expect(detailNovelIds).toEqual([novelA1Id, novelA2Id].sort((a, b) => a - b));
    expect(detail.novels).not.toContainEqual(expect.objectContaining({ novelId: novelB1Id }));
    expect(detail.novels).not.toContainEqual(expect.objectContaining({ novelId: novelLegacyId }));
    const revenueByNovel = new Map(detail.novels.map((n: any) => [n.novelId, n.revenue]));
    expect(revenueByNovel.get(novelA1Id)).toBe(162); // O1 100 + O7 32 + wallet 30
    expect(revenueByNovel.get(novelA2Id)).toBe(48); // O7 48
  });

  it("empty range reports zeros for known authors instead of an error", async () => {
    const caller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    const empty = await caller.admin.authorSales.authors({ startDate: "2020-01-01", endDate: "2020-01-02" });
    expect(empty.totals.totalRevenue).toBe(0);
    expect(empty.totals.totalPurchases).toBe(0);
    expect(empty.authors).toHaveLength(3);
    expect(empty.authors.every((r: any) => r.revenue === 0 && r.purchases === 0)).toBe(true);
  });

  it("author-role and plain users are FORBIDDEN on the cross-author report", async () => {
    const authorCaller = appRouter.createCaller(contextFor({ id: authorCId, role: "author", name: "Author C" }));
    await expect(authorCaller.admin.authorSales.authors({ startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(authorCaller.admin.authorSales.author({ authorUserId: adminAId, startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Even an author asking for their OWN id is forbidden — cross-author
    // surface is admin-only, self-view goes through summary.
    await expect(authorCaller.admin.authorSales.author({ authorUserId: authorCId, startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const userCaller = appRouter.createCaller(contextFor({ id: plainUserId, role: "user", name: "Plain User" }));
    await expect(userCaller.admin.authorSales.authors({ startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(userCaller.admin.authorSales.author({ authorUserId: adminAId, startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(guestCaller().admin.authorSales.authors({ startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(guestCaller().admin.authorSales.author({ authorUserId: adminAId, startDate: DAY15, endDate: DAY15 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("author self-summary ignores a forged author target and keeps session scope", async () => {
    const authorCaller = appRouter.createCaller(contextFor({ id: authorCId, role: "author", name: "Author C" }));
    const forged = await authorCaller.admin.authorAnalytics.summary({
      period: "all",
      // zod strips unknown keys — a forged target must have no effect.
      authorUserId: adminAId,
    } as any);
    expect(forged.author).toEqual({ userId: authorCId, displayName: "Author C" });
    // Author C owns only their own novel (wallet 15) — never A's sales.
    expect(forged.totalRevenue).toBe(15);
    expect(forged.novels).toHaveLength(1);

    const scopedRange = await authorCaller.admin.authorAnalytics.summary({
      period: "month",
      startDate: DAY15,
      endDate: DAY15,
    });
    expect(scopedRange.author.userId).toBe(authorCId);
    expect(scopedRange.dateRange).toEqual({ startDate: DAY15, endDate: DAY15 });
    expect(scopedRange.totalRevenue).toBe(15);
  });

  it("rejects invalid and half-supplied date ranges on both surfaces", async () => {
    const adminCaller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));
    await expect(adminCaller.admin.authorSales.authors({ startDate: DAY15 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller.admin.authorSales.authors({ endDate: DAY15 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller.admin.authorSales.authors({ startDate: "2024-01-16", endDate: "2024-01-15" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller.admin.authorSales.authors({ startDate: "2024-02-30", endDate: "2024-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller.admin.authorSales.authors({ startDate: "2023-02-29", endDate: "2023-02-29" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(adminCaller.admin.authorSales.author({ authorUserId: adminAId, startDate: "not-a-date", endDate: "not-a-date" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const authorCaller = appRouter.createCaller(contextFor({ id: authorCId, role: "author", name: "Author C" }));
    await expect(authorCaller.admin.authorAnalytics.summary({ startDate: DAY15 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(authorCaller.admin.authorAnalytics.summary({ startDate: "2024-01-16", endDate: "2024-01-15" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(authorCaller.admin.authorAnalytics.summary({ startDate: "2024-02-30", endDate: "2024-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps authorProfile.update on the session user while date filters change", async () => {
    const authorCaller = appRouter.createCaller(contextFor({ id: authorCId, role: "author", name: "Author C" }));
    const renamed = await authorCaller.admin.authorProfile.update({ authorName: "Renamed C" });
    expect(renamed).toMatchObject({ userId: authorCId, authorName: "Renamed C" });

    const [rowC] = await db.select().from(users).where(eq(users.id, authorCId));
    expect(rowC.authorName).toBe("Renamed C");
    const [rowA] = await db.select().from(users).where(eq(users.id, adminAId));
    const [rowB] = await db.select().from(users).where(eq(users.id, adminBId));
    expect(rowA.authorName).toBe("Shared Pen");
    expect(rowB.authorName).toBe("Shared Pen");

    // A summary refetch with a different date filter does not retarget the
    // profile mutation: updating again still writes the session user only.
    await authorCaller.admin.authorAnalytics.summary({ startDate: DAY15, endDate: DAY15 });
    const renamedAgain = await authorCaller.admin.authorProfile.update({ authorName: "Author C" });
    expect(renamedAgain.userId).toBe(authorCId);
    const [rowCAfter] = await db.select().from(users).where(eq(users.id, authorCId));
    expect(rowCAfter.authorName).toBe("Author C");
  });

  it("IPE-070R2: penny-remainder discount reconciles grouped = drill-down = self-summary = per-novel sum", async () => {
    // Independent-review P2 reproduction: subtotal 3.00 → paid 1.00 across
    // three 1.00 lines — two lines on two different novels of Admin A, one
    // on B's novel. The legacy pipeline rounds the 0.333… allocation PER
    // NOVEL (0.33), so the author aggregate must sum the rounded per-novel
    // values (0.33 + 0.33 = 0.66), never re-round an author-level SUM
    // (which produced 0.67). Runs LAST on purpose: it adds sales to the
    // shared fixture novels after every fixed-date assertion above has
    // already executed.
    await createApprovedOrder({
      lines: [
        { novelId: novelA1Id, episodeId: episodeA1Id, amount: "1.00" },
        { novelId: novelA2Id, episodeId: episodeA2Id, amount: "1.00" },
        { novelId: novelB1Id, episodeId: episodeB1Id, amount: "1.00" },
      ],
      subtotal: "3.00",
      discountAmount: "2.00",
      totalAmount: "1.00",
      createdAt: bangkok("2024-01-15T07:00:00.000Z"), // inside DAY15
      suffix: "PENNY",
    });

    const adminCaller = appRouter.createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }));

    // ---- all-time ----
    const groupedAll = await adminCaller.admin.authorSales.authors({ period: "all" });
    const detailAll = await adminCaller.admin.authorSales.author({ authorUserId: adminAId, period: "all" });
    const summaryAll = await appRouter
      .createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }))
      .admin.authorAnalytics.summary({ period: "all" });

    const rowA = groupedAll.authors.find((r: any) => r.authorUserId === adminAId)!;
    const rowB = groupedAll.authors.find((r: any) => r.authorUserId === adminBId)!;
    // All-time A order revenue: O1 100 + O2 80 + O4 70 + O7 80 (32+48) plus
    // two 0.33-rounded penny lines = 330.66 — the pre-repair grouped report
    // would have shown 330.67 here (0.67 from an author-level re-round).
    expect(rowA.salesChannels.orderRevenue).toBeCloseTo(330.66, 2);
    expect(rowA.revenue).toBeCloseTo(360.66, 2); // + 30 wallet
    expect(rowB.salesChannels.orderRevenue).toBeCloseTo(205.33, 2);

    // grouped row == drill-down == self-summary, and == per-novel sum.
    expect(detailAll.salesChannels.orderRevenue).toBeCloseTo(330.66, 2);
    expect(summaryAll.salesChannels.orderRevenue).toBeCloseTo(330.66, 2);
    expect(Math.abs(rowA.salesChannels.orderRevenue - detailAll.salesChannels.orderRevenue)).toBeLessThan(1e-9);
    expect(Math.abs(rowA.salesChannels.orderRevenue - summaryAll.salesChannels.orderRevenue)).toBeLessThan(1e-9);
    expect(Math.abs(rowA.revenue - detailAll.totalRevenue)).toBeLessThan(1e-9);
    expect(Math.abs(rowA.revenue - summaryAll.totalRevenue)).toBeLessThan(1e-9);

    const revenueByNovel = new Map(detailAll.novels.map((n: any) => [n.novelId, n.revenue]));
    expect(revenueByNovel.get(novelA1Id)).toBeCloseTo(232.33, 2); // order 100+70+32 + 0.33, + wallet 30
    expect(revenueByNovel.get(novelA2Id)).toBeCloseTo(128.33, 2); // order 80+48 + 0.33
    expect(revenueByNovel.get(novelA1Id)! + revenueByNovel.get(novelA2Id)!).toBeCloseTo(rowA.revenue, 2);

    // Totals across all authors still equal the full row set.
    expect(groupedAll.totals.salesChannels.orderRevenue).toBeCloseTo(535.99, 2); // 535 + 0.99
    const sumRowOrder = groupedAll.authors.reduce((s: number, r: any) => s + r.salesChannels.orderRevenue, 0);
    expect(Math.abs(sumRowOrder - groupedAll.totals.salesChannels.orderRevenue)).toBeLessThan(1e-9);
    // Penny order adds three order lines: 2 for A, 1 for B.
    expect(rowA.purchases).toBe(8); // 5 order + 1 wallet + 2 penny lines
    expect(rowB.salesChannels.orderPurchases).toBe(3); // 2 prior + 1 penny line

    // ---- custom range covering the penny order ----
    const groupedDay = await adminCaller.admin.authorSales.authors({ startDate: DAY15, endDate: DAY15 });
    const detailDay = await adminCaller.admin.authorSales.author({ authorUserId: adminAId, startDate: DAY15, endDate: DAY15 });
    const summaryDay = await appRouter
      .createCaller(contextFor({ id: adminAId, role: "admin", name: "Admin A" }))
      .admin.authorAnalytics.summary({ startDate: DAY15, endDate: DAY15 });

    const rowADay = groupedDay.authors.find((r: any) => r.authorUserId === adminAId)!;
    expect(rowADay.salesChannels.orderRevenue).toBeCloseTo(180.66, 2); // 180 + 0.66
    expect(Math.abs(rowADay.salesChannels.orderRevenue - detailDay.salesChannels.orderRevenue)).toBeLessThan(1e-9);
    expect(Math.abs(rowADay.salesChannels.orderRevenue - summaryDay.salesChannels.orderRevenue)).toBeLessThan(1e-9);
    expect(Math.abs(rowADay.revenue - detailDay.totalRevenue)).toBeLessThan(1e-9);
    expect(rowADay.salesChannels.orderPurchases).toBe(5); // 3 prior + 2 penny lines
    expect(detailDay.totalPurchases).toBe(6); // 4 prior + 2 penny lines
    expect(groupedDay.totals.salesChannels.orderRevenue).toBeCloseTo(385.99, 2); // 385 + 0.99
    const rowBDay = groupedDay.authors.find((r: any) => r.authorUserId === adminBId)!;
    expect(rowBDay.salesChannels.orderRevenue).toBeCloseTo(205.33, 2);
  });
});
