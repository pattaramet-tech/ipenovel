/**
 * Pure pagination-clamping logic for AdminUsersPage - kept in its own,
 * React-free module specifically so it can be unit tested directly. This
 * repo's unit test project runs in a Node environment with no DOM/React
 * Testing Library available (see vitest.config.ts), so a real
 * component-mount test isn't possible here without adding a new test
 * dependency, which this fix does not do. AdminUsersPage.tsx's
 * pagination-clamp effect calls this exact function rather than a
 * duplicated inline reimplementation, so testing this module IS testing
 * the component's actual clamping decision, not merely similar-looking
 * logic living in two places that could drift apart.
 *
 * PR #45 review finding "Reset pages that become out of range": when an
 * edit shrinks the filtered result set (e.g. the sole user on page 2 of a
 * 2-page result is edited such that it no longer matches the active
 * filter), the invalidated admin.users.list query returns a SMALLER
 * totalPages while the component's own `page` state is still whatever
 * the admin was last viewing - previously nothing ever corrected that, so
 * the page showed an empty table with no way back to page 1 without
 * touching another filter first.
 */

export type PaginationClampDecision = { shouldUpdate: false } | { shouldUpdate: true; nextPage: number };

/**
 * Decides whether `currentPage` needs to change given the server's own
 * `totalPages` for the current query. `totalPages` is treated as having a
 * UI-facing floor of 1 - page numbering starts at 1 even when the result
 * set is genuinely empty (`totalPages: 0` from the server means "show
 * page 1, with an empty state", never "no valid page exists").
 *
 * Returns `{ shouldUpdate: false }` whenever `currentPage` is already
 * within `[1, normalizedTotalPages]` - crucially, NEVER a `nextPage`
 * equal to `currentPage` - so a caller that only updates state on
 * `shouldUpdate: true` cannot loop: repeated calls with an already-valid
 * page are a structural no-op, not just an incidental one.
 */
export function computePaginationClamp(currentPage: number, totalPages: number): PaginationClampDecision {
  const normalizedTotalPages = Math.max(1, totalPages);
  const nextPage =
    currentPage < 1 ? 1 : currentPage > normalizedTotalPages ? normalizedTotalPages : currentPage;
  return nextPage === currentPage ? { shouldUpdate: false } : { shouldUpdate: true, nextPage };
}
