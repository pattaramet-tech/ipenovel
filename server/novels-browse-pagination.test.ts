import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "./db";
import { getDb, escapeLikePattern } from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { resolveSeoMetadata } from "./services/serverSeoRenderer";

/**
 * Phase 4 - /novels pagination and payload reduction.
 *
 * Two tiers, following the repo's established convention (see
 * server/hybrid-access-regression.test.ts): pure logic and input-validation
 * tests run unconditionally (no DB required - rejection happens before any
 * query runs), while tests that need real rows are guarded with
 * `if (!db) return` so they no-op cleanly without a live DATABASE_URL but
 * run for real wherever one is configured.
 */

function publicContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("novels.browse - input validation (no DB required, rejected before query)", () => {
  const caller = appRouter.createCaller(publicContext());

  it("rejects page=0", async () => {
    await expect(caller.novels.browse({ page: 0 } as any)).rejects.toThrow();
  });

  it("rejects a negative page", async () => {
    await expect(caller.novels.browse({ page: -1 } as any)).rejects.toThrow();
  });

  it("rejects a non-integer page", async () => {
    await expect(caller.novels.browse({ page: 1.5 } as any)).rejects.toThrow();
  });

  it("rejects pageSize above the max (100)", async () => {
    await expect(caller.novels.browse({ pageSize: 101 } as any)).rejects.toThrow();
  });

  it("rejects an unknown sort value", async () => {
    await expect(caller.novels.browse({ sort: "trending" } as any)).rejects.toThrow();
  });

  it("rejects an unknown storyStatus value", async () => {
    await expect(caller.novels.browse({ storyStatus: "cancelled" } as any)).rejects.toThrow();
  });

  it("rejects a search term over 100 characters", async () => {
    await expect(caller.novels.browse({ search: "a".repeat(101) } as any)).rejects.toThrow();
  });

  it("accepts a search term at exactly 100 characters", async () => {
    const result = await caller.novels.browse({ search: "a".repeat(100) } as any);
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("hasNextPage");
  });
});

describe("escapeLikePattern - LIKE wildcard escaping (pure function, no DB)", () => {
  it("escapes % so it is matched literally, not as a wildcard", () => {
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
  });

  it("escapes _ so it is matched literally, not as a single-char wildcard", () => {
    expect(escapeLikePattern("under_score")).toBe("under\\_score");
  });

  it("escapes a literal backslash first, so escaping is not double-applied", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary characters (including Thai text) untouched", () => {
    expect(escapeLikePattern("นิยายแฟนตาซี")).toBe("นิยายแฟนตาซี");
  });
});

describe("/novels server-side SEO metadata - query-aware robots policy (no DB - /novels branch never queries)", () => {
  it("plain /novels is indexable (no robots tag) with the bare canonical", async () => {
    const meta = await resolveSeoMetadata("/novels");
    expect(meta?.canonical).toBe("https://ipenovel.com/novels");
    expect(meta?.robots).toBeUndefined();
  });

  it("/novels?page=1 (explicit) is treated the same as no page param - still indexable", async () => {
    const meta = await resolveSeoMetadata("/novels?page=1");
    expect(meta?.robots).toBeUndefined();
    expect(meta?.canonical).toBe("https://ipenovel.com/novels");
  });

  it("/novels?page=2 is noindex,follow but still canonicalizes to bare /novels", async () => {
    const meta = await resolveSeoMetadata("/novels?page=2");
    expect(meta?.robots).toBe("noindex,follow");
    expect(meta?.canonical).toBe("https://ipenovel.com/novels");
  });

  it("/novels?search=naruto is noindex,follow (internal search results)", async () => {
    const meta = await resolveSeoMetadata("/novels?search=naruto");
    expect(meta?.robots).toBe("noindex,follow");
  });

  it("/novels?search= (empty) is treated as no search - still indexable", async () => {
    const meta = await resolveSeoMetadata("/novels?search=");
    expect(meta?.robots).toBeUndefined();
  });

  it("/novels?sort=popular&storyStatus=finished (page 1, no search) stays indexable", async () => {
    const meta = await resolveSeoMetadata("/novels?sort=popular&storyStatus=finished");
    expect(meta?.robots).toBeUndefined();
    expect(meta?.canonical).toBe("https://ipenovel.com/novels");
  });

  it("title and description never vary by query - matches the client hook's static title", async () => {
    const base = await resolveSeoMetadata("/novels");
    const withQuery = await resolveSeoMetadata("/novels?sort=popular&page=3&search=x");
    expect(withQuery?.title).toBe(base?.title);
    expect(withQuery?.description).toBe(base?.description);
  });
});

describe("getBrowseCatalog - pagination correctness (DB required, isolated fixtures)", () => {
  // Every assertion in this block is scoped via `search: TAG` to novels
  // this describe block itself created - never "whatever happens to exist"
  // in a shared database. The previous version of these tests queried the
  // *entire* novels table with no fixtures and no isolation at all, so its
  // results (row counts, hasNextPage, page-to-page membership) depended
  // entirely on ambient data - any other concurrently-running test file
  // that also creates/deletes novels (several do, see
  // docs/TEST_INFRASTRUCTURE.md's dependency map) could change the answer
  // mid-test. That's the documented root cause of this file "appearing
  // different in each run" during A/B verification.
  const TAG = `pgtest${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  // Deliberately a different tag from TAG - this fixture must never be
  // counted by the TAG-scoped pagination/count assertions below, only by
  // its own dedicated filter="free" test.
  const FREE_TAG = `pgtestfree${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const FIXTURE_COUNT = 7;
  const novelIds: number[] = [];
  const episodeIds: number[] = [];
  let freeNovelId: number;

  beforeAll(async () => {
    const database = await getDb();
    if (!database) return;

    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const novel: any = await db.createNovel({
        title: `${TAG} Novel ${String(i).padStart(2, "0")}`,
        author: "Test Author",
        description: "Isolated fixture for novels-browse-pagination.test.ts - safe to delete.",
        publicationStatus: "published",
        storyStatus: "ongoing",
      });
      novelIds.push((novel as any).id ?? (novel as any).insertId);
    }

    // A dedicated fixture with a free episode, for the filter="free" test -
    // separate from the plain FIXTURE_COUNT novels above so their count
    // stays exact for the pagination-count assertions.
    const freeNovel: any = await db.createNovel({
      title: `${FREE_TAG} Free Novel`,
      author: "Test Author",
      description: "Isolated free-episode fixture - safe to delete.",
      publicationStatus: "published",
      storyStatus: "ongoing",
    });
    freeNovelId = (freeNovel as any).id ?? (freeNovel as any).insertId;
    novelIds.push(freeNovelId);
    const epResult: any = await db.createEpisode({
      novelId: freeNovelId,
      episodeNumber: "1",
      title: "Free Episode",
      price: "0.00",
      isFree: true,
    });
    episodeIds.push((epResult as any)[0]?.insertId ?? (epResult as any).insertId);
  }, 30000);

  afterAll(async () => {
    const database = await getDb();
    if (!database) return;
    if (episodeIds.length > 0) await database.execute(`DELETE FROM episodes WHERE id IN (${episodeIds.join(",")})`);
    if (novelIds.length > 0) await database.execute(`DELETE FROM novels WHERE id IN (${novelIds.join(",")})`);
  });

  it("default page returns at most pageSize items", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: 20, offset: 0 });
    expect(items.length).toBeLessThanOrEqual(20);
    expect(items.length).toBe(FIXTURE_COUNT);
  });

  it("page 2 never repeats an id from page 1, and together they cover every fixture exactly once", async () => {
    const database = await getDb();
    if (!database) return;

    const pageSize = Math.ceil(FIXTURE_COUNT / 2);
    const page1 = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: pageSize, offset: 0 });
    const page2 = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: pageSize, offset: pageSize });

    const page1Ids = new Set(page1.items.map((n) => n.id));
    const overlap = page2.items.filter((n) => page1Ids.has(n.id));
    expect(overlap).toHaveLength(0);

    const combinedIds = new Set([...page1.items.map((n) => n.id), ...page2.items.map((n) => n.id)]);
    expect(combinedIds.size).toBe(FIXTURE_COUNT);
  });

  it("hasNextPage is false once the last fixture row has been returned", async () => {
    const database = await getDb();
    if (!database) return;

    const { hasNextPage } = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: FIXTURE_COUNT, offset: 0 });
    expect(hasNextPage).toBe(false);
  });

  it("hasNextPage is true when a full page plus at least one more fixture row exists", async () => {
    const database = await getDb();
    if (!database) return;

    const smallPage = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: FIXTURE_COUNT - 1, offset: 0 });
    expect(smallPage.hasNextPage).toBe(true);
  });

  it("sort=new orders by createdAt desc with id desc as a tie-breaker", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: FIXTURE_COUNT, offset: 0 });
    expect(items.length).toBe(FIXTURE_COUNT);
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const curr = items[i];
      if (prev.createdAt.getTime() === curr.createdAt.getTime()) {
        expect(prev.id).toBeGreaterThan(curr.id);
      } else {
        expect(prev.createdAt.getTime()).toBeGreaterThanOrEqual(curr.createdAt.getTime());
      }
    }
  });

  it("ordering (and therefore pagination) is stable/deterministic across repeated identical queries", async () => {
    const database = await getDb();
    if (!database) return;

    const first = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: 20, offset: 0 });
    const second = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: 20, offset: 0 });
    expect(second.items.map((n) => n.id)).toEqual(first.items.map((n) => n.id));
  });

  it("search + filter + sort compose correctly together (isolated free-episode fixture)", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "popular", filter: "free", search: FREE_TAG, limit: 20, offset: 0 });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(freeNovelId);
    expect(items[0].freeEpisodeCount).toBeGreaterThan(0);
    expect(items[0].title.toLowerCase()).toContain(FREE_TAG.toLowerCase());
  });

  it("search scoping itself is exact - the fixture tag never matches any other novel", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: 1000, offset: 0 });
    expect(items.every((n) => novelIds.includes(n.id))).toBe(true);
  });

  it("DTO returns only the lightweight fields the card needs - no heavy/internal columns", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", search: TAG, limit: 1, offset: 0 });
    if (items.length === 0) return;

    const keys = Object.keys(items[0]).sort();
    expect(keys).toEqual(["coverImageUrl", "createdAt", "freeEpisodeCount", "id", "slug", "storyStatus", "title"].sort());
  });
});
