import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { useCallback, useEffect, useMemo } from "react";
import { clearLegacyAuthLocalStorageFromWindow } from "./authClientStorage";
import { classifyLogoutFailure } from "./logoutOutcome";
import { resolveUnauthorizedRedirectTarget } from "./unauthorizedRedirect";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false } = options ?? {};
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (classifyLogoutFailure(error) === "unexpected_error") {
        // A network failure, a 5xx, a timeout - NOT proof the session is
        // invalid. Deliberately does NOT touch the auth.me cache here: a
        // transient logout failure must never make an otherwise-valid
        // session look logged out. Rethrow so the caller (e.g. AdminLayout)
        // knows the logout did not actually happen and can show an error
        // without navigating away.
        throw error;
      }
      // classifyLogoutFailure returned "already_logged_out" (UNAUTHORIZED) -
      // falls through to the same cache-clear as a genuine success below,
      // since "no session" is exactly the end state logout was trying to
      // reach.
    }

    utils.auth.me.setData(undefined, null);
    await utils.auth.me.invalidate();
  }, [logoutMutation, utils]);

  // Source of truth for the signed-in user is the HttpOnly session cookie +
  // this auth.me query (and React Query's own cache) - the full user object
  // is never persisted to localStorage. Runs once on mount (not tied to
  // meQuery.data) purely to clean up a legacy key a browser may still have
  // from before this change; see authClientStorage.ts. Deliberately passes
  // `window` itself, not its localStorage property - reading that property
  // can itself throw in some browsers, and that access must happen inside
  // clearLegacyAuthLocalStorageFromWindow's own try/catch, not here.
  useEffect(() => {
    clearLegacyAuthLocalStorageFromWindow(typeof window === "undefined" ? null : window);
  }, []);

  const state = useMemo(() => {
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      // Specifically auth.me's own error, never the logout mutation's -
      // see resolveAdminAccessState's authMeError param docstring for why
      // that distinction matters (a failed Logout click must never look
      // like "the whole session is broken").
      authMeError: meQuery.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
      // Distinct from `loading` (which also covers the initial auth.me
      // fetch) so a caller that only cares about "is a logout in flight
      // right now" - e.g. to disable a Logout button and prevent a
      // double-click double-submit - doesn't have to reason about whether
      // `loading` is true for that reason or because auth.me just hasn't
      // resolved yet.
      isLoggingOut: logoutMutation.isPending,
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  // Narrow, path-aware redirect - see resolveUnauthorizedRedirectTarget's
  // docstring: /admin and /admin/* go back to the literal /login page
  // (there is no separate local admin login anymore - an admin signs in
  // through the exact same Manus/Google/transition flow as everyone else),
  // every other route keeps going to the OAuth login flow, and /login
  // itself is never redirected (would otherwise strand the login form in a
  // loop). getLoginUrl() is only ever called for the "oauth" target - never
  // unconditionally, so an admin route never depends on OAuth config being
  // present just to decide "no redirect needed here."
  //
  // Only reacts to a CONFIRMED "no session" (meQuery settled, no error, and
  // state.user is null). Never redirects while auth.me is still loading,
  // and - just as importantly - never redirects when auth.me itself failed
  // with an infrastructure error (meQuery.error): that failure means we
  // don't actually know whether there's a session or not, so treating it
  // as "definitely logged out" would be wrong and could redirect an
  // otherwise-valid admin away from the page they were on. Never reacts to
  // FORBIDDEN either (a real, signed-in user whose role just isn't admin) -
  // a fundamentally different state this effect must never touch.
  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (meQuery.error) return;
    if (state.user) return;
    if (typeof window === "undefined") return;

    const target = resolveUnauthorizedRedirectTarget(window.location.pathname);
    if (target === "none") return;
    window.location.href = target === "admin_login" ? "/login" : getLoginUrl();
  }, [
    redirectOnUnauthenticated,
    logoutMutation.isPending,
    meQuery.isLoading,
    meQuery.error,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
