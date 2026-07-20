import { describe, it, expect } from "vitest";
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

describe("getBrowseCatalog - pagination correctness (DB required)", () => {
  it("default page returns at most pageSize items", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 20, offset: 0 });
    expect(items.length).toBeLessThanOrEqual(20);
  });

  it("page 2 never repeats an id from page 1 (static data)", async () => {
    const database = await getDb();
    if (!database) return;

    const page1 = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 5, offset: 0 });
    const page2 = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 5, offset: 5 });
    const page1Ids = new Set(page1.items.map((n) => n.id));
    const overlap = page2.items.filter((n) => page1Ids.has(n.id));
    expect(overlap).toHaveLength(0);
  });

  it("hasNextPage is false when fewer rows exist than the page size", async () => {
    const database = await getDb();
    if (!database) return;

    // A limit far larger than any realistic catalog size guarantees this
    // page is the last one - hasNextPage must never be true here.
    const { hasNextPage } = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 1_000_000, offset: 0 });
    expect(hasNextPage).toBe(false);
  });

  it("hasNextPage is true when a full page plus at least one more row exists", async () => {
    const database = await getDb();
    if (!database) return;

    // Establish the true total first via a large fetch, then re-query at a
    // page size 1 smaller than that total - there must be a next page.
    const all = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 1_000_000, offset: 0 });
    if (all.items.length < 2) return; // not enough fixture data to prove this meaningfully

    const smallPage = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: all.items.length - 1, offset: 0 });
    expect(smallPage.hasNextPage).toBe(true);
  });

  it("sort=new orders by createdAt desc with id desc as a tie-breaker", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 100, offset: 0 });
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

    const first = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 20, offset: 0 });
    const second = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 20, offset: 0 });
    expect(second.items.map((n) => n.id)).toEqual(first.items.map((n) => n.id));
  });

  it("search + filter + sort compose correctly together", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "popular", filter: "free", search: "a", limit: 20, offset: 0 });
    for (const novel of items) {
      expect(novel.freeEpisodeCount).toBeGreaterThan(0);
      expect(novel.title.toLowerCase()).toContain("a");
    }
  });

  it("DTO returns only the lightweight fields the card needs - no heavy/internal columns", async () => {
    const database = await getDb();
    if (!database) return;

    const { items } = await db.getBrowseCatalog({ sort: "new", filter: "all", limit: 1, offset: 0 });
    if (items.length === 0) return;

    const keys = Object.keys(items[0]).sort();
    expect(keys).toEqual(["coverImageUrl", "createdAt", "freeEpisodeCount", "id", "slug", "storyStatus", "title"].sort());
  });
});
