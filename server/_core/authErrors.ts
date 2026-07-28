/**
 * Distinguishes an EXPECTED "this request just isn't authenticated" outcome
 * (no cookie, malformed/expired JWT, wrong appId/issuer/audience/algorithm,
 * or a verified token with no matching user record) from every other
 * failure (database down, OAuth provider unreachable, missing server
 * config, an unexpected programming error).
 *
 * Only AnonymousCredentialError may ever cause createContext to resolve
 * `user: null` - see server/_core/context.ts. Anything else must propagate
 * so it surfaces as a real error instead of silently pretending the visitor
 * is logged out (which, for infrastructure failures, is actively
 * misleading - see docs referenced in context.ts).
 */
export class AnonymousCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnonymousCredentialError";
  }
}

export function isAnonymousCredentialError(error: unknown): error is AnonymousCredentialError {
  return error instanceof AnonymousCredentialError;
}
