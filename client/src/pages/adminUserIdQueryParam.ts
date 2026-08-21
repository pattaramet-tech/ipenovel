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

/**
 * The raw-input form of `withUserIdSearchParam`, composed from
 * `parseUserIdQueryParam` + `withUserIdSearchParam` so a filter box's
 * onChange can write straight through to the URL without restating the
 * validation rule.
 *
 * PR #45 review finding "Synchronize edited top-up user IDs into the URL":
 * AdminTopupLogsPage's User ID box only ever updated local state, so
 * editing it from a `?userId=5` link switched the table to the new user
 * while the URL still said 5 - a refresh (or a copied link) then snapped
 * the view back to 5 via the URL-to-state effect.
 *
 * An empty OR invalid input both REMOVE `userId` rather than leaving the
 * previous id stranded in the URL: the API drops the filter for both
 * cases identically (see readUserIdFromSearchParams), so the URL must
 * describe that same "no filter" state or a refresh would resurrect an id
 * the screen is no longer filtering by. Every other param is preserved
 * and `prev` is never mutated.
 */
export function withUserIdInputSearchParam(
  prev: URLSearchParams,
  rawInput: string | null | undefined
): URLSearchParams {
  return withUserIdSearchParam(prev, parseUserIdQueryParam(rawInput));
}

/**
 * Decides what a User ID filter box should display when the URL's
 * `userId` changes, given what the box currently holds.
 *
 * Returns `currentInput` UNCHANGED (the identical string, so a React
 * `setState` call bails out instead of re-rendering) whenever the box
 * already expresses exactly the filter the URL names - including when
 * both mean "no filter at all". That case is what keeps half-typed
 * invalid text alive: typing `5a` into a `?userId=5` page removes the
 * param, and without this guard the URL-to-state effect would immediately
 * wipe the box back to empty as the user typed.
 *
 * Anything else is a genuinely external change - browser back/forward, a
 * fresh `?userId=` link, or the param being removed elsewhere - and the
 * URL wins.
 */
export function syncUserIdInputFromUrl(
  currentInput: string,
  urlUserId: number | undefined
): string {
  if (parseUserIdQueryParam(currentInput) === urlUserId) return currentInput;
  return urlUserId !== undefined ? String(urlUserId) : "";
}
