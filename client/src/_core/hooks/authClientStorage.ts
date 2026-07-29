/**
 * Pure, DOM-free helpers for useAuth's localStorage handling - extracted so
 * they can be unit-tested without a component/DOM harness (this repo has
 * none; see client/src/components/dailyCheckinPresentation.ts for the same
 * pattern).
 *
 * The signed-in user's source of truth is the HttpOnly session cookie plus
 * the `auth.me` query (and React Query's in-memory cache) - never
 * localStorage. This app used to write two things to localStorage that
 * granted or implied access on their own:
 *   - "manus-runtime-user-info": the full `auth.me` result, on every render.
 *   - "admin-session": an `{ adminId, timestamp }` flag written by
 *     AdminLoginPage on admin login success, which AdminDashboard then
 *     OR'd into its own admin check (`isAdminLoggedIn || user.role ===
 *     "admin"`) - so a stale/forged value here alone could make the client
 *     believe it was an admin even when `auth.me` said otherwise. Both
 *     writes are gone (Auth Phase 2A), but a browser that visited before
 *     this change may still have either key sitting in storage, so both are
 *     actively cleared (never read) instead of just left alone.
 *
 * This module is a cleanup mechanism, NOT a source of truth: it only ever
 * calls `removeItem`, never `getItem`, and never feeds a value back into any
 * auth decision.
 */
export const LEGACY_AUTH_LOCALSTORAGE_KEY = "manus-runtime-user-info";
/** Auth Phase 2A: the old client-side "am I an admin" flag - see the module docstring above. */
export const LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY = "admin-session";
export const LEGACY_AUTH_LOCALSTORAGE_KEYS = [
  LEGACY_AUTH_LOCALSTORAGE_KEY,
  LEGACY_ADMIN_SESSION_LOCALSTORAGE_KEY,
] as const;

type RemovableStorage = Pick<Storage, "removeItem">;

/**
 * Removes every legacy auth-adjacent key (see LEGACY_AUTH_LOCALSTORAGE_KEYS).
 * Safe to call when storage is unavailable/undefined (SSR, or a browser with
 * localStorage disabled). Each key is removed in its own try/catch so one
 * throwing (Safari private-mode quota, disabled storage) never stops the
 * others from being attempted - clearing a legacy key is best-effort and
 * must never be fatal, for any key.
 */
export function clearLegacyAuthLocalStorage(storage: RemovableStorage | null | undefined): void {
  if (!storage) return;
  for (const key of LEGACY_AUTH_LOCALSTORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort only.
    }
  }
}

type WindowLike = { localStorage?: RemovableStorage | null };

/**
 * Same as clearLegacyAuthLocalStorage, but takes the `window`-like object
 * itself rather than an already-resolved storage reference, and reads its
 * `.localStorage` property from *inside* this function's try/catch.
 *
 * That distinction matters: in some browsers/embedded contexts, merely
 * reading the `window.localStorage` property (its getter, before any method
 * on it is ever called) can throw a `SecurityError`. A caller that writes
 * `clearLegacyAuthLocalStorage(window.localStorage)` evaluates that property
 * access as an argument expression BEFORE entering the callee - outside any
 * try/catch this function provides - so that throw would be uncaught. This
 * function accepts `window` itself instead, so the property read happens
 * here, already guarded.
 */
export function clearLegacyAuthLocalStorageFromWindow(windowLike: WindowLike | null | undefined): void {
  if (!windowLike) return;
  try {
    clearLegacyAuthLocalStorage(windowLike.localStorage);
  } catch {
    // Reading the `.localStorage` property itself threw - best-effort only.
  }
}
