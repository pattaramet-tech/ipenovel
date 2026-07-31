import { AXIOS_TIMEOUT_MS, COOKIE_NAME, SESSION_JWT_ISSUER, SESSION_TTL_MS } from "@shared/const";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { AnonymousCredentialError } from "./authErrors";
import { ENV } from "./env";
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
};

export type VerifiedSession = {
  openId: string;
  appId: string;
  name: string | null;
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
    options: { expiresInMs?: number; name?: string | null } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: normalizeProviderName(options.name),
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
      const { openId, appId, name, iat } = payload as Record<string, unknown>;

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

    // Every path below this point needs the database - confirm it is
    // actually available BEFORE any user/admin lookup, so an outage
    // propagates as a real infrastructure error instead of being silently
    // misread as "no such admin" or "no such user" (db.getUserById /
    // getUserByOpenId both return undefined - indistinguishable from "not
    // found" - when the database itself is unavailable). Deliberately
    // after the session-verification check above: a request with no
    // cookie, or an invalid one, never touches the database at all.
    await db.assertDatabaseAvailable();

    // Local (email/password) admin sessions use a synthetic "admin-<id>"
    // openId minted only by admin.login (server/routers.ts) - never by
    // OAuth. Role is still re-checked against the database on every
    // request, never trusted from the token.
    if (session.openId.startsWith("admin-")) {
      const adminId = parseInt(session.openId.substring(6), 10);
      const user = await db.getUserById(adminId);
      if (user && user.role === "admin") {
        return user;
      }
      // Signature/claims verified fine, but this admin account no longer
      // qualifies (deleted, demoted, or a bogus id) - an expected
      // "credential no longer grants access" outcome, not an error. Not
      // cleared: this is a validly-signed token, not a structurally
      // invalid one - see authErrors.ts.
      throw new AnonymousCredentialError("Admin session no longer valid", "admin_session_invalid");
    }

    // AUTH_FORCE_RELOGIN_AFTER - only ever applies to a regular (non-admin)
    // user session, which is exactly why this check sits AFTER the
    // admin-openId branch above (which already returned or threw): a local
    // admin session can never reach this line. When
    // ENV.forceReloginAfterSeconds is null (unset/invalid), this always
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

    // If user not in DB, sync from OAuth server automatically. Deliberately
    // NOT wrapped in a try/catch that falls back to anonymous: a failure
    // here is the outbound call to the OAuth server or a database write,
    // i.e. an infrastructure failure - not proof the session is invalid -
    // so it must propagate and surface as a real error (see
    // server/_core/context.ts), never be silently treated as "not logged
    // in".
    if (!user) {
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
      // Session verified fine and the OAuth sync succeeded, but there is
      // still no matching user record - an expected "no account" outcome.
      // Not cleared, for the same reason as the admin case above.
      throw new AnonymousCredentialError("No user record for this session", "no_user_record");
    }

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    return user;
  }
}

export const sdk = new SDKServer();
