/**
 * Pure, React-free helpers for the `?userId=` query parameter shared by
 * AdminOrdersPage and AdminTopupLogsPage - both pages read this same URL
 * parameter (set by AdminUsersPage's row actions, "ดูออเดอร์"/
 * "ดูประวัติเติมเงิน") and must apply the identical strict-positive-integer
 * validation and query-string read/write behavior. Kept in its own module
 * so it can be unit tested directly without a component-mount harness -
 * this repo's unit test project runs in a Node environment with no DOM/
 * React Testing Library available (same pattern as
 * client/src/pages/adminUsersPagination.ts).
 *
 * PR #45 review finding: wouter's `useLocation()` in this app only ever
 * returns the pathname, never the query string (the repo's own
 * NovelsPage.tsx already documents and works around this via
 * `useSearchParams()`) - both AdminOrdersPage and AdminTopupLogsPage were
 * instead reading `location.split("?")[1]`, which is not reactive to
 * back/forward navigation or to `useLocation()`'s own non-search-aware
 * pathname value, and in AdminTopupLogsPage's case never actually saw the
 * query string at all. Both pages now read/write `userId` exclusively
 * through wouter's `useSearchParams()` and these shared helpers.
 */

/**
 * Strict positive-integer parse - never NaN, never 0, never negative,
 * never a decimal, and never a value with trailing garbage (unlike
 * `parseInt`, which silently accepts "5abc" as 5). Returns `undefined`
 * for anything that is not EXACTLY a positive integer literal, including
 * `null`/`undefined`/the empty string.
 */
export function parseUserIdQueryParam(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  return /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

/**
 * Reads and validates `userId` directly off a URLSearchParams instance -
 * the single entry point both pages use instead of re-deriving the same
 * regex/parse logic inline. An invalid or missing value both resolve to
 * `undefined` - callers must treat the two identically ("no filter
 * applied"), never distinguish "present but invalid" as a separate state.
 */
export function readUserIdFromSearchParams(searchParams: URLSearchParams): number | undefined {
  return parseUserIdQueryParam(searchParams.get("userId"));
}

/**
 * Returns a NEW URLSearchParams with `userId` set (a valid id) or removed
 * (`userId` is `null`/`undefined`) - every OTHER existing param is
 * preserved unchanged. Never mutates `prev`. Intended to be passed
 * directly to wouter's `setSearchParams((prev) => ...)` callback form.
 */
export function withUserIdSearchParam(
  prev: URLSearchParams,
  userId: number | null | undefined
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (userId === null || userId === undefined) {
    next.delete("userId");
  } else {
    next.set("userId", String(userId));
  }
  return next;
}
