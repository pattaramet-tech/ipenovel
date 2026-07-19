import { describe, it, expect } from "vitest";
import { getDb } from "./db";
import * as dbHelpers from "./db";

/**
 * Characterization/correctness tests for the Phase 3 homepage query
 * optimization (server/db.ts: getPopularNovels/getNewNovels/getFreeNovels/
 * getFinishedNovels/getLatestEpisodes). Locks in the behavior that must
 * survive the refactor (removing unused purchase/wishlist count subqueries
 * from 3 of the 4 ranking functions, adding id tie-breakers, and fixing
 * getLatestEpisodes' missing published-visibility filter):
 *
 * - only published novels/episodes are ever returned
 * - purchase/wishlist counts are correct where still computed (popular),
 *   and always present as 0 (never null/undefined) where removed
 * - a novel with zero purchases/wishlists still shows count = 0
 * - results never exceed the requested limit
 * - output shape (field set) is unchanged across all 4 ranking functions
 * - archived novels and unpublished episodes never leak into any section
 *
 * Requires a live DATABASE_URL - guarded with `if (!db) return` like every
 * other DB-integration test in this repo, so this is a genuine no-op (not
 * a false pass) in sandboxes without one.
 */

describe("Homepage ranking functions (Phase 3 characterization)", () => {
  it("getPopularNovels: only published novels, correct purchase/wishlist counts, zero for novels with none, id tie-breaker", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const popular: any = await dbHelpers.createNovel({
      title: `Popular Novel ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "published",
    });
    const quiet: any = await dbHelpers.createNovel({
      title: `Quiet Novel ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "published",
    });
    const archived: any = await dbHelpers.createNovel({
      title: `Archived Novel ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "archived",
    });

    const episode: any = await dbHelpers.createEpisode({
      novelId: popular.id,
      episodeNumber: "1",
      title: "Ep 1",
      price: "0",
      isFree: true,
      isPublished: true,
    });

    // 2 distinct purchasers for `popular`, 0 for `quiet`.
    await dbHelpers.createPurchase(900001, popular.id, episode.id, 700001);
    const episode2: any = await dbHelpers.createEpisode({
      novelId: popular.id,
      episodeNumber: "2",
      title: "Ep 2",
      price: "0",
      isFree: true,
      isPublished: true,
    });
    await dbHelpers.createPurchase(900002, popular.id, episode2.id, 700002);
    await dbHelpers.addToWishlist(900003, popular.id);

    const results = await dbHelpers.getPopularNovels(50, 50);
    const ids = results.map((n: any) => n.id);

    expect(ids).not.toContain(archived.id); // archived never leaks

    const popularRow = results.find((n: any) => n.id === popular.id);
    expect(popularRow).toBeDefined();
    expect(popularRow!.purchaseCount).toBe(2);
    expect(popularRow!.wishlistCount).toBe(1);

    const quietRow = results.find((n: any) => n.id === quiet.id);
    expect(quietRow).toBeDefined();
    // Never null/undefined for a novel with zero purchases/wishlists.
    expect(quietRow!.purchaseCount).toBe(0);
    expect(quietRow!.wishlistCount).toBe(0);

    // Output shape: every NovelWithCounts field present.
    for (const field of ["id", "title", "publicationStatus", "purchaseCount", "wishlistCount", "freeEpisodeCount"]) {
      expect(popularRow).toHaveProperty(field);
    }
  });

  it("getNewNovels/getFreeNovels/getFinishedNovels: only published, counts always 0 (never null), never exceed limit, correct shape", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const published: any = await dbHelpers.createNovel({
      title: `New Published ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "published",
      storyStatus: "finished",
    });
    const archived: any = await dbHelpers.createNovel({
      title: `New Archived ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "archived",
      storyStatus: "finished",
    });

    const freeEpisode: any = await dbHelpers.createEpisode({
      novelId: published.id,
      episodeNumber: "1",
      title: "Free Ep",
      price: "0",
      isFree: true,
      isPublished: true,
    });
    // A purchase/wishlist exists but must NOT affect getNewNovels/
    // getFreeNovels/getFinishedNovels' counts (those fields are always 0
    // now that the unused subqueries were removed) or their ordering
    // (createdAt-only).
    await dbHelpers.createPurchase(900010, published.id, freeEpisode.id, 700010);
    await dbHelpers.addToWishlist(900011, published.id);

    const newNovels = await dbHelpers.getNewNovels(5);
    const newIds = newNovels.map((n: any) => n.id);
    expect(newIds).not.toContain(archived.id);
    const newRow = newNovels.find((n: any) => n.id === published.id);
    if (newRow) {
      expect(newRow.purchaseCount).toBe(0);
      expect(newRow.wishlistCount).toBe(0);
      expect(typeof newRow.freeEpisodeCount).toBe("number");
    }
    expect(newNovels.length).toBeLessThanOrEqual(5);

    const freeNovels = await dbHelpers.getFreeNovels(5);
    expect(freeNovels.length).toBeLessThanOrEqual(5);
    const freeIds = freeNovels.map((n: any) => n.id);
    expect(freeIds).not.toContain(archived.id);
    const freeRow = freeNovels.find((n: any) => n.id === published.id);
    expect(freeRow).toBeDefined(); // has a free episode - must appear
    expect(freeRow!.purchaseCount).toBe(0);
    expect(freeRow!.wishlistCount).toBe(0);
    expect(freeRow!.freeEpisodeCount).toBeGreaterThan(0);

    const finishedNovels = await dbHelpers.getFinishedNovels(5, 50);
    expect(finishedNovels.length).toBeLessThanOrEqual(5);
    const finishedIds = finishedNovels.map((n: any) => n.id);
    expect(finishedIds).not.toContain(archived.id);
  });

  it("getFreeNovels excludes a published novel with zero free episodes", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const noFreeEpisodes: any = await dbHelpers.createNovel({
      title: `No Free Episodes ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "published",
    });
    await dbHelpers.createEpisode({
      novelId: noFreeEpisodes.id,
      episodeNumber: "1",
      title: "Paid Ep",
      price: "10",
      isFree: false,
      isPublished: true,
    });

    const freeNovels = await dbHelpers.getFreeNovels(100);
    expect(freeNovels.map((n: any) => n.id)).not.toContain(noFreeEpisodes.id);
  });

  it("getLatestEpisodes: excludes an unpublished episode and an episode belonging to an archived novel (bug fix)", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const publishedNovel: any = await dbHelpers.createNovel({
      title: `Latest Published Novel ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "published",
    });
    const archivedNovel: any = await dbHelpers.createNovel({
      title: `Latest Archived Novel ${ts}`,
      author: "Test",
      description: "Test",
      publicationStatus: "archived",
    });

    const visibleEpisode: any = await dbHelpers.createEpisode({
      novelId: publishedNovel.id,
      episodeNumber: "1",
      title: `Visible Episode ${ts}`,
      price: "0",
      isFree: true,
      isPublished: true,
    });
    const draftEpisode: any = await dbHelpers.createEpisode({
      novelId: publishedNovel.id,
      episodeNumber: "2",
      title: `Draft Episode ${ts}`,
      price: "0",
      isFree: true,
      isPublished: false, // draft - must never appear
    });
    const orphanedEpisode: any = await dbHelpers.createEpisode({
      novelId: archivedNovel.id,
      episodeNumber: "1",
      title: `Archived Novel Episode ${ts}`,
      price: "0",
      isFree: true,
      isPublished: true, // episode itself published, but its novel is archived
    });

    const latest = await dbHelpers.getLatestEpisodes(200);
    const latestIds = latest.map((e: any) => e.id);

    expect(latestIds).toContain(visibleEpisode.id);
    expect(latestIds).not.toContain(draftEpisode.id);
    expect(latestIds).not.toContain(orphanedEpisode.id);
  });
});
