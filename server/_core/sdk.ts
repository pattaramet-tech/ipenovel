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
};

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

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name ?? null,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(expirationSeconds)
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(ENV.appId)
      .sign(secretKey);
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<VerifiedSession | null> {
    // The overwhelmingly common case (every anonymous visitor) - never
    // warn-logs, so it can never become log-volume noise.
    if (!cookieValue) return null;

    // Deliberately OUTSIDE the try/catch below: a missing secret is a
    // configuration error, not a credential error, and must propagate
    // instead of being folded into "verification failed -> anonymous".
    const secretKey = this.getSessionSecret();

    try {
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
        issuer: SESSION_JWT_ISSUER,
        audience: ENV.appId,
      });
      const { openId, appId, name } = payload as Record<string, unknown>;

      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || appId !== ENV.appId) {
        // Sanitized: logs only that shape/appId validation failed, never
        // the token or its claim values.
        console.warn("[Auth] Session payload failed shape/appId validation");
        return null;
      }

      return {
        openId,
        appId,
        name: typeof name === "string" && name.length > 0 ? name : null,
      };
    } catch (error) {
      // Malformed JWT, bad signature, expired, wrong issuer/audience, or an
      // unsupported algorithm all land here (jose rejects all of them given
      // the algorithms/issuer/audience allowlist above) - every one of them
      // is an expected "not a valid session", not an infrastructure error.
      // Sanitized: jose's error message/name only, never the raw token.
      console.warn("[Auth] Session verification failed:", error instanceof Error ? error.name : "unknown error");
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
      // anonymous. A missing JWT_SECRET is NOT among these: verifySession
      // lets that propagate as a plain Error instead of returning null.
      throw new AnonymousCredentialError("No valid session credential");
    }

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
      // "credential no longer grants access" outcome, not an error.
      throw new AnonymousCredentialError("Admin session no longer valid");
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
      throw new AnonymousCredentialError("No user record for this session");
    }

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    return user;
  }
}

export const sdk = new SDKServer();
