import { COOKIE_NAME } from "@shared/const";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { isAnonymousCredentialError } from "./authErrors";
import { getSessionCookieOptions } from "./cookies";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    if (isAnonymousCredentialError(error)) {
      // Expected: no cookie, malformed/expired JWT, wrong appId/issuer/
      // audience/algorithm, or no matching user record. Authentication is
      // optional for public procedures, so this resolves as anonymous
      // rather than failing the request.
      user = null;

      // A structurally invalid token (malformed/expired/wrong issuer,
      // audience, appId, or algorithm) can never become valid again - the
      // browser sending it will otherwise keep resending the same dead
      // cookie on every request until it happens to sign in again. Clear
      // it now, with the exact same name/options logout uses, so this is
      // self-healing after one round trip. Never done for "no_cookie"
      // (nothing to clear, and would be an unnecessary Set-Cookie on every
      // anonymous request) or for the "verified fine, but no matching
      // account" cases (a legitimately-signed credential, not a broken
      // one - see authErrors.ts). Also cleared for "forced_relogin" - a
      // session predating AUTH_FORCE_RELOGIN_AFTER's cutoff is, by policy,
      // exactly as dead as a structurally invalid one; clearing it the same
      // way makes the browser stop resending it after one round trip
      // instead of hitting this rejection on every subsequent request.
      if (error.reason === "invalid_session_token" || error.reason === "forced_relogin") {
        const cookieOptions = getSessionCookieOptions(opts.req);
        opts.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      }
    } else {
      // Unexpected: a database failure, an OAuth provider/infrastructure
      // failure, a missing server secret, or any other programming error.
      // This must NOT silently resolve as "anonymous" - that would make an
      // infrastructure outage indistinguishable from a normal logged-out
      // visitor, and could make an actually-still-logged-in user appear
      // logged out. Log a sanitized summary server-side (never the raw
      // error, stack, cookie, or JWT) and rethrow so the request fails
      // with a generic error instead - see server/_core/trpc.ts's
      // errorFormatter, which already replaces any non-allowlisted error
      // with a safe generic message before it reaches the client.
      console.error("[Auth] createContext: unexpected authentication failure:", safeErrorSummary(error));
      throw error;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
