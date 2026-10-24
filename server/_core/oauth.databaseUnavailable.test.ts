import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { registerOAuthRoutes } from "./oauth";
import { sdk } from "./sdk";

vi.mock("../services/sessionRegistry", () => {
  const okRow = {
    id: 9001, userId: 1, sid: "sid-mock", tokenHash: "th", tokenVersion: 2,
    status: "active", revokedReason: null, loginAt: new Date(), lastSeenAt: null,
    expiresAt: new Date(Date.now() + 86400000), createdVia: "google",
    clientLabel: null, adoptOf: null,
  };
  return {
    generateSid: vi.fn(() => "sid-mock"),
    sha256Token: vi.fn(() => "th-mock"),
    findSessionByCookie: vi.fn(async () => null),
    findRotatableRow: vi.fn(async () => null),
    allocateSessionRow: vi.fn(async () => okRow),
    isReaderSessionControlsEnabled: vi.fn(() => false),
    reconcileAfterFlagOn: vi.fn(async () => undefined),
    maybePromoteUnslotted: vi.fn(async () => null),
    adoptLegacySession: vi.fn(async () => okRow),
    revokeByToken: vi.fn(async () => undefined),
    revokeOwnSession: vi.fn(async () => true),
    listUserSessions: vi.fn(async () => []),
    resolveThirdLogin: vi.fn(async () => ({ ok: true, session: okRow })),
    sessionHoldsLease: vi.fn(async () => false),
    labelFromUserAgent: vi.fn(() => "R2 Test Browser"),
  };
});

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

/**
 * Captures the handler registered for GET /api/oauth/callback without
 * spinning up a real Express server or HTTP client - registerOAuthRoutes
 * only ever calls `app.get(path, handler)` once, so a fake `app` that
 * records that call is enough to invoke the real handler function
 * directly with fake req/res objects.
 */
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
    cookie: vi.fn(),
    redirect: vi.fn(),
  };
  return res;
}

describe("OAuth callback - database unavailable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not upsert, mint a session, set a cookie, or redirect as success - responds with a safe generic error instead", async () => {
    vi.spyOn(sdk, "exchangeCodeForToken").mockResolvedValue({ accessToken: "token-abc" } as any);
    vi.spyOn(sdk, "getUserInfo").mockResolvedValue({ openId: "user-123", name: "Somchai" } as any);
    const dbOutage = new Error("[Database] Database connection is not available");
    vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(dbOutage);
    const upsertSpy = vi.spyOn(db, "upsertUser");
    const createSessionTokenSpy = vi.spyOn(sdk, "createSessionToken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const handler = captureOAuthCallbackHandler();
    const req = fakeRequest();
    const res = fakeResponse();

    await handler(req, res);

    expect(upsertSpy).not.toHaveBeenCalled();
    expect(createSessionTokenSpy).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.statusCalls).toEqual([500]);
    expect(res.jsonBody).toEqual({ error: "OAuth callback failed" });

    // Sanitized: no raw error object, and no leaked database detail.
    const loggedArgs = errorSpy.mock.calls[0];
    expect(JSON.stringify(loggedArgs)).not.toContain("DATABASE_URL");
  });

  it("proceeds normally (upsert, session, cookie, redirect) when the database IS available - the guard changes nothing on the happy path", async () => {
    vi.spyOn(sdk, "exchangeCodeForToken").mockResolvedValue({ accessToken: "token-abc" } as any);
    vi.spyOn(sdk, "getUserInfo").mockResolvedValue({ openId: "user-123", name: "Somchai" } as any);
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue({ id: 1, openId: "user-123", role: "user" } as any);
    vi.spyOn(sdk, "createSessionToken").mockResolvedValue("fake-session-token");

    const handler = captureOAuthCallbackHandler();
    const req = fakeRequest();
    const res = fakeResponse();

    await handler(req, res);

    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.redirect).toHaveBeenCalledWith(302, "/");
    expect(res.statusCalls).toEqual([]);
  });
});
