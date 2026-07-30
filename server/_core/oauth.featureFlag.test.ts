import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { registerOAuthRoutes } from "./oauth";
import { ENV } from "./env";
import { sdk } from "./sdk";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

// Blocker 3: only one login provider is ever "active" server-side at a
// time. These tests pin that GET /api/oauth/callback (the Manus flow)
// respects AUTH_PROVIDER exactly the same way the new Google routes do -
// see server/_core/googleOAuth.test.ts's mirror-image feature-flag-gating
// tests for the Google side of the same contract.

function captureOAuthCallbackHandler(): (req: Request, res: Response) => Promise<void> {
  let handler: ((req: Request, res: Response) => Promise<void>) | undefined;
  const fakeApp = {
    get: (path: string, fn: (req: Request, res: Response) => Promise<void>) => {
      if (path === "/api/oauth/callback") handler = fn;
    },
  } as unknown as Express;

  registerOAuthRoutes(fakeApp);
  if (!handler) throw new Error("test setup failed: callback handler was not registered");
  return handler;
}

function fakeRequest(): Request {
  return {
    query: { code: "auth-code", state: btoa("https://example.invalid/api/oauth/callback") },
    protocol: "https",
    hostname: "example.invalid",
    headers: {},
  } as unknown as Request;
}

function fakeResponse(): Response & { statusCalls: number[]; jsonBody: unknown } {
  const res: any = {
    statusCalls: [] as number[],
    jsonBody: undefined,
    status(code: number) {
      res.statusCalls.push(code);
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    end: vi.fn(),
    cookie: vi.fn(),
    redirect: vi.fn(),
  };
  return res;
}

describe("GET /api/oauth/callback (Manus) - AUTH_PROVIDER gating", () => {
  const originalAuthProvider = ENV.authProvider;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    vi.restoreAllMocks();
  });

  function mockHappyPathManusFlow() {
    vi.spyOn(sdk, "exchangeCodeForToken").mockResolvedValue({ accessToken: "token-abc" } as any);
    vi.spyOn(sdk, "getUserInfo").mockResolvedValue({ openId: "user-123", name: "Somchai" } as any);
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
    vi.spyOn(sdk, "createSessionToken").mockResolvedValue("fake-manus-session-token");
  }

  it('AUTH_PROVIDER="manus" -> the Manus callback works exactly as before (token exchange, session cookie, redirect)', async () => {
    ENV.authProvider = "manus";
    mockHappyPathManusFlow();

    const handler = captureOAuthCallbackHandler();
    const res = fakeResponse();
    await handler(fakeRequest(), res);

    expect(res.statusCalls).toEqual([]);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
  });

  it("AUTH_PROVIDER unset (default) -> the Manus callback works exactly as before", async () => {
    // env.ts resolves an unset AUTH_PROVIDER to the literal "manus" (see
    // server/_core/env.ts - anything other than the exact literal
    // "google" resolves to "manus"), never to an empty string - this
    // directly exercises that already-resolved default value, the same
    // way any other test in this file exercises ENV.authProvider.
    ENV.authProvider = "manus";
    mockHappyPathManusFlow();

    const handler = captureOAuthCallbackHandler();
    const res = fakeResponse();
    await handler(fakeRequest(), res);

    expect(res.statusCalls).toEqual([]);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
  });

  it('AUTH_PROVIDER="google" -> the Manus callback responds 404 and does nothing else', async () => {
    ENV.authProvider = "google";
    const exchangeSpy = vi.spyOn(sdk, "exchangeCodeForToken");
    const cookieCallCountBefore = 0;

    const handler = captureOAuthCallbackHandler();
    const res = fakeResponse();
    await handler(fakeRequest(), res);

    expect(res.statusCalls).toEqual([404]);
    expect(res.jsonBody).toBeUndefined();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(exchangeSpy).not.toHaveBeenCalled();
    expect((res.cookie as any).mock.calls.length).toBe(cookieCallCountBefore);
  });

  it('AUTH_PROVIDER="google" -> sdk.exchangeCodeForToken (the Manus token exchange) is never called', async () => {
    ENV.authProvider = "google";
    const exchangeSpy = vi.spyOn(sdk, "exchangeCodeForToken");
    const getUserInfoSpy = vi.spyOn(sdk, "getUserInfo");

    const handler = captureOAuthCallbackHandler();
    const res = fakeResponse();
    await handler(fakeRequest(), res);

    expect(exchangeSpy).not.toHaveBeenCalled();
    expect(getUserInfoSpy).not.toHaveBeenCalled();
  });

  it('AUTH_PROVIDER="google" -> no session cookie is ever set by the Manus callback, and the database is never touched', async () => {
    ENV.authProvider = "google";
    const assertDbSpy = vi.spyOn(db, "assertDatabaseAvailable");
    const upsertSpy = vi.spyOn(db, "upsertUser");
    const createSessionSpy = vi.spyOn(sdk, "createSessionToken");

    const handler = captureOAuthCallbackHandler();
    const res = fakeResponse();
    await handler(fakeRequest(), res);

    expect(res.cookie).not.toHaveBeenCalled();
    expect(assertDbSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it("rollback: AUTH_PROVIDER flipped from \"google\" back to \"manus\" -> the Manus callback works again immediately (the flag is read fresh per request, never cached/latched)", async () => {
    ENV.authProvider = "google";
    const blockedHandler = captureOAuthCallbackHandler();
    const blockedRes = fakeResponse();
    await blockedHandler(fakeRequest(), blockedRes);
    expect(blockedRes.statusCalls).toEqual([404]);

    ENV.authProvider = "manus";
    mockHappyPathManusFlow();
    const restoredHandler = captureOAuthCallbackHandler();
    const restoredRes = fakeResponse();
    await restoredHandler(fakeRequest(), restoredRes);

    expect(restoredRes.statusCalls).toEqual([]);
    expect(restoredRes.cookie).toHaveBeenCalledTimes(1);
    expect(restoredRes.redirect).toHaveBeenCalledWith(302, "/");
  });
});
