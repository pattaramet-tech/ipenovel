import { AXIOS_TIMEOUT_MS, COOKIE_NAME, SESSION_JWT_ISSUER, SESSION_TTL_MS, SESSION_TTL_SECONDS } from "@shared/const";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { AnonymousCredentialError } from "./authErrors";
import { ENV, isManusAuthActive } from "./env";
import { normalizeProviderName } from "./providerName";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  // Optional/nullable - a provider (e.g. Apple) may never send a name, or
  // may only send one on the very first login. A session must remain valid
  // without one; see normalizeProviderName.
  name?: string | null;
  // Reader Session Controls (R2): v2 tokens carry a random 128-bit session id
  // and a token-format version. v1 (legacy) payloads leave both undefined.
  sid?: string;
  tv?: number;
};

export type VerifiedSession = {
  openId: string;
  appId: string;
  name: string | null;
  // R2: the `sid` claim (v2 tokens); null for legacy v1 tokens.
  sid: string | null;
  // R3/F7: the verified JWT `exp` claim (seconds) — expiry deadlines derive
  // from THIS claim, never from the default TTL assumption.
  expSeconds: number;
  // Epoch seconds from the JWT's own `iat` claim (always present - every
  // token this codebase issues is signed via signSession's .setIssuedAt()).
  // Used by isSessionIssuedBeforeCutoff/authenticateRequest to enforce
  // AUTH_FORCE_RELOGIN_AFTER - never trusted from anywhere except this
  // already-signature-verified claim.
  issuedAtSeconds: number;
};

/**
 * Pure decision: should this session be rejected right now because it was
 * issued before the AUTH_FORCE_RELOGIN_AFTER cutoff?
 *
 * A cutoff in the FUTURE is a scheduled activation, not an immediate one -
 * it must never reject anything until the clock actually reaches it. An
 * earlier version of this function compared `issuedAtSeconds < cutoffSeconds`
 * with no reference to the current time at all, which meant setting a
 * future cutoff (the natural way to schedule a re-login requirement ahead
 * of time, e.g. "at midnight UTC tomorrow") rejected every session
 * IMMEDIATELY, including a brand-new session minted seconds ago by a user
 * who had just re-logged-in to satisfy it - a login loop with no way out
 * before the cutoff itself arrived. Semantics now:
 *
 *  - cutoffSeconds === null                        -> false (disabled)
 *  - nowSeconds < cutoffSeconds                     -> false (not yet active - scheduled, not enforced)
 *  - nowSeconds >= cutoffSeconds && issuedAtSeconds < cutoffSeconds -> true (active, and this session predates it)
 *  - issuedAtSeconds >= cutoffSeconds               -> false (issued at/after the cutoff - always fine, even before nowSeconds reaches it, since a session can never be issued in the future)
 *
 * `nowSeconds` is an explicit parameter (defaulting to the server's own
 * `Date.now()`, NEVER any client-supplied value) specifically so this stays
 * directly testable with plain numbers - no fake timers, no JWT signing, no
 * module reload required. authenticateRequest never passes its own
 * override - it always uses the real server clock via the default.
 */
export function isSessionIssuedBeforeCutoff(
  issuedAtSeconds: number,
  cutoffSeconds: number | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (cutoffSeconds === null) return false;
  if (nowSeconds < cutoffSeconds) return false;
  return issuedAtSeconds < cutoffSeconds;
}

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

class OAuthService {
  constructor(private client: ReturnType<typeof axios.create>) {
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }

  private decodeState(state: string): string {
    const redirectUri = atob(state);
    return redirectUri;
  }

  async getTokenByCode(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    const payload: ExchangeTokenRequest = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state),
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, state);
  }

  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  /**
   * Throws (a plain Error, not AnonymousCredentialError) when JWT_SECRET is
   * unset - a missing server secret is a configuration failure, not "this
   * token is invalid", and must never be silently treated as one (it would
   * otherwise make every session verification fail the exact same way an
   * actually-invalid token does, hiding a config outage as mass logout).
   * Called from both signSession and verifySession, outside any try/catch
   * that would otherwise swallow it.
   */
  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    if (!secret) {
      throw new Error("[Auth] JWT_SECRET is not configured - refusing to sign or verify sessions");
    }
    return new TextEncoder().encode(secret);
  }

  /**
   * Throws (a plain Error, not AnonymousCredentialError) when the given
   * appId is empty/whitespace-only - a missing VITE_APP_ID is a
   * configuration failure, not "no session". Signing with an empty appId
   * would mint a token whose audience/appId claim is an empty string
   * (never a legitimate value); verifying with an empty *expected*
   * audience would make jose's audience check trivially satisfiable by any
   * token that also happens to carry an empty `aud`, quietly reopening the
   * appId-bypass this hardening closed. Called from both signSession and
   * verifySession, outside any try/catch that would otherwise fold it into
   * "invalid session -> anonymous".
   */
  private assertConfiguredAppId(appId: string): string {
    const trimmed = appId.trim();
    if (!trimmed) {
      throw new Error("[Auth] VITE_APP_ID is not configured - refusing to sign or verify sessions");
    }
    return trimmed;
  }

  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string | null; sid?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: normalizeProviderName(options.name),
        sid: options.sid,
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? SESSION_TTL_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();
    const appId = this.assertConfiguredAppId(payload.appId);

    return new SignJWT({
      openId: payload.openId,
      appId,
      name: payload.name ?? null,
      ...(payload.sid ? { sid: payload.sid, tv: 2 } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(expirationSeconds)
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(appId)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<VerifiedSession | null> {
    // The overwhelmingly common case (every anonymous visitor) - never
    // logs, so it can never become log-volume noise.
    if (!cookieValue) return null;

    // Deliberately OUTSIDE the try/catch below: a missing secret or a
    // missing VITE_APP_ID is a configuration error, not a credential error,
    // and must propagate instead of being folded into "verification failed
    // -> anonymous".
    const secretKey = this.getSessionSecret();
    const expectedAppId = this.assertConfiguredAppId(ENV.appId);

    try {
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
        issuer: SESSION_JWT_ISSUER,
        audience: expectedAppId,
      });
      const { openId, appId, name, iat, sid, exp, tv } = payload as Record<string, unknown>;

      // R4/IR-02 — strict ORIGINAL claim-shape validation BEFORE any
      // normalization. The v2 protocol is (sid: base64url 16-64, tv: 2)
      // TOGETHER; the legacy protocol is (no sid, no tv). A signed token
      // with a sid/tv claim of the wrong type/shape, sid without tv,
      // tv without sid, or tv !== 2 is structurally suspect and is rejected
      // here — it must NEVER be normalized (e.g. a non-string sid flattened
      // to null) into the legacy path.
      const hasSidClaim = "sid" in payload;
      const hasTvClaim = "tv" in payload;
      if (hasSidClaim || hasTvClaim) {
        const sidShapeOk = typeof sid === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(sid);
        const tvOk = tv === 2;
        if (!sidShapeOk || !tvOk) {
          return null;
        }
      }
      // R4/IR-02 — the exp claim is structural: every token this codebase
      // has ever minted carries one. A missing/non-numeric/non-positive exp
      // is rejected outright instead of degrading to a 0/default deadline.
      if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) {
        return null;
      }

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        appId !== expectedAppId ||
        typeof iat !== "number" ||
        !Number.isFinite(iat)
      ) {
        // No log here (deliberately): once this PR ships, EVERY session
        // token issued beforehand fails this exact check (old tokens carry
        // no iss/aud/matching-appId at all) - every browser with an old
        // cookie would otherwise warn-log on every request until it
        // signs in again. This is an expected, high-volume rejection, not
        // a security event worth logging. See authenticateRequest, which
        // reports this case to createContext as "invalid_session_token" so
        // the stale cookie gets cleared instead. A missing/non-numeric
        // `iat` is treated exactly the same way - jose's own jwtVerify
        // always includes a real one from .setIssuedAt() for every token
        // this codebase has ever signed, so a token missing one is
        // exactly as structurally suspect as a missing openId/appId.
        return null;
      }

      return {
        openId,
        appId,
        name: typeof name === "string" && name.length > 0 ? name : null,
        issuedAtSeconds: iat,
        // R4/IR-02: reaching here, a present sid claim is already shape-valid
        // (checked above pre-normalization); its absence means a legacy token.
        sid: typeof sid === "string" && sid.length > 0 ? sid : null,
        // R3/F7 + R4/IR-02: the verified exp claim — deadlines derive from
        // this, never from a default-TTL assumption.
        expSeconds: exp,
      };
    } catch {
      // Malformed JWT, bad signature, expired, wrong issuer/audience, or an
      // unsupported algorithm all land here (jose rejects all of them given
      // the algorithms/issuer/audience allowlist above) - every one of them
      // is an expected, high-volume rejection for the same reason as above;
      // deliberately not logged (never the raw token either way).
      return null;
    }
  }

  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: ENV.appId,
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  async authenticateRequest(req: Request): Promise<User> {
    // Regular authentication flow
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      // Covers: no cookie, malformed/expired JWT, wrong appId/issuer/
      // audience/algorithm - all deliberately expected, resolve to
      // anonymous. A missing JWT_SECRET/VITE_APP_ID is NOT among these:
      // verifySession lets those propagate as a plain Error instead of
      // returning null. The reason distinguishes "nothing was sent"
      // (nothing to clear) from "a cookie was sent but rejected" (the
      // browser is holding a token that can never verify again) so
      // createContext knows whether to clear it - see authErrors.ts.
      throw new AnonymousCredentialError(
        sessionCookie ? "Invalid session cookie" : "No session cookie",
        sessionCookie ? "invalid_session_token" : "no_cookie"
      );
    }

    // Local (email/password) admin login has been removed entirely (see
    // security/remove-local-admin-password-login) - it used to mint a
    // synthetic "admin-<id>" openId, e.g. "admin-7" (server/routers.ts's
    // now-deleted admin.login), never issued by OAuth. Any session bearing
    // EXACTLY that shape is a leftover from the removed mechanism (a
    // still-live old cookie, or a forged attempt to mimic one) and must be
    // rejected outright, never resolved via a database lookup - unlike a
    // real OAuth-issued openId, there is no scenario where trusting this
    // shape is still valid, so this check needs no database access at all
    // and runs BEFORE the availability guard below.
    //
    // Deliberately an exact `/^admin-\d+$/` match, never a
    // `startsWith("admin-")` prefix check - the old numeric-id shape
    // (`admin-7`, `admin-999`, ...) is the only thing the removed mechanism
    // ever minted. A prefix check would ALSO reject a legitimate,
    // differently-shaped real openId that merely happens to start with the
    // same literal characters (e.g. a hypothetical "admin-editor" or
    // "administrator-example" issued by some other identity source) -
    // those must fall through to the normal getUserByOpenId lookup below
    // like any other session, never be misclassified as a legacy admin
    // credential just because of a shared string prefix.
    //
    // Uses "invalid_session_token" (not a separate reason) because this is
    // now, structurally, exactly that: a credential shape that can never
    // become valid again - so createContext clears the cookie too (see
    // authErrors.ts), guaranteeing an old local admin session cookie stops
    // being resent as well as stops working.
    if (/^admin-\d+$/.test(session.openId)) {
      throw new AnonymousCredentialError(
        "Local admin sessions are no longer supported",
        "invalid_session_token"
      );
    }

    // Every path below this point needs the database - confirm it is
    // actually available BEFORE any user lookup, so an outage propagates as
    // a real infrastructure error instead of being silently misread as "no
    // such user" (db.getUserByOpenId returns undefined - indistinguishable
    // from "not found" - when the database itself is unavailable).
    // Deliberately after the session-verification check above: a request
    // with no cookie, or an invalid one, never touches the database at all.
    await db.assertDatabaseAvailable();

    // AUTH_FORCE_RELOGIN_AFTER applies to every real, OAuth-issued session -
    // including an admin's, since there is no more separate concept of "an
    // admin session" distinct from a regular one (an admin is just a
    // regular user whose `role` is "admin" - see
    // security/remove-local-admin-password-login). Only the synthetic,
    // now-permanently-rejected "admin-<id>" openId shape from the removed
    // local admin login is guaranteed to never reach this line at all (it
    // throws, unconditionally, above - before this point is ever reached).
    // When ENV.forceReloginAfterSeconds is null (unset/invalid), this always
    // resolves to false - see isSessionIssuedBeforeCutoff/
    // resolveForceReloginCutoffSeconds. A cutoff set in the FUTURE is a
    // SCHEDULED activation - it stays completely inert (every session keeps
    // working, including a brand-new one minted seconds ago) until the
    // server's own clock actually reaches it; only once "now" has reached
    // the cutoff does a session issued before it start getting rejected.
    // Deliberately does not pass a `now` override here - always the real
    // server clock (isSessionIssuedBeforeCutoff's own default), never
    // anything client-supplied. Never logs the JWT or the session cookie
    // value - the thrown message is a fixed, constant string.
    if (isSessionIssuedBeforeCutoff(session.issuedAtSeconds, ENV.forceReloginAfterSeconds)) {
      throw new AnonymousCredentialError(
        "Session predates the forced re-login cutoff",
        "forced_relogin"
      );
    }

    const sessionUserId = session.openId;
    const signedInAt = new Date();
    let user = await db.getUserByOpenId(sessionUserId);

    // If user not in DB, sync from OAuth server automatically - but ONLY
    // when Manus auth is actually active ("manus" or "transition" - see
    // isManusAuthActive). This used to run unconditionally, regardless of
    // AUTH_PROVIDER: a verified session with no matching DB row would
    // still trigger an outbound call to Manus's OAuth server even on a
    // deployment fully cut over to Google (AUTH_PROVIDER=google), where
    // Manus may not be reachable at all and no code path is supposed to
    // depend on it. That was the one un-gated edge case in the whole auth
    // system - every other Manus-specific route/handler already checks
    // isManusAuthActive()/isGoogleAuthActive() before doing anything
    // provider-specific; this was the exception. When Manus auth is
    // inactive, an orphaned session (valid signature, no backing user row)
    // now resolves directly to the same "no_user_record" outcome as if the
    // sync had run and still found nothing - see the `if (!user)` below -
    // without ever calling getUserInfoWithJwt or touching OAUTH_SERVER_URL.
    //
    // Deliberately NOT wrapped in a try/catch that falls back to
    // anonymous: a failure here is the outbound call to the OAuth server
    // or a database write, i.e. an infrastructure failure - not proof the
    // session is invalid - so it must propagate and surface as a real
    // error (see server/_core/context.ts), never be silently treated as
    // "not logged in".
    if (!user && isManusAuthActive()) {
      const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
      await db.upsertUser({
        openId: userInfo.openId,
        // undefined (never null) when the provider sent no usable name, so
        // upsertUser leaves any existing stored name untouched instead of
        // overwriting it - see normalizeProviderName and server/db.ts.
        name: normalizeProviderName(userInfo.name) ?? undefined,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: signedInAt,
      });
      user = await db.getUserByOpenId(userInfo.openId);
    }

    if (!user) {
      // Two cases land here, both resolved identically: (a) Manus auth is
      // active but the OAuth sync above still found nothing, or (b) Manus
      // auth is inactive, so the sync attempt was skipped entirely. Either
      // way this is a verified session with no way to resolve a backing
      // user record - an expected "no account" outcome, not cleared, for
      // the same reason as the admin case above.
      throw new AnonymousCredentialError("No user record for this session", "no_user_record");
    }

    // Routine session authentication must stay read-only with respect to the
    // users row. Updating lastSignedIn on every auth.me/API request turns a
    // harmless session check into a write-lock dependency and can strand the
    // login page behind unrelated transactions. Real login boundaries already
    // update lastSignedIn (Manus OAuth sync/callback and Google identity
    // resolution), so simply return the verified backing user here.

    // R2 Reader Session Controls — registry floor + adoption. The floor is
    // NEVER feature-flagged: a revoked/superseded registry row rejects the
    // request regardless of any flag. Slot/pending/lease enforcement lives
    // elsewhere (flag-gated). Note: this floor runs before the per-procedure
    // account-merge gate; both orders deny — revocation is the terminal fact.
    const sessionRow = await this.resolveRegistryRow(req, user, session, sessionCookie!);

    return user;
  }

  /**
   * R2: authenticate + resolve the registry row in one pass.
   * ctx.authSession comes from here; the returned row may be null when the
   * flag is OFF and the cookie has no registry row (adoption deferred).
   * R4/C: `sessionExpiresAt` is the VERIFIED JWT exp — the chooser
   * resolution uses it as the activated row's deadline.
   */
  async authenticateRequestWithSession(
    req: Request
  ): Promise<{
    user: User;
    sessionRow: import("../../drizzle/schema").AuthSession | null;
    sessionExpiresAt: Date | null;
  }> {
    const user = await this.authenticateRequest(req);
    const cookies = this.parseCookies(req.headers.cookie);
    const token = cookies.get(COOKIE_NAME) ?? "";
    const session = await this.verifySession(token);
    if (!session) {
      // Unreachable in practice (authenticateRequest throws for every
      // verify failure), kept for type honesty.
      return { user, sessionRow: null, sessionExpiresAt: null };
    }
    const row = await this.resolveRegistryRow(req, user, session, token);
    const sessionExpiresAt =
      Number.isFinite(session.expSeconds) && session.expSeconds > 0
        ? new Date(session.expSeconds * 1000)
        : null;
    return { user, sessionRow: row, sessionExpiresAt };
  }

  /**
   * The revocation floor + adoption + throttled visibility. See R1D B3:
   * signature/admin-shape/forced-relogin/DB-user already happened above.
   */
  private async resolveRegistryRow(
    req: Request,
    user: User,
    session: VerifiedSession,
    token: string
  ): Promise<import("../../drizzle/schema").AuthSession | null> {
    const registry = await import("../services/sessionRegistry");
    // R4/C — strict claim validation BEFORE any legacy/v2 branch: a
    // verified signature is not enough. The exp claim must exist, be a
    // finite positive number of seconds, and a v2 (sid-bearing) token must
    // carry a syntactically valid sid. Absence/nonfinite/malformed shape is
    // a structural credential failure (invalid_session_token), never a
    // silent fall-through to the legacy path.
    if (!Number.isFinite(session.expSeconds) || session.expSeconds <= 0) {
      throw new AnonymousCredentialError("Session expiry missing or malformed", "invalid_session_token");
    }
    if (session.sid && !/^[A-Za-z0-9_-]{16,64}$/.test(session.sid)) {
      throw new AnonymousCredentialError("Session sid malformed", "invalid_session_token");
    }
    const row = await registry.findSessionByCookie({ token, sid: session.sid });
    if (row && (row.status === "revoked" || row.status === "superseded")) {
      // Terminal rows never authenticate. Cookie cleared (same class as
      // forced_relogin) so the browser stops resending a dead token.
      throw new AnonymousCredentialError("Session revoked", "session_revoked");
    }
    if (!row && session.sid) {
      // v2 tokens are registry-authoritative: a missing row is a structural
      // failure (never silently re-adopted into the legacy path).
      throw new AnonymousCredentialError("Session registry row missing", "invalid_session_token");
    }
    if (row) {
      // R3/F6 — strict binding: the row MUST belong to the verified user,
      // and the token format must match the row version (v2 sid-bearing /
      // v1 sid-less). Any mismatch is a structural credential failure.
      if (row.userId !== user.id) {
        throw new AnonymousCredentialError("Session owner mismatch", "invalid_session_token");
      }
      if (session.sid && row.tokenVersion !== 2) {
        throw new AnonymousCredentialError("Token format mismatch", "invalid_session_token");
      }
      if (!session.sid && row.tokenVersion !== 1) {
        throw new AnonymousCredentialError("Token format mismatch", "invalid_session_token");
      }
      // R3/F7 — DB-time row expiry: a non-terminal row past its deadline
      // (e.g. a pending chooser window) is flipped to superseded(expired)
      // via a status-guarded conditional UPDATE and rejected.
      const flipped = await registry.expireRowIfPastDeadline(row.id);
      if (flipped) {
        throw new AnonymousCredentialError("Session expired", "invalid_session_token");
      }
    }
    if (!row) {
      // Legacy v1 cookie: adoption (only while the controls are enabled;
      // deferred otherwise — the cookie keeps legacy behavior until then).
      // R3/F7: the deadline is the VERIFIED JWT exp claim, never an
      // iat+default-TTL inference.
      if (registry.isReaderSessionControlsEnabled()) {
        const expiresAt = new Date(session.expSeconds * 1000);
        const adopted = await registry.adoptLegacySession({
          userId: user.id,
          token,
          expiresAt,
          clientLabel: registry.labelFromUserAgent(req.headers["user-agent"]),
        });
        return adopted;
      }
      return null;
    }
    if (registry.isReaderSessionControlsEnabled()) {
      if (row.status === "unslotted_legacy") {
        // C1 promotion trigger (a): throttled by status — cheap no-op when
        // the row is not unslotted.
        const promoted = await registry.maybePromoteUnslotted(row.id);
        if (promoted && promoted.status === "active") {
          await registry.touchLastSeen(promoted.id);
          return promoted;
        }
        return promoted;
      }
      if (row.status === "active") {
        // R4/A — reconcile-before-rights: the OFF→ON reconciliation runs on
        // the FIRST real authenticated request after the flip and on every
        // request after it — decoupled from the lastSeen throttle (a recent
        // touch no longer skips it). It never runs from the UI's
        // sessions.list. lastSeen keeps its own throttled write; the
        // reconciliation itself is idempotent (within-quota users cost one
        // indexed count).
        await registry.touchLastSeen(row.id);
        await registry.reconcileAfterFlagOn(row.userId);
        // R4/A: rights are decided from the POST-reconciliation status —
        // a request that reconciled its own row away never rides a stale
        // pre-reconcile active row.
        const fresh = await registry.getSessionRowById(row.id);
        if (fresh) return fresh;
      }
    }
    // R8B-4C — slot recovery: a pending_choice session claims a freed slot
    // on its own next request. This runs at context construction — BEFORE
    // the requireSessionSlotResolved gate sees ctx.authSession — so a
    // chooser blocked by a full quota unblocks the moment a slot frees
    // (another device's logout), without displacing any live session. The
    // registry function owns the per-flag semantics, the DB-time expiry,
    // and the locking quota recount.
    if (row.status === "pending_choice") {
      const activated = await registry.maybeActivatePending({
        sessionId: row.id,
        activateExpiresAt: new Date(session.expSeconds * 1000),
      });
      if (activated && activated.status === "active") {
        await registry.touchLastSeen(activated.id);
        return activated;
      }
      return activated ?? row;
    }
    return row;
  }

  /** Reads the raw session cookie value (no verification) — R2 logout/rotation. */
  readSessionToken(req: Request): string | null {
    return this.parseCookies(req.headers.cookie).get(COOKIE_NAME) ?? null;
  }
}

export const sdk = new SDKServer();
