import { describe, expect, it } from "vitest";
import {
  deriveProfileWishlistPresentation,
  buildWishlistIdByNovelId,
  PROFILE_WISHLIST_DEFAULT_LIMIT,
  type ProfileWishlistItem,
} from "./profileWishlistPresentation";

function makeItem(id: number, overrides: Partial<ProfileWishlistItem> = {}): ProfileWishlistItem {
  return {
    wishlistId: id,
    novelId: id,
    addedAt: new Date(2026, 0, id),
    novel: {
      id,
      title: `นิยายเรื่องที่ ${id}`,
      slug: `novel-${id}`,
      description: null,
      coverImageUrl: null,
      storyStatus: "ongoing",
    },
    ...overrides,
  };
}

function makeItems(count: number): ProfileWishlistItem[] {
  return Array.from({ length: count }, (_, i) => makeItem(i + 1));
}

describe("deriveProfileWishlistPresentation", () => {
  it("returns the loading view while isLoading is true, regardless of items", () => {
    const result = deriveProfileWishlistPresentation({
      isLoading: true,
      isError: false,
      items: makeItems(3),
      expanded: false,
    });
    expect(result.view).toBe("loading");
    expect(result.visibleItems).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it("returns the error view when isError is true (takes priority over loading being already false)", () => {
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: true,
      items: undefined,
      expanded: false,
    });
    expect(result.view).toBe("error");
    expect(result.visibleItems).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it("returns the empty view when there are no items", () => {
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items: [],
      expanded: false,
    });
    expect(result.view).toBe("empty");
    expect(result.totalCount).toBe(0);
  });

  it("returns ready with all items shown and no collapse/expand affordance when count < 8", () => {
    const items = makeItems(5);
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    expect(result.view).toBe("ready");
    expect(result.totalCount).toBe(5);
    expect(result.visibleItems).toHaveLength(5);
    expect(result.hasMore).toBe(false);
    expect(result.showCollapse).toBe(false);
  });

  it("returns ready with all items shown and no collapse/expand affordance when count === 8 (the default limit)", () => {
    const items = makeItems(PROFILE_WISHLIST_DEFAULT_LIMIT);
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    expect(result.view).toBe("ready");
    expect(result.totalCount).toBe(8);
    expect(result.visibleItems).toHaveLength(8);
    expect(result.hasMore).toBe(false);
    expect(result.showCollapse).toBe(false);
  });

  it("returns only the first 8 items and hasMore:true when count > 8 and not expanded", () => {
    const items = makeItems(12);
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    expect(result.view).toBe("ready");
    expect(result.totalCount).toBe(12);
    expect(result.visibleItems).toHaveLength(8);
    expect(result.visibleItems.map((i) => i.wishlistId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.hasMore).toBe(true);
    expect(result.showCollapse).toBe(false);
  });

  it("returns every item and showCollapse:true when count > 8 and expanded", () => {
    const items = makeItems(12);
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: true,
    });
    expect(result.view).toBe("ready");
    expect(result.totalCount).toBe(12);
    expect(result.visibleItems).toHaveLength(12);
    expect(result.hasMore).toBe(true);
    expect(result.showCollapse).toBe(true);
  });

  it("defensively drops rows with a missing/null novel instead of crashing", () => {
    const items = [
      makeItem(1),
      { ...makeItem(2), novel: null } as unknown as ProfileWishlistItem,
      makeItem(3),
    ];
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    expect(result.view).toBe("ready");
    expect(result.totalCount).toBe(2);
    expect(result.visibleItems.map((i) => i.wishlistId)).toEqual([1, 3]);
  });

  it("never mutates the original items array (order, length, and contents all unchanged)", () => {
    const items = makeItems(12);
    const snapshot = items.slice();

    deriveProfileWishlistPresentation({ isLoading: false, isError: false, items, expanded: false });
    deriveProfileWishlistPresentation({ isLoading: false, isError: false, items, expanded: true });

    expect(items).toEqual(snapshot);
    expect(items).toHaveLength(12);
  });

  it("totalCount only counts valid (novel-having) rows, not the raw input length", () => {
    const items = [
      makeItem(1),
      { ...makeItem(2), novel: undefined } as unknown as ProfileWishlistItem,
      makeItem(3),
      { ...makeItem(4), novel: null } as unknown as ProfileWishlistItem,
    ];
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    expect(items).toHaveLength(4);
    expect(result.totalCount).toBe(2);
  });

  it("treats undefined items (query not yet settled with data) as zero items, not a crash", () => {
    const result = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items: undefined,
      expanded: false,
    });
    expect(result.view).toBe("empty");
    expect(result.totalCount).toBe(0);
  });
});

describe("buildWishlistIdByNovelId", () => {
  it("resolves a valid row's wishlistId from its novelId", () => {
    const items = [makeItem(1), makeItem(2), makeItem(3)];
    const map = buildWishlistIdByNovelId(items);
    expect(map.get(1)).toBe(1);
    expect(map.get(2)).toBe(2);
    expect(map.get(3)).toBe(3);
    expect(map.size).toBe(3);
  });

  it("resolves the correct wishlistId even when it differs from novelId", () => {
    const items = [makeItem(1, { wishlistId: 501, novel: { ...makeItem(1).novel, id: 1 } })];
    const map = buildWishlistIdByNovelId(items);
    expect(map.get(1)).toBe(501);
  });

  it("excludes a row whose novel is null", () => {
    const items = [makeItem(1), { ...makeItem(2), novel: null } as unknown as ProfileWishlistItem, makeItem(3)];
    const map = buildWishlistIdByNovelId(items);
    expect(map.has(2)).toBe(false);
    expect(map.size).toBe(2);
  });

  it("excludes a row whose novel is undefined", () => {
    const items = [makeItem(1), { ...makeItem(2), novel: undefined } as unknown as ProfileWishlistItem];
    const map = buildWishlistIdByNovelId(items);
    expect(map.size).toBe(1);
    expect(map.has(1)).toBe(true);
  });

  it("excludes a row with a non-finite novel.id (NaN, Infinity)", () => {
    const items = [
      makeItem(1),
      { ...makeItem(2), novel: { ...makeItem(2).novel, id: NaN } },
      { ...makeItem(3), novel: { ...makeItem(3).novel, id: Infinity } },
    ];
    const map = buildWishlistIdByNovelId(items);
    expect(map.size).toBe(1);
    expect(map.has(1)).toBe(true);
  });

  it("returns an empty map for undefined input", () => {
    const map = buildWishlistIdByNovelId(undefined);
    expect(map.size).toBe(0);
  });

  it("returns an empty map for an empty array", () => {
    const map = buildWishlistIdByNovelId([]);
    expect(map.size).toBe(0);
  });

  it("uses the exact same validity rule as deriveProfileWishlistPresentation - a row excluded from one is excluded from the other", () => {
    const items = [
      makeItem(1),
      { ...makeItem(2), novel: null } as unknown as ProfileWishlistItem,
      makeItem(3),
    ];

    const presentation = deriveProfileWishlistPresentation({
      isLoading: false,
      isError: false,
      items,
      expanded: false,
    });
    const map = buildWishlistIdByNovelId(items);

    expect(presentation.totalCount).toBe(map.size);
    expect(presentation.visibleItems.every((item) => map.has(item.novel.id))).toBe(true);
  });
});
