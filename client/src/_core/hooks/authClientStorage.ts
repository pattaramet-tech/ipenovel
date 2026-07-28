/**
 * Pure, DOM-free helpers for useAuth's localStorage handling - extracted so
 * they can be unit-tested without a component/DOM harness (this repo has
 * none; see client/src/components/dailyCheckinPresentation.ts for the same
 * pattern).
 *
 * The signed-in user's source of truth is the HttpOnly session cookie plus
 * the `auth.me` query (and React Query's in-memory cache) - never
 * localStorage. This app used to write the full `auth.me` result to this
 * key on every render; that write is gone, but a browser that visited
 * before this change may still have the key sitting in storage, so it is
 * actively cleared instead of just left alone.
 */
export const LEGACY_AUTH_LOCALSTORAGE_KEY = "manus-runtime-user-info";

type RemovableStorage = Pick<Storage, "removeItem">;

/**
 * Removes the legacy full-user-object cache. Safe to call when storage is
 * unavailable/undefined (SSR, or a browser with localStorage disabled) or
 * when it throws (Safari private-mode quota, disabled storage) - clearing a
 * legacy key is best-effort and must never be fatal.
 */
export function clearLegacyAuthLocalStorage(storage: RemovableStorage | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_AUTH_LOCALSTORAGE_KEY);
  } catch {
    // Best-effort only.
  }
}
