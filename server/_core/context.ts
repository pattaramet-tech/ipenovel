import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { isAnonymousCredentialError } from "./authErrors";
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
