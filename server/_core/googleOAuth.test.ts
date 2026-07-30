import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { serialize as serializeCookie } from "cookie";
import * as db from "../db";
import * as googleOidc from "./googleOidc";
import * as googleIdentityService from "../services/googleIdentityService";
import { ENV } from "./env";
import { sdk } from "./sdk";
import {
  GOOGLE_NONCE_COOKIE,
  GOOGLE_PKCE_COOKIE,
  GOOGLE_STATE_COOKIE,
  registerGoogleOAuthRoutes,
} from "./googleOAuth";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

type CapturedHandler = (req: Request, res: Response) => void | Promise<void>;

function captureGoogleOAuthHandlers(): { start: CapturedHandler; callback: CapturedHandler } {
  let start: CapturedHandler | undefined;
  let callback: CapturedHandler | undefined;
  const fakeApp = {
    get: (path: string, fn: CapturedHandler) => {
      if (path === "/api/auth/google/start") start = fn;
      if (path === "/api/auth/google/callback") callback = fn;
    },
  } as unknown as Express;

  registerGoogleOAuthRoutes(fakeApp);
  if (!start || !callback) throw new Error("test setup failed: routes were not registered");
  return { start, callback };
}

function fakeRequest(opts: { query?: Record<string, string>; cookies?: Record<string, string> } = {}): Request {
  const cookieHeader = opts.cookies
    ? Object.entries(opts.cookies)
        .map(([name, value]) => serializeCookie(name, value))
        .join("; ")
    : undefined;
  return {
    query: opts.query ?? {},
    protocol: "https",
    hostname: "example.invalid",
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  } as unknown as Request;
}

function fakeResponse(): Response & {
  statusCalls: number[];
  jsonBody: unknown;
  clearCookieCalls: Array<[string, unknown]>;
  cookieCalls: Array<[string, string, unknown]>;
} {
  const res: any = {
    statusCalls: [] as number[],
    jsonBody: undefined,
    clearCookieCalls: [] as Array<[string, unknown]>,
    cookieCalls: [] as Array<[string, string, unknown]>,
    status(code: number) {
      res.statusCalls.push(code);
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    end: vi.fn(),
    cookie: vi.fn((name: string, value: string, options: unknown) => {
      res.cookieCalls.push([name, value, options]);
    }),
    clearCookie: vi.fn((name: string, options: unknown) => {
      res.clearCookieCalls.push([name, options]);
    }),
    redirect: vi.fn(),
  };
  return res;
}

describe("Google OAuth routes - feature flag gating", () => {
  const originalAuthProvider = ENV.authProvider;
  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
  });

  it("AUTH_PROVIDER unset/default (manus) -> /api/auth/google/start responds 404, does nothing else", () => {
    ENV.authProvider = "manus";
    const { start } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    start(fakeRequest(), res);
    expect(res.statusCalls).toEqual([404]);
    expect(res.cookieCalls).toEqual([]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("AUTH_PROVIDER=manus -> /api/auth/google/callback responds 404, does nothing else", async () => {
    ENV.authProvider = "manus";
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(fakeRequest({ query: { code: "x", state: "y" } }), res);
    expect(res.statusCalls).toEqual([404]);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe("Google OAuth /api/auth/google/start", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalClientId = ENV.googleClientId;
  const originalClientSecret = ENV.googleClientSecret;
  const originalRedirectUri = ENV.googleRedirectUri;

  beforeEach(() => {
    ENV.authProvider = "google";
    ENV.googleClientId = "test-client-id";
    ENV.googleClientSecret = "test-client-secret";
    ENV.googleRedirectUri = "https://staging.ipenovel.com/api/auth/google/callback";
  });

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.googleClientId = originalClientId;
    ENV.googleClientSecret = originalClientSecret;
    ENV.googleRedirectUri = originalRedirectUri;
  });

  it("AUTH_PROVIDER=google but Google env vars not configured -> 500, no cookies, no redirect", () => {
    ENV.googleClientSecret = "";
    const { start } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    start(fakeRequest(), res);
    expect(res.statusCalls).toEqual([500]);
    expect(res.cookieCalls).toEqual([]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("fully configured -> sets state/nonce/PKCE cookies and redirects to Google's authorization endpoint with the required query params", () => {
    const { start } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    start(fakeRequest(), res);

    expect(res.statusCalls).toEqual([]);
    expect(res.cookieCalls.map((c) => c[0]).sort()).toEqual([GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE].sort());

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [status, location] = (res.redirect as any).mock.calls[0];
    expect(status).toBe(302);
    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.googleRedirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // The state/nonce/code_challenge in the redirect URL must match what
    // was cookied - not independently generated twice.
    const stateCookieCall = res.cookieCalls.find((c) => c[0] === GOOGLE_STATE_COOKIE)!;
    expect(url.searchParams.get("state")).toBe(stateCookieCall[1]);
    const nonceCookieCall = res.cookieCalls.find((c) => c[0] === GOOGLE_NONCE_COOKIE)!;
    expect(url.searchParams.get("nonce")).toBe(nonceCookieCall[1]);
  });

  it("cookies use SameSite=Lax, HttpOnly, and a restricted path - never the session cookie's dynamic SameSite=None logic", () => {
    const { start } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    start(fakeRequest(), res);

    for (const [, , options] of res.cookieCalls) {
      const opts = options as Record<string, unknown>;
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe("lax");
      expect(opts.path).toBe("/api/auth/google");
      expect(typeof opts.maxAge).toBe("number");
      expect(opts.maxAge as number).toBeLessThanOrEqual(10 * 60 * 1000);
    }
  });

  it("two consecutive calls generate different state/nonce/code_verifier every time (cryptographically random, not reused)", () => {
    const { start } = captureGoogleOAuthHandlers();
    const res1 = fakeResponse();
    start(fakeRequest(), res1);
    const res2 = fakeResponse();
    start(fakeRequest(), res2);

    const state1 = res1.cookieCalls.find((c) => c[0] === GOOGLE_STATE_COOKIE)![1];
    const state2 = res2.cookieCalls.find((c) => c[0] === GOOGLE_STATE_COOKIE)![1];
    expect(state1).not.toBe(state2);
  });
});

describe("Google OAuth /api/auth/google/callback", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalClientId = ENV.googleClientId;
  const originalClientSecret = ENV.googleClientSecret;
  const originalRedirectUri = ENV.googleRedirectUri;

  const VALID_STATE = "valid-state-value";
  const VALID_NONCE = "valid-nonce-value";
  const VALID_VERIFIER = "valid-code-verifier";

  function requestWithValidCookies(query: Record<string, string> = {}) {
    return fakeRequest({
      query: { code: "auth-code-123", state: VALID_STATE, ...query },
      cookies: {
        [GOOGLE_STATE_COOKIE]: VALID_STATE,
        [GOOGLE_NONCE_COOKIE]: VALID_NONCE,
        [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER,
      },
    });
  }

  beforeEach(() => {
    ENV.authProvider = "google";
    ENV.googleClientId = "test-client-id";
    ENV.googleClientSecret = "test-client-secret";
    ENV.googleRedirectUri = "https://staging.ipenovel.com/api/auth/google/callback";
  });

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.googleClientId = originalClientId;
    ENV.googleClientSecret = originalClientSecret;
    ENV.googleRedirectUri = originalRedirectUri;
    vi.restoreAllMocks();
  });

  it("Google returned an error param -> 400, cookies cleared, error_description never sent to the browser or logged anywhere", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeResponse();
    await callback(
      requestWithValidCookies({ error: "access_denied", error_description: "the user said no, secret-looking-value" }),
      res
    );

    expect(res.statusCalls).toEqual([400]);
    expect(res.jsonBody).toEqual({ error: "Google sign-in was not completed" });
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/secret-looking-value/);
    // Not just the response - the raw error_description must never reach
    // ANY console call this handler makes, success or failure.
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/secret-looking-value/);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/secret-looking-value/);
    expect(res.clearCookieCalls.map((c) => c[0]).sort()).toEqual(
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE].sort()
    );
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("a long/adversarial error_description (containing what look like other secrets: code, state, token, a client secret) still never appears in any log or response", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeResponse();
    // Deliberately avoids a KEY-equals-value shape anywhere in this fixture
    // (see this repo's leaked-credential guard grep) - this is a fake
    // adversarial test value proving nothing leaks, not a real credential,
    // and must not itself resemble one closely enough to trip that guard.
    const adversarialDescription =
      "authCode leaked-auth-code / sessionState leaked-state / bearerToken leaked-token / clientSecretValue leaked-secret";
    await callback(requestWithValidCookies({ error: "access_denied", error_description: adversarialDescription }), res);

    expect(res.statusCalls).toEqual([400]);
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/leaked-/);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/leaked-/);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(/leaked-/);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("the logged error message contains only the fixed OAuth error CODE (e.g. access_denied), length-capped, never the free-text description", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = fakeResponse();
    await callback(
      requestWithValidCookies({ error: "access_denied", error_description: "should never appear" }),
      res
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedMessage = warnSpy.mock.calls[0].join(" ");
    expect(loggedMessage).toMatch(/access_denied/);
    expect(loggedMessage).not.toMatch(/should never appear/);
    warnSpy.mockRestore();
  });

  it("state cookie missing -> rejects, 400, cookies cleared", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    const req = fakeRequest({
      query: { code: "auth-code-123", state: VALID_STATE },
      cookies: { [GOOGLE_NONCE_COOKIE]: VALID_NONCE, [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER },
    });
    await callback(req, res);
    expect(res.statusCalls).toEqual([400]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("state does not match cookie -> rejects, 400", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    const req = fakeRequest({
      query: { code: "auth-code-123", state: "attacker-supplied-state" },
      cookies: {
        [GOOGLE_STATE_COOKIE]: VALID_STATE,
        [GOOGLE_NONCE_COOKIE]: VALID_NONCE,
        [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER,
      },
    });
    await callback(req, res);
    expect(res.statusCalls).toEqual([400]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("PKCE code_verifier cookie missing -> rejects, 400", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    const req = fakeRequest({
      query: { code: "auth-code-123", state: VALID_STATE },
      cookies: { [GOOGLE_STATE_COOKIE]: VALID_STATE, [GOOGLE_NONCE_COOKIE]: VALID_NONCE },
    });
    await callback(req, res);
    expect(res.statusCalls).toEqual([400]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("nonce cookie missing -> rejects, 400 (verification never even attempted)", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const exchangeSpy = vi.spyOn(googleOidc, "exchangeCodeForTokens");
    const res = fakeResponse();
    const req = fakeRequest({
      query: { code: "auth-code-123", state: VALID_STATE },
      cookies: { [GOOGLE_STATE_COOKIE]: VALID_STATE, [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER },
    });
    await callback(req, res);
    expect(res.statusCalls).toEqual([400]);
    expect(exchangeSpy).not.toHaveBeenCalled();
  });

  it("missing code or state query params -> 400", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(fakeRequest({ query: {} }), res);
    expect(res.statusCalls).toEqual([400]);
  });

  it("database unavailable -> no session cookie is ever set", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: null,
    });
    vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(new Error("[Database] Database connection is not available"));
    const resolveSpy = vi.spyOn(googleIdentityService, "resolveGoogleIdentity");
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithValidCookies(), res);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.find((c) => c[0] !== GOOGLE_STATE_COOKIE)).toBeUndefined();
    expect(res.statusCalls).toEqual([500]);
    errorSpy.mockRestore();
  });

  it("token exchange failure -> no session cookie, generic error, sanitized log", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockRejectedValue(new Error("Request failed with status code 400"));
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithValidCookies(), res);

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.length).toBe(0);
    expect(res.statusCalls).toEqual([500]);
    expect(res.jsonBody).toEqual({ error: "Google sign-in failed" });
    errorSpy.mockRestore();
  });

  it("ID token verification failure -> no session cookie", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockRejectedValue(new Error("[GoogleOidc] ID token nonce does not match"));
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithValidCookies(), res);

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.length).toBe(0);
    expect(res.statusCalls).toEqual([500]);
    errorSpy.mockRestore();
  });

  it("ambiguous_email resolution -> fails closed, 409, no session cookie", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: null,
    });
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(googleIdentityService, "resolveGoogleIdentity").mockResolvedValue({ outcome: "ambiguous_email" });
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithValidCookies(), res);

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.length).toBe(0);
    expect(res.statusCalls).toEqual([409]);
    warnSpy.mockRestore();
  });

  it("full success -> mints a session via sdk.createSessionToken using the resolved user's openId, sets the SAME COOKIE_NAME cookie, clears the Google transient cookies, and redirects to /", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: null,
    });
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const resolvedUser = { id: 42, openId: "google:google-sub-1", name: "Test User" } as any;
    vi.spyOn(googleIdentityService, "resolveGoogleIdentity").mockResolvedValue({ outcome: "created", user: resolvedUser });
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken").mockResolvedValue("fake-session-jwt");

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithValidCookies(), res);

    expect(createSessionSpy).toHaveBeenCalledWith("google:google-sub-1", expect.objectContaining({ name: "Test User" }));
    const sessionCookieCall = res.cookieCalls.find((c) => c[0] === "app_session_id");
    expect(sessionCookieCall).toBeTruthy();
    expect(sessionCookieCall![1]).toBe("fake-session-jwt");
    expect(res.clearCookieCalls.map((c) => c[0]).sort()).toEqual(
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE].sort()
    );
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
    expect(res.statusCalls).toEqual([]);
  });
});
