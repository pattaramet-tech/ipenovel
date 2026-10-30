import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import { serialize as serializeCookie } from "cookie";

/**
 * R3-G / PAT-12 — RUNTIME callback sanitization regression (R4R7).
 *
 * The R4-RED source-string check (readerSessionR4Repair.integration.test.ts)
 * only proves the raw `console.log("[R3CB]", String(error)...)` line is
 * gone. This file is the runtime proof the reviewer required: the REAL
 * callback handler is driven with a token-exchange failure whose error
 * carries adversarial material — a drizzle-style "Failed query + params"
 * wrapper (sentinel in the SQL params section), a connection-URL sentinel
 * and a credential-shaped sentinel — and NONE of them may appear in the
 * response or in ANY console channel, including console.log/info/debug,
 * not just warn/error.
 *
 * All sentinel values are fake adversarial fixtures (nothing real); they
 * deliberately do NOT match the repo's leaked-credential guard shapes.
 */

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
    labelFromUserAgent: vi.fn(() => "R4G Test Browser"),
  };
});

import * as googleOidc from "./googleOidc";
import { ENV } from "./env";
import {
  GOOGLE_INTENT_COOKIE,
  GOOGLE_NONCE_COOKIE,
  GOOGLE_PKCE_COOKIE,
  GOOGLE_STATE_COOKIE,
  registerGoogleOAuthRoutes,
} from "./googleOAuth";

type CapturedHandler = (req: Request, res: Response) => void | Promise<void>;

function captureCallback(): CapturedHandler {
  let callback: CapturedHandler | undefined;
  const fakeApp = {
    get: (path: string, fn: CapturedHandler) => {
      if (path === "/api/auth/google/callback") callback = fn;
    },
  } as unknown as Express;
  registerGoogleOAuthRoutes(fakeApp);
  if (!callback) throw new Error("test setup failed: callback route not registered");
  return callback;
}

function callbackRequest(): Request {
  const cookies: Record<string, string> = {
    [GOOGLE_STATE_COOKIE]: "valid-state-value",
    [GOOGLE_NONCE_COOKIE]: "valid-nonce-value",
    [GOOGLE_PKCE_COOKIE]: "valid-code-verifier",
    [GOOGLE_INTENT_COOKIE]: "login",
  };
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => serializeCookie(name, value))
    .join("; ");
  return {
    query: { code: "auth-code-123", state: "valid-state-value" },
    protocol: "https",
    hostname: "example.invalid",
    headers: { cookie: cookieHeader },
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
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };
  return res;
}

const SQL_PARAMS_SENTINEL = "R4GSQLPARAM-SENTINEL-a1b2c3";
const URL_SENTINEL = "R4GURLPARAM-SENTINEL-d4e5f6";
const TOKEN_SENTINEL = "R4GTOKENVAL-SENTINEL-g7h8i9";

/**
 * The adversarial error the token exchange "fails" with, shaped like the
 * real leak-prone failures: an outer HTTP error carrying the token-endpoint
 * URL (with the authorization code) and credential-shaped fragments, whose
 * CAUSE is a drizzle-style wrapper embedding the full SQL and bound params.
 */
function adversarialExchangeError(): Error {
  const drizzleLike: any = new Error(
    "Failed query: insert into `auth_sessions` (`sid`, `token_hash`) values (?, ?)\n" +
      `params: ${SQL_PARAMS_SENTINEL}, ${SQL_PARAMS_SENTINEL}-b`
  );
  const outer: any = new Error(
    `POST https://token.example.invalid/oauth2/v4/token?code=${URL_SENTINEL} failed: ` +
      `token=${TOKEN_SENTINEL} api_key=${TOKEN_SENTINEL}-alt`
  );
  outer.cause = drizzleLike;
  return outer;
}

describe("R3-G/PAT-12 — OAuth callback runtime sanitization across ALL console channels", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalClientId = ENV.googleClientId;
  const originalClientSecret = ENV.googleClientSecret;
  const originalRedirectUri = ENV.googleRedirectUri;

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.googleClientId = originalClientId;
    ENV.googleClientSecret = originalClientSecret;
    ENV.googleRedirectUri = originalRedirectUri;
    vi.restoreAllMocks();
  });

  it("token-exchange failure carrying SQL-params/URL/credential sentinels → 500 fixed body, sentinels in NO console channel (log/info/warn/error/debug)", async () => {
    ENV.authProvider = "google";
    ENV.googleClientId = "test-client-id";
    ENV.googleClientSecret = "test-client-secret";
    ENV.googleRedirectUri = "https://example.invalid/api/auth/google/callback";

    const channelSpies = (["log", "info", "warn", "error", "debug"] as const).map((channel) => ({
      channel,
      spy: vi.spyOn(console, channel).mockImplementation(() => {}),
    }));

    vi.spyOn(googleOidc, "exchangeCodeForTokens").mockRejectedValue(adversarialExchangeError());

    const callback = captureCallback();
    const res = fakeResponse();
    await callback(callbackRequest(), res);

    // Fail-closed login contract: 500 + fixed generic body, no cookies set.
    expect(res.statusCalls).toEqual([500]);
    expect(res.jsonBody).toEqual({ error: "Google sign-in failed" });
    expect((res as any).redirect).not.toHaveBeenCalled();

    // Every sentinel — SQL params, URL/code material, credential values —
    // must be absent from the response AND from EVERY console channel,
    // including console.log/info/debug (the R3-G bug was specifically a raw
    // console.log bypassing sanitization).
    for (const sentinel of [SQL_PARAMS_SENTINEL, URL_SENTINEL, TOKEN_SENTINEL]) {
      expect(JSON.stringify(res.jsonBody)).not.toContain(sentinel);
      for (const { channel, spy } of channelSpies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(sentinel);
      }
    }

    // The fixed sanitized channel is the one that fired, with the constant
    // prefix — never a raw error dump.
    const errorSpy = channelSpies.find((c) => c.channel === "error")!.spy;
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toBe("[GoogleOAuth] Callback failed:");
    // The sanitized summary mentions none of the sentinels and none of the
    // raw SQL text either.
    const loggedSummary = errorSpy.mock.calls[0].slice(1).map(String).join(" ");
    expect(loggedSummary).not.toContain(SQL_PARAMS_SENTINEL);
    expect(loggedSummary).not.toContain("insert into");
  });
});
