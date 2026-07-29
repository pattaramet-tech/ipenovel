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

  // ---- Review fix: status/saleMode/purchasedOnly must combine on the SAME
  // episode row, never as independently-true aggregate counts (a
  // cross-row false positive). See buildEpisodeLevelPredicate() in
  // hybridHealthQueries.ts and its static SQL-shape tests.

  it("legacy_only + package does NOT false-positive on a novel with a LEGACY_ONLY chapter and an unrelated MISSING_BOTH package", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    // Neither episode is LEGACY_ONLY + package at once.
    const legacyOnlyChapter = await insertEpisode(novel.id, {
      content: null,
      fileUrl: "https://legacy/x.pdf",
      saleMode: "chapter",
    });
    const missingBothPackage = await insertEpisode(novel.id, {
      content: null,
      fileUrl: null,
      saleMode: "package",
    });
    cleanup.episodeIds.push(legacyOnlyChapter, missingBothPackage);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "legacy_only",
      saleMode: "package",
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeUndefined();

    const detail = await caller.admin.hybridHealth.detail({
      novelId: novel.id,
      status: "legacy_only",
      saleMode: "package",
    });
    expect(detail.episodes).toHaveLength(0);
  });

  it("legacy_only + package DOES show the novel when one episode is actually both", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const legacyOnlyPackage = await insertEpisode(novel.id, {
      content: null,
      fileUrl: "https://legacy/x.pdf",
      saleMode: "package",
    });
    cleanup.episodeIds.push(legacyOnlyPackage);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "legacy_only",
      saleMode: "package",
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeDefined();

    const detail = await caller.admin.hybridHealth.detail({
      novelId: novel.id,
      status: "legacy_only",
      saleMode: "package",
    });
    expect(detail.episodes.map((e) => e.episodeId)).toEqual([legacyOnlyPackage]);
  });

  it("has_plaintext + package shows a novel that has a package episode WITH plaintext", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const plaintextPackage = await insertEpisode(novel.id, { content: "chapter text", saleMode: "package" });
    cleanup.episodeIds.push(plaintextPackage);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "has_plaintext",
      saleMode: "package",
    });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row).toBeDefined();
  });

  it("has_plaintext + package does NOT require packageMissingPlaintextCount > 0 (that field means the opposite)", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    // Only a plaintext package episode - packageMissingPlaintextCount is 0
    // for this novel, but it must still show under has_plaintext+package.
    const plaintextPackage = await insertEpisode(novel.id, { content: "chapter text", saleMode: "package" });
    cleanup.episodeIds.push(plaintextPackage);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "has_plaintext",
      saleMode: "package",
    });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row).toBeDefined();
    expect(row?.packageMissingPlaintextCount).toBe(0);
  });

  it("purchasedOnly is scoped to the same episode as status/saleMode, not any purchased episode in the novel", async () => {
    const admin = await createTestUser({ role: "admin" });
    const buyer = await createTestUser();
    const novel = await createTestNovel();
    const order = await createTestOrder(buyer.id);
    cleanup.userIds.push(admin.id, buyer.id);
    cleanup.novelIds.push(novel.id);
    cleanup.orderIds.push(order.id);

    // Purchased episode is a healthy plaintext chapter (not missing, not package).
    const purchasedHealthy = await insertEpisode(novel.id, { content: "text", saleMode: "chapter" });
    // Missing-plaintext package episode exists, but nobody purchased it.
    const unpurchasedMissingPackage = await insertEpisode(novel.id, { content: null, saleMode: "package" });
    cleanup.episodeIds.push(purchasedHealthy, unpurchasedMissingPackage);
    await insertOrderPurchase(buyer.id, novel.id, purchasedHealthy, order.id);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "missing_plaintext",
      saleMode: "package",
      purchasedOnly: true,
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeUndefined();

    // Now purchase the actually-matching episode too - the novel should appear.
    await insertOrderPurchase(buyer.id, novel.id, unpurchasedMissingPackage, order.id);
    const overviewAfter = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "missing_plaintext",
      saleMode: "package",
      purchasedOnly: true,
    });
    expect(overviewAfter.novels.find((n) => n.novelId === novel.id)).toBeDefined();
  });

  it("status=all + saleMode=all + purchasedOnly=false still shows a novel with zero episodes", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "all",
      saleMode: "all",
      purchasedOnly: false,
    });
    const row = overview.novels.find((n) => n.novelId === novel.id);
    expect(row).toBeDefined();
    expect(row?.totalEpisodes).toBe(0);
  });

  it("status=all + saleMode=package shows a novel with a package episode regardless of plaintext status", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const healthyPackage = await insertEpisode(novel.id, { content: "chapter text", saleMode: "package" });
    cleanup.episodeIds.push(healthyPackage);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "all",
      saleMode: "package",
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeDefined();
  });

  // ---- Hotfix (TiDB errno=8176 memory-limit incident): page-first
  // aggregation. These prove the page-scoped aggregate query
  // (queryHybridHealthAggregatesForNovelIds, WHERE novels.id IN (...)) never
  // mixes one novel's episode counts into another's, and that the bounded
  // summary batch scan is correct and cached.

  it("page aggregates are scoped to exactly the current page's novel ids - a novel's counts never leak into another novel's row", async () => {
    const admin = await createTestUser({ role: "admin" });
    const tag = uniqueTestTag("hh-page-scope");
    const novelA = await createTestNovel({ title: `${tag} Alpha` });
    const novelB = await createTestNovel({ title: `${tag} Beta` });
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novelA.id, novelB.id);

    // Novel A: 1 missing-plaintext episode. Novel B: 3 missing-plaintext episodes.
    const epA1 = await insertEpisode(novelA.id, { content: null });
    const epB1 = await insertEpisode(novelB.id, { content: null });
    const epB2 = await insertEpisode(novelB.id, { content: null });
    const epB3 = await insertEpisode(novelB.id, { content: null });
    cleanup.episodeIds.push(epA1, epB1, epB2, epB3);

    const caller = appRouter.createCaller(adminContext(admin.id));
    // pageSize=1 forces novelA and novelB onto separate pages when sorted by title asc.
    const page1 = await caller.admin.hybridHealth.overview({
      search: tag,
      status: "all",
      pageSize: 1,
      page: 1,
      sortBy: "title",
      sortOrder: "asc",
    });
    expect(page1.novels).toHaveLength(1);
    expect(page1.novels[0].novelId).toBe(novelA.id);
    expect(page1.novels[0].totalEpisodes).toBe(1);
    expect(page1.novels[0].missingPlaintextCount).toBe(1);

    const page2 = await caller.admin.hybridHealth.overview({
      search: tag,
      status: "all",
      pageSize: 1,
      page: 2,
      sortBy: "title",
      sortOrder: "asc",
    });
    expect(page2.novels).toHaveLength(1);
    expect(page2.novels[0].novelId).toBe(novelB.id);
    expect(page2.novels[0].totalEpisodes).toBe(3);
    expect(page2.novels[0].missingPlaintextCount).toBe(3);
  });

  it("overview response never includes content or fileUrl keys", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const ep = await insertEpisode(novel.id, { content: null, fileUrl: "https://private-r2/overview-should-not-leak.pdf" });
    cleanup.episodeIds.push(ep);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({ search: novel.title, status: "all" });
    for (const row of overview.novels) {
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("fileUrl");
    }
    expect(JSON.stringify(overview)).not.toContain("private-r2");
  });

  it("summary counts increase by exactly the delta of newly inserted fixture episodes (correct regardless of batch boundaries)", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const before = await caller.admin.hybridHealth.summary();

    const plaintextEp = await insertEpisode(novel.id, { content: "text" });
    const legacyOnlyEp = await insertEpisode(novel.id, { content: null, fileUrl: "https://legacy/x.pdf" });
    const missingBothEp = await insertEpisode(novel.id, { content: null, isPublished: true });
    cleanup.episodeIds.push(plaintextEp, legacyOnlyEp, missingBothEp);

    // The batch scan is keyset-paginated over the WHOLE episodes table, so
    // these three new rows are correctly picked up regardless of exactly
    // which batch boundary they land on - that's the property this test
    // actually verifies (delta correctness), since the shared ipenovel_test
    // database's total row count isn't controlled by this test.
    const after = await caller.admin.hybridHealth.summary();

    expect(after.totalEpisodes - before.totalEpisodes).toBe(3);
    expect(after.plaintextCount - before.plaintextCount).toBe(1);
    expect(after.missingPlaintextCount - before.missingPlaintextCount).toBe(2);
    expect(after.legacyOnlyCount - before.legacyOnlyCount).toBe(1);
    expect(after.missingBothCount - before.missingBothCount).toBe(1);
    expect(after.publishedMissingPlaintextCount - before.publishedMissingPlaintextCount).toBe(1);
  });

  it("summary is cached - a second call shortly after the first does not re-scan (same generatedAt, cached:true)", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(adminContext(admin.id));

    const first = await caller.admin.hybridHealth.summary();
    const second = await caller.admin.hybridHealth.summary();

    expect(second.cached).toBe(true);
    expect(second.generatedAt).toBe(first.generatedAt);
  });

  it("summary response never includes content or fileUrl keys", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(adminContext(admin.id));
    const summary = await caller.admin.hybridHealth.summary();
    expect(summary).not.toHaveProperty("content");
    expect(summary).not.toHaveProperty("fileUrl");
  });

  it("overview and summary are independently callable and both succeed", async () => {
    const admin = await createTestUser({ role: "admin" });
    const caller = appRouter.createCaller(adminContext(admin.id));

    const [overview, summary] = await Promise.all([caller.admin.hybridHealth.overview({}), caller.admin.hybridHealth.summary()]);

    expect(overview.novels).toBeInstanceOf(Array);
    expect(typeof summary.totalNovels).toBe("number");
  });

  it("detail still works end-to-end after the hotfix (scoped by novelId, unaffected by the Overview redesign)", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const missingEp = await insertEpisode(novel.id, { content: null, isPublished: true });
    cleanup.episodeIds.push(missingEp);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const detail = await caller.admin.hybridHealth.detail({ novelId: novel.id });
    expect(detail.episodes.map((e) => e.episodeId)).toEqual([missingEp]);
    expect(detail.novel.novelId).toBe(novel.id);
  });

  // ---- Regression guard: a direct Manus push to main (independent of this
  // PR) reintroduced the pre-hotfix architecture with an in-memory status
  // filter that silently ignored saleMode/purchasedOnly entirely. These
  // prove both filters are still enforced after merging that push away.

  it("status=all + saleMode=package does not show a chapter-only novel", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const chapterEp = await insertEpisode(novel.id, { content: "text", saleMode: "chapter" });
    cleanup.episodeIds.push(chapterEp);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "all",
      saleMode: "package",
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeUndefined();
  });

  it("status=all + purchasedOnly=true does not show a novel with no purchased episode", async () => {
    const admin = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    cleanup.userIds.push(admin.id);
    cleanup.novelIds.push(novel.id);

    const unpurchasedEp = await insertEpisode(novel.id, { content: "text" });
    cleanup.episodeIds.push(unpurchasedEp);

    const caller = appRouter.createCaller(adminContext(admin.id));
    const overview = await caller.admin.hybridHealth.overview({
      search: novel.title,
      status: "all",
      purchasedOnly: true,
    });
    expect(overview.novels.find((n) => n.novelId === novel.id)).toBeUndefined();
  });
});
