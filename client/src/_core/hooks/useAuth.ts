import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { useCallback, useEffect, useMemo } from "react";
import { clearLegacyAuthLocalStorageFromWindow } from "./authClientStorage";
import { classifyLogoutFailure } from "./logoutOutcome";
import { resolveUnauthorizedRedirectPath } from "./unauthorizedRedirect";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = getLoginUrl() } =
    options ?? {};
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

  // Narrow, path-aware redirect - see resolveUnauthorizedRedirectPath's
  // docstring: /admin and /admin/* go back to /admin/login (a local
  // email/password session, never OAuth), every other route keeps going to
  // the OAuth login flow, and /admin/login itself is never redirected
  // (would otherwise strand the login form in a loop). Only reacts to
  // "no session" (state.user is null) - never to FORBIDDEN (a real,
  // signed-in user whose role just isn't admin), which is a
  // fundamentally different state this effect must never touch.
  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;

    const target = resolveUnauthorizedRedirectPath(window.location.pathname, redirectPath);
    if (!target) return;

    window.location.href = target;
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
