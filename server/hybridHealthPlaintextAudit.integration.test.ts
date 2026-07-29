import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestNovel, createTestOrder, uniqueTestTag, deleteFixtures } from "./test-helpers/fixtures";
import { episodes, purchases, episodePurchases } from "../drizzle/schema";

/**
 * feat/hybrid-content-health-plaintext-audit - Phase 2 coverage for the
 * DB-aggregated overview/detail queries in hybridHealthQueries.ts and the
 * classification layer in hybridHealthService.ts.
 *
 * ONLY runs against TEST_DATABASE_URL (never DATABASE_URL) - enforced by
 * vitest.integration.globalsetup.ts, which requires the database name to be
 * EXACTLY "ipenovel_test" (verified live via SELECT DATABASE()) before any
 * test file in this project is even collected. See docs/TEST_INFRASTRUCTURE.md.
 *
 * Not run in this session (no TEST_DATABASE_URL configured in this
 * sandbox) - written for `pnpm test:integration` on a Coolify preview or any
 * environment with a real disposable ipenovel_test database.
 */

function adminContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `hh-admin-${userId}`,
      email: `hh-admin-${userId}@example.test`,
      name: "Hybrid Health Test Admin",
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

function extractInsertId(result: any): number {
  const id = result?.[0]?.insertId ?? result?.insertId;
  if (!id) throw new Error("hybridHealth integration test: failed to extract inserted ID");
  return id;
}

interface EpisodeOverrides {
  episodeNumber?: string;
  title?: string;
  content?: string | null;
  fileUrl?: string | null;
  contentFormat?: string;
  saleMode?: "chapter" | "package";
  isPublished?: boolean;
  price?: string;
}

async function insertEpisode(novelId: number, overrides: EpisodeOverrides = {}): Promise<number> {
  const testDb = getTestDb();
  const tag = uniqueTestTag("hh-ep");
  const result = await testDb.insert(episodes).values({
    novelId,
    episodeNumber: overrides.episodeNumber ?? tag,
    title: overrides.title ?? `Episode ${tag}`,
    price: overrides.price ?? "0.00",
    isFree: true,
    fileUrl: overrides.fileUrl ?? null,
    content: overrides.content ?? null,
    contentFormat: overrides.contentFormat ?? "plain_text",
    saleMode: overrides.saleMode ?? "chapter",
    isPublished: overrides.isPublished ?? false,
  });
  return extractInsertId(result);
}

async function insertOrderPurchase(userId: number, novelId: number, episodeId: number, orderId: number): Promise<void> {
  const testDb = getTestDb();
  await testDb.insert(purchases).values({ userId, novelId, episodeId, orderId });
}

async function insertWalletPurchase(userId: number, novelId: number, episodeId: number): Promise<void> {
  const testDb = getTestDb();
  await testDb.insert(episodePurchases).values({ userId, novelId, episodeId, pricePaid: "0.00" });
}

// Tracks everything created by the currently-running test so afterEach can
// always clean up, even on assertion failure - never relies on a happy path
// reaching an explicit cleanup call.
let cleanup: {
  userIds: number[];
  novelIds: number[];
  episodeIds: number[];
  orderIds: number[];
} = { userIds: [], novelIds: [], episodeIds: [], orderIds: [] };

afterEach(async () => {
  const testDb = getTestDb();
  // purchases/episodePurchases have no dedicated fixture cleanup helper -
  // delete by episodeId before deleteFixtures() removes the episodes/novels
  // they reference.
  for (const episodeId of cleanup.episodeIds) {
    await testDb.delete(purchases).where(eq(purchases.episodeId, episodeId));
    await testDb.delete(episodePurchases).where(eq(episodePurchases.episodeId, episodeId));
  }
  await deleteFixtures({
    episodeIds: cleanup.episodeIds,
    novelIds: cleanup.novelIds,
    orderIds: cleanup.orderIds,
    userIds: cleanup.userIds,
  });
  cleanup = { userIds: [], novelIds: [], episodeIds: [], orderIds: [] };
});

describe("hybridHealth overview/detail - integration (TEST_DATABASE_URL only)", () => {
  it("a novel with zero episodes is not counted as missing and does not appear under the default missing_plaintext filter", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeUndefined();

    const overviewAll = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overviewAll.novels.find((n) => n.novelId === novel.id);
    expect(row).toBeDefined();
    expect(row?.totalEpisodes).toBe(0);
    expect(row?.missingPlaintextCount).toBe(0);
  });

  it("overview counts are correct across all four content states", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const plaintextOnly = await insertEpisode(novel.id, { content: "chapter text", fileUrl: null });
    const hybrid = await insertEpisode(novel.id, { content: "chapter text", fileUrl: "https://legacy/file.pdf" });
    const legacyOnly = await insertEpisode(novel.id, { content: null, fileUrl: "https://legacy/file.pdf" });
    const missingBoth = await insertEpisode(novel.id, { content: "   ", fileUrl: null });
    cleanup.episodeIds.push(plaintextOnly, hybrid, legacyOnly, missingBoth);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      totalEpisodes: 4,
      plaintextCount: 2,
      missingPlaintextCount: 2,
      plaintextOnlyCount: 1,
      hybridCount: 1,
      legacyOnlyCount: 1,
      missingBothCount: 1,
    });
  });

  it("publishedMissingPlaintextCount only counts published episodes missing plaintext", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const publishedMissing = await insertEpisode(novel.id, { content: null, isPublished: true });
    const draftMissing = await insertEpisode(novel.id, { content: null, isPublished: false });
    cleanup.episodeIds.push(publishedMissing, draftMissing);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row?.publishedMissingPlaintextCount).toBe(1);
  });

  it("purchases (order-based) count toward purchasedMissingPlaintextCount", async () => {
    const admin = await createTestUser({ role: "admin" });
    const buyer = await createTestUser();
    const novel = await createTestNovel();
    const order = await createTestOrder(buyer.id);
    cleanup.userIds.push(admin.id, buyer.id);
    cleanup.novelIds.push(novel.id);
    cleanup.orderIds.push(order.id);

    const missingEp = await insertEpisode(novel.id, { content: null });
    cleanup.episodeIds.push(missingEp);
    await insertOrderPurchase(buyer.id, novel.id, missingEp, order.id);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row?.purchasedMissingPlaintextCount).toBe(1);
  });

  it("episodePurchases (wallet-based) count toward purchasedMissingPlaintextCount", async () => {
    const admin = await createTestUser({ role: "admin" });
    const buyer = await createTestUser();
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id, buyer.id);
    cleanup.novelIds.push(novel.id);

    const missingEp = await insertEpisode(novel.id, { content: null });
    cleanup.episodeIds.push(missingEp);
    await insertWalletPurchase(buyer.id, novel.id, missingEp);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row?.purchasedMissingPlaintextCount).toBe(1);
  });

  it("multiple purchase records for the same episode (both sources) never double-count that episode", async () => {
    const admin = await createTestUser({ role: "admin" });
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    const novel = await createTestNovel();
    const order = await createTestOrder(buyerA.id);
    cleanup.userIds.push(admin.id, buyerA.id, buyerB.id);
    cleanup.novelIds.push(novel.id);
    cleanup.orderIds.push(order.id);

    const missingEp = await insertEpisode(novel.id, { content: null });
    cleanup.episodeIds.push(missingEp);
    // Same episode purchased via both the order-based path and the wallet
    // path, by two different users - still exactly one "purchased" episode.
    await insertOrderPurchase(buyerA.id, novel.id, missingEp, order.id);
    await insertWalletPurchase(buyerB.id, novel.id, missingEp);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row?.purchasedMissingPlaintextCount).toBe(1);
    expect(row?.totalEpisodes).toBe(1);
  });

  it("detail status=missing_plaintext (the default) returns only LEGACY_ONLY/MISSING_BOTH episodes", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const plaintextOnly = await insertEpisode(novel.id, { content: "text" });
    const legacyOnly = await insertEpisode(novel.id, { content: null, fileUrl: "https://legacy/x.pdf" });
    const missingBoth = await insertEpisode(novel.id, { content: null });
    cleanup.episodeIds.push(plaintextOnly, legacyOnly, missingBoth);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const detail = await caller.admin.hybridHealth.detail({ novelId: novel.id });
    const ids = detail.episodes.map((e) => e.episodeId).sort();
    expect(ids).toEqual([legacyOnly, missingBoth].sort());
    expect(detail.total).toBe(2);
  });

  it("detail response never includes content or fileUrl fields", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const ep = await insertEpisode(novel.id, { content: null, fileUrl: "https://private-r2/should-not-leak.pdf" });
    cleanup.episodeIds.push(ep);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const detail = await caller.admin.hybridHealth.detail({ novelId: novel.id, status: "all" });
    for (const episode of detail.episodes) {
      expect(episode).not.toHaveProperty("content");
      expect(episode).not.toHaveProperty("fileUrl");
      expect(JSON.stringify(episode)).not.toContain("private-r2");
    }
  });

  it("overview pagination and search work together", async () => {
    const admin = await createTestUser({ role: "admin" });
    const tag = uniqueTestTag("hh-search");
    const novelA = await createTestNovel({ title: `${tag} Alpha` });
    const novelB = await createTestNovel({ title: `${tag} Beta` });
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novelA.id, novelB.id);

    const epA = await insertEpisode(novelA.id, { content: null });
    const epB = await insertEpisode(novelB.id, { content: null });
    cleanup.episodeIds.push(epA, epB);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const page1 = await caller.admin.hybridHealth.overview({ search: tag, pageSize: 1, page: 1, sortBy: "title", sortOrder: "asc" });
    expect(page1.novels).toHaveLength(1);
    expect(page1.total).toBe(2);
    expect(page1.totalPages).toBe(2);
    expect(page1.novels[0].novelId).toBe(novelA.id);

    const page2 = await caller.admin.hybridHealth.overview({ search: tag, pageSize: 1, page: 2, sortBy: "title", sortOrder: "asc" });
    expect(page2.novels).toHaveLength(1);
    expect(page2.novels[0].novelId).toBe(novelB.id);

    // exact novelId search also matches
    const byId = await caller.admin.hybridHealth.overview({ search: String(novelA.id), status: "all" });
    expect(byId.novels.some((n) => n.novelId === novelA.id)).toBe(true);
  });

  it("detail search filters by episode number/title, and pagination slices results", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const tag = uniqueTestTag("hh-detail-search");
    const target = await insertEpisode(novel.id, { content: null, episodeNumber: "1", title: `${tag} Special Title` });
    const other = await insertEpisode(novel.id, { content: null, episodeNumber: "2", title: "Unrelated Title" });
    cleanup.episodeIds.push(target, other);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const filtered = await caller.admin.hybridHealth.detail({ novelId: novel.id, search: tag });
    expect(filtered.episodes.map((e) => e.episodeId)).toEqual([target]);

    const paged = await caller.admin.hybridHealth.detail({ novelId: novel.id, status: "all", pageSize: 1, page: 1 });
    expect(paged.episodes).toHaveLength(1);
    expect(paged.total).toBe(2);
    expect(paged.totalPages).toBe(2);
  });
});
