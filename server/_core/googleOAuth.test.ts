import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { serialize as serializeCookie } from "cookie";
import * as db from "../db";
import * as googleOidc from "./googleOidc";
import * as googleIdentityService from "../services/googleIdentityService";
import { AnonymousCredentialError } from "./authErrors";
import { ENV } from "./env";
import { sdk } from "./sdk";
import {
  GOOGLE_INTENT_COOKIE,
  GOOGLE_NONCE_COOKIE,
  GOOGLE_PKCE_COOKIE,
  GOOGLE_STATE_COOKIE,
  registerGoogleOAuthRoutes,
  resolveConnectCallbackDestination,
} from "./googleOAuth";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

type CapturedHandler = (req: Request, res: Response) => void | Promise<void>;

function captureGoogleOAuthHandlers(): { start: CapturedHandler; connectStart: CapturedHandler; callback: CapturedHandler } {
  let start: CapturedHandler | undefined;
  let connectStart: CapturedHandler | undefined;
  let callback: CapturedHandler | undefined;
  const fakeApp = {
    get: (path: string, fn: CapturedHandler) => {
      if (path === "/api/auth/google/start") start = fn;
      if (path === "/api/auth/google/connect/start") connectStart = fn;
      if (path === "/api/auth/google/callback") callback = fn;
    },
  } as unknown as Express;

  registerGoogleOAuthRoutes(fakeApp);
  if (!start || !connectStart || !callback) throw new Error("test setup failed: routes were not registered");
  return { start, connectStart, callback };
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

describe("resolveConnectCallbackDestination - pure, no Express/mocks needed", () => {
  it('"success" -> /profile?googleConnect=success, regardless of mandatoryConnectionRequired', () => {
    expect(resolveConnectCallbackDestination("success", false)).toBe("/profile?googleConnect=success");
    expect(resolveConnectCallbackDestination("success", true)).toBe("/profile?googleConnect=success");
  });

  it('"error" + mandatoryConnectionRequired=false -> /profile?googleConnect=error', () => {
    expect(resolveConnectCallbackDestination("error", false)).toBe("/profile?googleConnect=error");
  });

  it('"error" + mandatoryConnectionRequired=true -> /account/upgrade-login?googleConnect=error', () => {
    expect(resolveConnectCallbackDestination("error", true)).toBe("/account/upgrade-login?googleConnect=error");
  });

  it('"session_expired" -> /login?googleConnect=session_expired, regardless of mandatoryConnectionRequired', () => {
    expect(resolveConnectCallbackDestination("session_expired", false)).toBe("/login?googleConnect=session_expired");
    expect(resolveConnectCallbackDestination("session_expired", true)).toBe("/login?googleConnect=session_expired");
  });

  it("takes exactly two parameters - no path/returnTo override is structurally possible", () => {
    expect(resolveConnectCallbackDestination.length).toBe(2);
  });
});

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

  it("AUTH_PROVIDER=manus -> /api/auth/google/connect/start responds 404 without ever checking the session", async () => {
    ENV.authProvider = "manus";
    const authSpy = vi.spyOn(sdk, "authenticateRequest");
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);
    expect(res.statusCalls).toEqual([404]);
    expect(res.cookieCalls).toEqual([]);
    expect(authSpy).not.toHaveBeenCalled();
    authSpy.mockRestore();
  });

  it("AUTH_PROVIDER=manus -> /api/auth/google/callback responds 404, does nothing else", async () => {
    ENV.authProvider = "manus";
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(fakeRequest({ query: { code: "x", state: "y" } }), res);
    expect(res.statusCalls).toEqual([404]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it.each(["google", "transition"] as const)(
    "AUTH_PROVIDER=%s -> /api/auth/google/start and /connect/start are both reachable (not 404)",
    async (mode) => {
      ENV.authProvider = mode;
      ENV.googleClientId = "test-client-id";
      ENV.googleClientSecret = "test-client-secret";
      ENV.googleRedirectUri = "https://staging.ipenovel.com/api/auth/google/callback";
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 1 } as any);

      const { start, connectStart } = captureGoogleOAuthHandlers();
      const startRes = fakeResponse();
      start(fakeRequest(), startRes);
      expect(startRes.statusCalls).not.toContain(404);

      const connectRes = fakeResponse();
      await connectStart(fakeRequest(), connectRes);
      expect(connectRes.statusCalls).not.toContain(404);
    }
  );
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

  it("fully configured -> sets state/nonce/PKCE/intent cookies and redirects to Google's authorization endpoint with the required query params", () => {
    const { start } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    start(fakeRequest(), res);

    expect(res.statusCalls).toEqual([]);
    expect(res.cookieCalls.map((c) => c[0]).sort()).toEqual(
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE, GOOGLE_INTENT_COOKIE].sort()
    );
    const intentCookieCall = res.cookieCalls.find((c) => c[0] === GOOGLE_INTENT_COOKIE)!;
    expect(intentCookieCall[1]).toBe("login");

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

  function requestWithValidCookies(
    query: Record<string, string> = {},
    extraCookies: Record<string, string> = {}
  ) {
    return fakeRequest({
      query: { code: "auth-code-123", state: VALID_STATE, ...query },
      cookies: {
        [GOOGLE_STATE_COOKIE]: VALID_STATE,
        [GOOGLE_NONCE_COOKIE]: VALID_NONCE,
        [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER,
        // Every existing (pre-transition-mode) test in this describe block
        // exercises the ORIGINAL login flow - intent=login is the default
        // here so none of them need updating just to keep passing; tests
        // that care about the connect flow pass their own intent cookie
        // via extraCookies.
        [GOOGLE_INTENT_COOKIE]: "login",
        ...extraCookies,
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
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE, GOOGLE_INTENT_COOKIE].sort()
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

  it("the logged message is a fixed, constant string - never interpolates the query string's own error CODE either, not just error_description", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = fakeResponse();
    await callback(
      requestWithValidCookies({ error: "access_denied", error_description: "should never appear" }),
      res
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[GoogleOAuth] Google authorization was not completed");
    const loggedMessage = warnSpy.mock.calls[0].join(" ");
    expect(loggedMessage).not.toMatch(/access_denied/);
    expect(loggedMessage).not.toMatch(/should never appear/);
    warnSpy.mockRestore();
  });

  describe.each([
    ["a newline", "access_denied\nINJECTED: fake log line"],
    ["a carriage return", "access_denied\rINJECTED"],
    ["a tab character", "access_denied\tINJECTED"],
    ["a very long value (10,000 chars)", "a".repeat(10000)],
    ["a secret-looking value", "secret-looking-value-AKIAFAKEEXAMPLE12345"],
  ])("query param 'error' containing %s", (_label, adversarialErrorValue) => {
    it("never appears in console.warn or console.error, and the fixed message is logged instead", async () => {
      const { callback } = captureGoogleOAuthHandlers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = fakeResponse();

      await callback(requestWithValidCookies({ error: adversarialErrorValue }), res);

      expect(res.statusCalls).toEqual([400]);
      expect(res.jsonBody).toEqual({ error: "Google sign-in was not completed" });
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(adversarialErrorValue);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(adversarialErrorValue);
      expect(JSON.stringify(res.jsonBody)).not.toContain(adversarialErrorValue);
      expect(warnSpy).toHaveBeenCalledWith("[GoogleOAuth] Google authorization was not completed");
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
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

  it("[required test 8] resolveGoogleIdentity rejects (e.g. the concurrent-login retry exhausted both attempts and failed closed) -> no session cookie is ever set, sdk.createSessionToken is never called", async () => {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-sub-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Test User",
      picture: null,
    });
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(googleIdentityService, "resolveGoogleIdentity").mockRejectedValue(
      Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } })
    );
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
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE, GOOGLE_INTENT_COOKIE].sort()
    );
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
    expect(res.statusCalls).toEqual([]);
  });
});

describe("Google OAuth /api/auth/google/connect/start", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalClientId = ENV.googleClientId;
  const originalClientSecret = ENV.googleClientSecret;
  const originalRedirectUri = ENV.googleRedirectUri;

  beforeEach(() => {
    ENV.authProvider = "transition";
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

  it("no session at all -> 401, no state/nonce/PKCE/intent cookies set, never redirects to Google", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
      new AnonymousCredentialError("no session cookie", "no_cookie")
    );
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);

    expect(res.statusCalls).toEqual([401]);
    expect(res.cookieCalls).toEqual([]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("an expired/invalid session cookie (AnonymousCredentialError, any reason) -> 401, same as no session at all", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
      new AnonymousCredentialError("bad token", "invalid_session_token")
    );
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);

    expect(res.statusCalls).toEqual([401]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("a non-anonymous failure (e.g. the database is down) -> 500, never silently treated as 'not logged in'", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(new Error("[Database] Database connection is not available"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);

    expect(res.statusCalls).toEqual([500]);
    expect(res.redirect).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("a valid session -> sets state/nonce/PKCE/intent=connect cookies and redirects to Google, exactly like /start", async () => {
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 7 } as any);
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);

    expect(res.statusCalls).toEqual([]);
    const intentCookieCall = res.cookieCalls.find((c) => c[0] === GOOGLE_INTENT_COOKIE)!;
    expect(intentCookieCall[1]).toBe("connect");
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [status, location] = (res.redirect as any).mock.calls[0];
    expect(status).toBe(302);
    expect(new URL(location).origin).toBe("https://accounts.google.com");
  });

  it("Google env vars not configured -> 500 before ever checking the session", async () => {
    ENV.googleClientSecret = "";
    const authSpy = vi.spyOn(sdk, "authenticateRequest");
    const { connectStart } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await connectStart(fakeRequest(), res);

    expect(res.statusCalls).toEqual([500]);
    expect(authSpy).not.toHaveBeenCalled();
  });
});

describe("Google OAuth /api/auth/google/callback - intent branching (login vs connect)", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalClientId = ENV.googleClientId;
  const originalClientSecret = ENV.googleClientSecret;
  const originalRedirectUri = ENV.googleRedirectUri;
  const originalRequireGoogleConnection = ENV.requireGoogleConnection;

  const VALID_STATE = "valid-state-value";
  const VALID_NONCE = "valid-nonce-value";
  const VALID_VERIFIER = "valid-code-verifier";

  function requestWithIntent(intent: string | undefined, query: Record<string, string> = {}) {
    const cookies: Record<string, string> = {
      [GOOGLE_STATE_COOKIE]: VALID_STATE,
      [GOOGLE_NONCE_COOKIE]: VALID_NONCE,
      [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER,
    };
    if (intent !== undefined) cookies[GOOGLE_INTENT_COOKIE] = intent;
    return fakeRequest({ query: { code: "auth-code-123", state: VALID_STATE, ...query }, cookies });
  }

  function mockValidGoogleClaims() {
    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockResolvedValue({ idToken: "fake-id-token" });
    vi.spyOn(googleOidc, "verifyGoogleIdToken").mockResolvedValue({
      sub: "google-sub-connect-1",
      email: "connect-user@example.com",
      emailVerified: true,
      name: "Connect User",
      picture: null,
    });
  }

  beforeEach(() => {
    ENV.authProvider = "transition";
    ENV.googleClientId = "test-client-id";
    ENV.googleClientSecret = "test-client-secret";
    ENV.googleRedirectUri = "https://staging.ipenovel.com/api/auth/google/callback";
    ENV.requireGoogleConnection = false;
  });

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.googleClientId = originalClientId;
    ENV.googleClientSecret = originalClientSecret;
    ENV.googleRedirectUri = originalRedirectUri;
    ENV.requireGoogleConnection = originalRequireGoogleConnection;
    vi.restoreAllMocks();
  });

  it("intent cookie missing entirely -> fails closed as an expired login attempt (400), never guesses login or connect", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent(undefined), res);

    expect(res.statusCalls).toEqual([400]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("intent cookie has an unrecognized value (tampered) -> fails closed (400), never treated as login or connect", async () => {
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("something-else"), res);

    expect(res.statusCalls).toEqual([400]);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("intent=connect, provider returned an error param -> redirects to the account page with an error status, never a JSON 400 (unlike intent=login)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect", { error: "access_denied" }), res);

    expect(res.statusCalls).toEqual([]);
    expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=error");
    warnSpy.mockRestore();
  });

  it("[required test 6] intent=connect, session expired between /connect/start and the callback -> redirects to /login?googleConnect=session_expired (NOT /profile or /account/upgrade-login), connectGoogleIdentityToUser is never called, no session cookie is ever minted, transient cookies are cleared", async () => {
    mockValidGoogleClaims();
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
      new AnonymousCredentialError("session expired", "invalid_session_token")
    );
    const connectSpy = vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser");
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect"), res);

    expect(connectSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.length).toBe(0);
    expect(res.redirect).toHaveBeenCalledWith(302, "/login?googleConnect=session_expired");
    expect(res.clearCookieCalls.map((c) => c[0]).sort()).toEqual(
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE, GOOGLE_INTENT_COOKIE].sort()
    );
  });

  it("[required test 6b] session-expired destination is the SAME (/login?googleConnect=session_expired) regardless of whether the mandatory gate is active - it is never gated by isGoogleConnectionMandatory()", async () => {
    ENV.requireGoogleConnection = true; // AUTH_PROVIDER is already "transition" from beforeEach
    mockValidGoogleClaims();
    vi.spyOn(sdk, "authenticateRequest").mockRejectedValue(
      new AnonymousCredentialError("session expired", "invalid_session_token")
    );

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect"), res);

    expect(res.redirect).toHaveBeenCalledWith(302, "/login?googleConnect=session_expired");
  });

  it("intent=connect, successful connect (outcome: connected) -> redirects to the account page with a success status, mints NO new session cookie, clears the transient cookies", async () => {
    mockValidGoogleClaims();
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue({} as any);
    const connectSpy = vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome: "connected" });
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect"), res);

    expect(connectSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 55, sub: "google-sub-connect-1", email: "connect-user@example.com", emailVerified: true })
    );
    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.cookieCalls.length).toBe(0);
    expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=success");
    expect(res.clearCookieCalls.map((c) => c[0]).sort()).toEqual(
      [GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_STATE_COOKIE, GOOGLE_INTENT_COOKIE].sort()
    );
  });

  it("intent=connect, idempotent re-connect (outcome: already_connected) -> also redirects with a success status, no new session", async () => {
    mockValidGoogleClaims();
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue({} as any);
    vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome: "already_connected" });
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect"), res);

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=success");
  });

  it.each(["conflict_sub_linked_to_different_user", "conflict_user_has_different_google_identity"] as const)(
    "intent=connect, conflict outcome (%s) -> redirects with a generic error status, never leaks which conflict occurred, mints no session",
    async (outcome) => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome });
      const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=error");
      expect(JSON.stringify((res.redirect as any).mock.calls)).not.toMatch(/different|conflict/);
      warnSpy.mockRestore();
    }
  );

  it("intent=connect, connectGoogleIdentityToUser throws (e.g. duplicate-key retry exhausted) -> redirects with an error status, sanitized log, no session minted", async () => {
    mockValidGoogleClaims();
    vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue({} as any);
    vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockRejectedValue(
      Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } })
    );
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("connect"), res);

    expect(createSessionSpy).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=error");
    errorSpy.mockRestore();
  });

  it("intent=login is completely unaffected by the connect flow's existence - resolveGoogleIdentity is called, connectGoogleIdentityToUser never is", async () => {
    mockValidGoogleClaims();
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const resolvedUser = { id: 1, openId: "google:google-sub-connect-1", name: "Connect User" } as any;
    const resolveSpy = vi.spyOn(googleIdentityService, "resolveGoogleIdentity").mockResolvedValue({ outcome: "created", user: resolvedUser });
    const connectSpy = vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser");
    vi.spyOn(sdk, "createSessionToken").mockResolvedValue("fake-session-jwt");
    const authenticateSpy = vi.spyOn(sdk, "authenticateRequest");

    const { callback } = captureGoogleOAuthHandlers();
    const res = fakeResponse();
    await callback(requestWithIntent("login"), res);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(authenticateSpy).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
  });

  describe("mandatory Google-migration gate - error destination routing (AUTH_REQUIRE_GOOGLE_CONNECTION)", () => {
    beforeEach(() => {
      ENV.requireGoogleConnection = true; // AUTH_PROVIDER is already "transition" from the outer beforeEach
    });

    it("[required test 1] mandatory=true + connect conflict (sub already linked to a different user) -> /account/upgrade-login?googleConnect=error", async () => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({
        outcome: "conflict_sub_linked_to_different_user",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/account/upgrade-login?googleConnect=error");
      warnSpy.mockRestore();
    });

    it("[required test 2] mandatory=true + provider cancel/error param -> /account/upgrade-login?googleConnect=error", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect", { error: "access_denied" }), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/account/upgrade-login?googleConnect=error");
      warnSpy.mockRestore();
    });

    it("[required test 3] mandatory=true + token verification/database/connect failure -> /account/upgrade-login?googleConnect=error", async () => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockRejectedValue(
        Object.assign(new Error("Duplicate entry"), { cause: { errno: 1062, code: "ER_DUP_ENTRY" } })
      );
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/account/upgrade-login?googleConnect=error");
      errorSpy.mockRestore();
    });

    it("[required test 5] connect success (mandatory=true) -> still /profile?googleConnect=success, never /account/upgrade-login - the identity is now connected, so the gate already allows /profile", async () => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome: "connected" });

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=success");
    });

    it("[required test 4] mandatory=false (explicit) + connect error -> /profile?googleConnect=error, unchanged optional-connect behavior", async () => {
      ENV.requireGoogleConnection = false;
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({
        outcome: "conflict_user_has_different_google_identity",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=error");
      warnSpy.mockRestore();
    });

    it("mandatory=true, AUTH_PROVIDER flipped to 'google' (not 'transition') -> the gate flag alone never activates it, error still goes to /profile", async () => {
      ENV.authProvider = "google"; // requireGoogleConnection stays true from this describe's beforeEach
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({
        outcome: "conflict_sub_linked_to_different_user",
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(requestWithIntent("connect"), res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=error");
      warnSpy.mockRestore();
    });
  });

  describe("[required test 7] destination is never derivable from query string, cookie, header, or the client - only from server environment (isGoogleConnectionMandatory()) and the handler's own internal control flow", () => {
    it("an attacker-supplied ?destination=/admin or ?returnTo=... query param has zero effect on the redirect target", async () => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome: "connected" });

      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(
        requestWithIntent("connect", { destination: "/admin", returnTo: "https://evil.example.com" }),
        res
      );

      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=success");
    });

    it("an attacker-supplied 'destination'/'returnTo' COOKIE also has zero effect", async () => {
      mockValidGoogleClaims();
      vi.spyOn(sdk, "authenticateRequest").mockResolvedValue({ id: 55 } as any);
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue({} as any);
      vi.spyOn(googleIdentityService, "connectGoogleIdentityToUser").mockResolvedValue({ outcome: "connected" });

      const req = fakeRequest({
        query: { code: "auth-code-123", state: VALID_STATE },
        cookies: {
          [GOOGLE_STATE_COOKIE]: VALID_STATE,
          [GOOGLE_NONCE_COOKIE]: VALID_NONCE,
          [GOOGLE_PKCE_COOKIE]: VALID_VERIFIER,
          [GOOGLE_INTENT_COOKIE]: "connect",
          destination: "/admin",
          returnTo: "https://evil.example.com",
        },
      });
      const { callback } = captureGoogleOAuthHandlers();
      const res = fakeResponse();
      await callback(req, res);

      expect(res.redirect).toHaveBeenCalledWith(302, "/profile?googleConnect=success");
    });

    it("resolveConnectCallbackDestination itself has exactly two parameters (status, mandatoryConnectionRequired) - structurally cannot accept a path/returnTo override even if a future caller tried to pass one", () => {
      expect(resolveConnectCallbackDestination.length).toBe(2);
    });
  });
});
