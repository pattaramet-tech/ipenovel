import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { resolveUnauthorizedRedirectTarget, type UnauthorizedRedirectTarget } from "./unauthorizedRedirect";

/**
 * Pure decision for client/src/main.tsx's global QueryCache/MutationCache
 * error subscriptions: given whatever error either cache just caught and
 * the current pathname, what should happen. Never touches
 * window/location/getLoginUrl() itself - see redirectToLoginIfUnauthorized
 * below, which applies the result via injected callbacks so this stays
 * unit-testable without a DOM.
 *
 * Only ever fires for a genuine UNAUTHORIZED (message match against the
 * same UNAUTHED_ERR_MSG the server's `protectedProcedure`/`adminProcedure`
 * middleware use - see server/_core/trpc.ts) - a FORBIDDEN error
 * (NOT_ADMIN_ERR_MSG, a different message) or any other error (network
 * failure, 5xx, validation) returns "none" and is left alone. Once
 * confirmed UNAUTHORIZED, delegates the actual redirect TARGET to the same
 * resolveUnauthorizedRedirectTarget useAuth.ts and AdminLayout.tsx use, so
 * all three never disagree about /admin/* vs everything else.
 */
export function resolveGlobalUnauthorizedRedirect(error: unknown, pathname: string): UnauthorizedRedirectTarget {
  if (!(error instanceof TRPCClientError)) return "none";
  if (error.message !== UNAUTHED_ERR_MSG) return "none";
  return resolveUnauthorizedRedirectTarget(pathname);
}

/**
 * Applies resolveGlobalUnauthorizedRedirect's decision. `applyRedirect` and
 * `getOauthLoginUrl` are injected (rather than this function reaching for
 * `window`/`getLoginUrl` itself) purely so this is testable with plain
 * spies - production call sites pass `(url) => { window.location.href =
 * url; }` and the real `getLoginUrl`. `getOauthLoginUrl` is only ever
 * invoked for the "oauth" target - never unconditionally - so an
 * /admin/* UNAUTHORIZED never depends on OAuth config being present.
 */
export function redirectToLoginIfUnauthorized(
  error: unknown,
  pathname: string,
  applyRedirect: (url: string) => void,
  getOauthLoginUrl: () => string
): void {
  const target = resolveGlobalUnauthorizedRedirect(error, pathname);
  if (target === "none") return;
  applyRedirect(target === "admin_login" ? "/login" : getOauthLoginUrl());
}
