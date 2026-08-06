// Pure logic backing ProfilePage's "รายการอยากอ่าน" (Wishlist) section - kept
// out of the component itself (same pattern as profileGoogleConnectStatus.ts/
// checkoutOutcome.ts/dailyCheckinPresentation.ts elsewhere in this codebase)
// so it's directly testable without a DOM harness (this repo has none - no
// @testing-library/jsdom installed).

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** Single source of truth: the exact shape server/db.ts's
 *  getWishlistNovelsByUserId (via the wishlists.list procedure) returns -
 *  never hand-duplicated here, so the two can never drift apart. */
export type ProfileWishlistItem = RouterOutputs["wishlists"]["list"][number];

export type ProfileWishlistView = "loading" | "error" | "empty" | "ready";

export const PROFILE_WISHLIST_DEFAULT_LIMIT = 8;

export type ProfileWishlistPresentation = {
  view: ProfileWishlistView;
  totalCount: number;
  visibleItems: ProfileWishlistItem[];
  hasMore: boolean;
  showCollapse: boolean;
};

/**
 * Derives everything ProfilePage's Wishlist section needs to render from
 * the raw query state - state precedence is loading, then error, then
 * empty, then ready (a query that's simultaneously loading/erroring never
 * happens in practice with React Query, but the explicit order removes any
 * ambiguity either way).
 *
 * `items` is trusted to already be server-filtered (published novels only,
 * newest wishlist first - see db.getWishlistNovelsByUserId) - this function
 * does not re-filter by publication status or re-sort. It only defends
 * against a structurally broken row (missing `novel`), which the real API
 * should never produce, but a defensive filter here is cheap insurance
 * against a `.length`/`.title` crash if it ever did.
 */
export function deriveProfileWishlistPresentation(input: {
  isLoading: boolean;
  isError: boolean;
  items: ProfileWishlistItem[] | undefined;
  expanded: boolean;
  initialLimit?: number;
}): ProfileWishlistPresentation {
  const limit = input.initialLimit ?? PROFILE_WISHLIST_DEFAULT_LIMIT;
  const validItems = (input.items ?? []).filter(
    (item): item is ProfileWishlistItem => Boolean(item && item.novel)
  );
  const totalCount = validItems.length;

  if (input.isLoading) {
    return { view: "loading", totalCount: 0, visibleItems: [], hasMore: false, showCollapse: false };
  }

  if (input.isError) {
    return { view: "error", totalCount: 0, visibleItems: [], hasMore: false, showCollapse: false };
  }

  if (totalCount === 0) {
    return { view: "empty", totalCount: 0, visibleItems: [], hasMore: false, showCollapse: false };
  }

  const hasMore = totalCount > limit;
  const visibleItems = input.expanded || !hasMore ? validItems.slice() : validItems.slice(0, limit);

  return {
    view: "ready",
    totalCount,
    visibleItems,
    hasMore,
    // Only meaningful (and only ever shown) once actually expanded past a
    // list that has more than `limit` items to collapse back down to.
    showCollapse: hasMore && input.expanded,
  };
}
