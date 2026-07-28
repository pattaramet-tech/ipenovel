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

/**
 * Which specific "not authenticated" outcome occurred - lets createContext
 * decide whether the session cookie itself needs clearing, without
 * re-parsing the request:
 *  - "no_cookie": no session cookie was sent at all. Never worth clearing
 *    (there is nothing to clear) and never logged.
 *  - "invalid_session_token": a cookie WAS present but verifySession
 *    rejected it (malformed, expired, wrong issuer/audience/appId,
 *    unsupported algorithm, or the wrong shape). The browser is holding a
 *    cookie that can never become valid again, so createContext clears it.
 *  - "no_user_record" / "admin_session_invalid": the token verified fine
 *    (real signature, correct issuer/audience/appId) but no database
 *    record backs it (deleted account) or a local admin session's account
 *    no longer has the admin role. Deliberately NOT cleared - unlike a
 *    structurally-invalid token, this is a legitimate, correctly-signed
 *    credential whose backing account state changed; clearing it isn't
 *    required to stop any log-flooding or retry loop, and is out of this
 *    fix's scope.
 */
export type AnonymousCredentialReason =
  | "no_cookie"
  | "invalid_session_token"
  | "no_user_record"
  | "admin_session_invalid";

export class AnonymousCredentialError extends Error {
  readonly reason: AnonymousCredentialReason;

  constructor(message: string, reason: AnonymousCredentialReason) {
    super(message);
    this.name = "AnonymousCredentialError";
    this.reason = reason;
  }
}

export function isAnonymousCredentialError(error: unknown): error is AnonymousCredentialError {
  return error instanceof AnonymousCredentialError;
}
