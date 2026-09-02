import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COOKIE_NAME } from "@shared/const";
import * as db from "../db";
import { AnonymousCredentialError } from "./authErrors";
import { ENV } from "./env";
import { sdk } from "./sdk";

/**
 * The real, private axios instance sdk.ts's authenticateRequest ultimately
 * posts to via getUserInfoWithJwt (SDKServer's own `this.client`, created
 * once at module load by createOAuthHttpClient() - see sdk.ts). Accessed
 * via `as any` specifically so tests below can assert "no HTTP call to
 * Manus's OAuth server happened at all", one level below just spying on
 * the getUserInfoWithJwt wrapper method itself - the two are deliberately
 * separate assertions per this PR's test requirements.
 */
const oauthHttpClient = (sdk as unknown as { client: { post: (...args: unknown[]) => unknown } }).client;

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

function requestWithCookie(cookieValue: string | undefined): Request {
  return {
    headers: { cookie: cookieValue ? `${COOKIE_NAME}=${cookieValue}` : undefined },
  } as unknown as Request;
}

function fakeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    openId: "user-123",
    email: "user@example.invalid",
    name: "Somchai",
    loginMethod: "google",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  } as any;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("sdk.authenticateRequest", () => {
  const originalSecret = ENV.cookieSecret;
  const originalAppId = ENV.appId;

  beforeEach(() => {
    ENV.cookieSecret = "test-only-session-secret-not-a-real-value-0123456789";
    ENV.appId = "test-app-id";
    // Available by default - this sandbox has no real DATABASE_URL, so
    // without this every test below would fail at the assertDatabaseAvailable
    // guard before ever reaching the behavior it's testing. Individual tests
    // in the "database unavailable" describe block below override this.
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
  });

  afterEach(() => {
    ENV.cookieSecret = originalSecret;
    ENV.appId = originalAppId;
    vi.restoreAllMocks();
  });

  it("missing cookie -> AnonymousCredentialError with reason no_cookie, no DB access at all (not even the availability guard)", async () => {
    const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId");
    const assertDbSpy = vi.spyOn(db, "assertDatabaseAvailable");

    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(undefined)));
    expect(error).toBeInstanceOf(AnonymousCredentialError);
    expect((error as AnonymousCredentialError).reason).toBe("no_cookie");
    expect(getUserByOpenIdSpy).not.toHaveBeenCalled();
    expect(assertDbSpy).not.toHaveBeenCalled();
  });

  it("malformed cookie -> AnonymousCredentialError with reason invalid_session_token (so createContext knows to clear it), no DB access at all", async () => {
    const assertDbSpy = vi.spyOn(db, "assertDatabaseAvailable");

    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie("garbage")));
    expect(error).toBeInstanceOf(AnonymousCredentialError);
    expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
    expect(assertDbSpy).not.toHaveBeenCalled();
  });

  it("valid session for a known user is read-only with respect to users", async () => {
    const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
    const user = fakeUser();
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
    const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

    const result = await sdk.authenticateRequest(requestWithCookie(token));

    expect(result).toBe(user);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("unknown user: syncs from the OAuth provider and omits (never nulls) the name field when the provider sends no usable name", async () => {
    vi.spyOn(db, "getUserByOpenId")
      .mockResolvedValueOnce(undefined) // not found yet
      .mockResolvedValueOnce(fakeUser({ openId: "new-user-1", name: null })); // found after sync
    const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
    vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
      openId: "new-user-1",
      name: "",
      email: "new@example.invalid",
      platform: "google",
    } as any);

    const token = await sdk.createSessionToken("new-user-1", {});
    await sdk.authenticateRequest(requestWithCookie(token));

    const syncCall = upsertSpy.mock.calls[0][0];
    expect(syncCall.openId).toBe("new-user-1");
    // undefined - never null - so upsertUser's assignNullable (server/db.ts)
    // skips the field entirely and leaves any existing stored name alone,
    // rather than writing null over it.
    expect(syncCall.name).toBeUndefined();
  });

  it("unknown user with a real provider name: the name IS included in the sync upsert", async () => {
    vi.spyOn(db, "getUserByOpenId")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(fakeUser({ openId: "new-user-2", name: "Real Name" }));
    const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
    vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
      openId: "new-user-2",
      name: "  Real Name  ",
      email: "new2@example.invalid",
      platform: "google",
    } as any);

    const token = await sdk.createSessionToken("new-user-2", {});
    await sdk.authenticateRequest(requestWithCookie(token));

    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ name: "Real Name" });
  });

  it("Apple-style user with no name at all can still authenticate", async () => {
    const user = fakeUser({ openId: "apple-user", name: null });
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
    vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

    const token = await sdk.createSessionToken("apple-user", {});
    const result = await sdk.authenticateRequest(requestWithCookie(token));

    expect(result).toBe(user);
    expect(result.name).toBeNull();
  });

  it("valid session but still no user record after sync -> AnonymousCredentialError with reason no_user_record (not cleared - a validly-signed token, see context.test.ts)", async () => {
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(undefined);
    vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
    vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
      openId: "ghost-user",
      name: "Ghost",
      email: null,
      platform: "google",
    } as any);

    const token = await sdk.createSessionToken("ghost-user", {});
    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
    expect(error).toBeInstanceOf(AnonymousCredentialError);
    expect((error as AnonymousCredentialError).reason).toBe("no_user_record");
  });

  it("missing VITE_APP_ID during verification propagates as a plain configuration error, not AnonymousCredentialError", async () => {
    const token = await sdk.createSessionToken("user-123", {});
    ENV.appId = "";

    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
    expect(error).not.toBeInstanceOf(AnonymousCredentialError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/VITE_APP_ID/);
  });

  it("database failure while looking up the user propagates (NOT converted to anonymous)", async () => {
    const dbError = new Error("connection refused");
    vi.spyOn(db, "getUserByOpenId").mockRejectedValue(dbError);

    const token = await sdk.createSessionToken("user-123", {});
    await expect(sdk.authenticateRequest(requestWithCookie(token))).rejects.toBe(dbError);
  });

  it("OAuth provider failure during sync propagates (NOT converted to anonymous)", async () => {
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(undefined);
    const oauthError = new Error("ETIMEDOUT contacting OAuth server");
    vi.spyOn(sdk, "getUserInfoWithJwt").mockRejectedValue(oauthError);

    const token = await sdk.createSessionToken("user-123", {});
    await expect(sdk.authenticateRequest(requestWithCookie(token))).rejects.toBe(oauthError);
  });

  describe("legacy local admin session (\"admin-<id>\" openId) - local admin login removed", () => {
    it("rejects immediately with reason invalid_session_token, even when the database WOULD confirm role: admin - the JWT shape alone can never grant access anymore, and the account is never even looked up", async () => {
      const adminUser = fakeUser({ id: 7, openId: "admin-7", role: "admin" });
      const getUserByIdSpy = vi.spyOn(db, "getUserById").mockResolvedValue(adminUser);

      const token = await sdk.createSessionToken("admin-7", { name: "admin@example.invalid" });
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
      expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it("rejects the same way for an id that maps to no real user at all", async () => {
      const getUserByIdSpy = vi.spyOn(db, "getUserById");

      const token = await sdk.createSessionToken("admin-999", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
      expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it("rejects the same way even when the database is completely unavailable - the shape check runs BEFORE assertDatabaseAvailable, so an outage never matters for an old admin-<id> cookie", async () => {
      const assertDbSpy = vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(
        new Error("[Database] Database connection is not available")
      );

      const token = await sdk.createSessionToken("admin-7", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
      expect(assertDbSpy).not.toHaveBeenCalled();
    });

    it('"admin-editor" (an "admin-" prefix, but NOT admin-<digits>) is NOT caught by this legacy guard - it falls through to the normal getUserByOpenId lookup like any other session, and can authenticate as a real user', async () => {
      const realUser = fakeUser({ id: 55, openId: "admin-editor", role: "user" });
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId").mockResolvedValue(realUser);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("admin-editor", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(realUser);
      expect(getUserByOpenIdSpy).toHaveBeenCalledWith("admin-editor");
    });

    it('"administrator-example" (merely starts with letters resembling "admin", not the exact legacy shape) is NOT caught by this legacy guard either - normal lookup', async () => {
      const realUser = fakeUser({ id: 56, openId: "administrator-example", role: "user" });
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId").mockResolvedValue(realUser);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("administrator-example", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(realUser);
      expect(getUserByOpenIdSpy).toHaveBeenCalledWith("administrator-example");
    });

    it("a real Google-style openId (\"google:...\") is completely unaffected by this legacy guard - normal lookup, exactly as before", async () => {
      const googleUser = fakeUser({ id: 57, openId: "google:1234567890", role: "user", loginMethod: "google" });
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId").mockResolvedValue(googleUser);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("google:1234567890", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(googleUser);
      expect(getUserByOpenIdSpy).toHaveBeenCalledWith("google:1234567890");
    });
  });

  describe("database unavailable", () => {
    it("valid normal-user JWT + database unavailable -> rejects, NOT AnonymousCredentialError, no OAuth sync attempted", async () => {
      const dbOutage = new Error("[Database] Database connection is not available");
      vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(dbOutage);
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId");
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt");

      const token = await sdk.createSessionToken("user-123", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBe(dbOutage);
      expect(error).not.toBeInstanceOf(AnonymousCredentialError);
      // The database guard runs before any lookup, so a normal getUserByOpenId
      // lookup - and, downstream of that, the OAuth-sync fallback - never runs.
      expect(getUserByOpenIdSpy).not.toHaveBeenCalled();
      expect(getUserInfoWithJwtSpy).not.toHaveBeenCalled();
    });

    it("database query throwing AFTER the availability guard passes still propagates as-is (unaffected by the new guard)", async () => {
      const queryError = new Error("ER_LOCK_WAIT_TIMEOUT");
      vi.spyOn(db, "getUserByOpenId").mockRejectedValue(queryError);

      const token = await sdk.createSessionToken("user-123", {});
      await expect(sdk.authenticateRequest(requestWithCookie(token))).rejects.toBe(queryError);
    });

    it("an actually-nonexistent user, with the database genuinely available, still performs the OAuth sync per existing policy (the guard does not change this outcome)", async () => {
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(undefined);
      const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
        openId: "user-123",
        name: "Somchai",
        email: null,
        platform: "google",
      } as any);

      const token = await sdk.createSessionToken("user-123", {});
      await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(getUserInfoWithJwtSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy).toHaveBeenCalled();
    });
  });

  describe("AUTH_FORCE_RELOGIN_AFTER", () => {
    const originalCutoff = ENV.forceReloginAfterSeconds;

    afterEach(() => {
      ENV.forceReloginAfterSeconds = originalCutoff;
      vi.useRealTimers();
    });

    it("[required test 6] no cutoff configured (null) -> an old session still authenticates normally", async () => {
      ENV.forceReloginAfterSeconds = null;
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("user-123", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(user);
    });

    it("[required test 1] cutoff set in the FUTURE -> a session issued right now still authenticates normally (scheduled activation, not immediate - no login loop)", async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      ENV.forceReloginAfterSeconds = nowSeconds + 3600;
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("user-123", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(user);
    });

    it("[required test 2] once the server clock reaches the cutoff, a session issued BEFORE it is rejected (forced_relogin), never logs the JWT/cookie value, no console call at all", async () => {
      vi.useFakeTimers();
      const t0 = new Date("2026-01-01T00:00:00Z");
      vi.setSystemTime(t0);
      const token = await sdk.createSessionToken("user-123", {}); // iat = t0

      const cutoff = new Date(t0.getTime() + 60_000); // 1 minute after t0
      ENV.forceReloginAfterSeconds = Math.floor(cutoff.getTime() / 1000);
      // Advance the server's own clock to exactly the cutoff.
      vi.setSystemTime(cutoff);

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("forced_relogin");
      expect((error as Error).message).not.toContain(token);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("[required test 3] a session issued AFTER an already-active cutoff authenticates normally", async () => {
      vi.useFakeTimers();
      const cutoff = new Date("2026-01-01T00:00:00Z");
      ENV.forceReloginAfterSeconds = Math.floor(cutoff.getTime() / 1000);

      vi.setSystemTime(new Date(cutoff.getTime() + 60_000)); // mint AFTER the cutoff
      const token = await sdk.createSessionToken("user-123", {});
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const result = await sdk.authenticateRequest(requestWithCookie(token));
      expect(result).toBe(user);
    });

    it("[required test 4] a session issued EXACTLY at the cutoff (iat === cutoffSeconds) authenticates normally - the boundary is inclusive on the safe side", async () => {
      vi.useFakeTimers();
      const cutoff = new Date("2026-01-01T00:00:00Z");
      vi.setSystemTime(cutoff);
      const token = await sdk.createSessionToken("user-123", {}); // iat === cutoffSeconds exactly
      ENV.forceReloginAfterSeconds = Math.floor(cutoff.getTime() / 1000);
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const result = await sdk.authenticateRequest(requestWithCookie(token));
      expect(result).toBe(user);
    });

    it("[required test 5] a legacy LOCAL ADMIN-shaped session, even one issued before an already-ACTIVE cutoff (one that WOULD reject a regular user), is rejected outright as invalid_session_token - it never reaches the forced_relogin cutoff check at all, and is never authenticated as the admin user either way", async () => {
      vi.useFakeTimers();
      const t0 = new Date("2026-01-01T00:00:00Z");
      vi.setSystemTime(t0);
      const adminUser = fakeUser({ id: 7, openId: "admin-7", role: "admin" });
      const getUserByIdSpy = vi.spyOn(db, "getUserById").mockResolvedValue(adminUser);
      const token = await sdk.createSessionToken("admin-7", {}); // iat = t0

      const cutoff = new Date(t0.getTime() + 60_000);
      ENV.forceReloginAfterSeconds = Math.floor(cutoff.getTime() / 1000);
      vi.setSystemTime(new Date(cutoff.getTime() + 1000)); // now is past the cutoff - genuinely active

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
      expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it("[required test 7] the only call site (authenticateRequest) never passes a third 'now' argument - the real server clock (the function's own default) is the only source, never anything client-supplied", () => {
      const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sdk.ts"), "utf8");
      // Anchored specifically to the CALL site (inside authenticateRequest,
      // using the real session/ENV values) - never the function's own
      // declaration line, which also contains the substring
      // "isSessionIssuedBeforeCutoff(" followed by its parameter list
      // (including a nested `Date.now()` call that would confuse a naive
      // "up to the next close-paren" match).
      const callSiteMatch = source.match(/isSessionIssuedBeforeCutoff\(session\.issuedAtSeconds,\s*ENV\.forceReloginAfterSeconds\)/);
      expect(callSiteMatch).toBeTruthy();

      // And there is exactly ONE call site total (the declaration doesn't
      // count as a call) - so this is provably the only place the function
      // is ever invoked in this file.
      const allCallSites = [...source.matchAll(/(?<!function )isSessionIssuedBeforeCutoff\(/g)];
      expect(allCallSites.length).toBe(1);
    });

    it("does not touch JWT_SECRET/session signing at all - a session issued after the flag is later disabled again still just works", async () => {
      const originalSecret = ENV.cookieSecret;
      const token = await sdk.createSessionToken("user-123", {});
      ENV.forceReloginAfterSeconds = Math.floor(Date.now() / 1000) - 3600;
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      await sdk.authenticateRequest(requestWithCookie(token));

      expect(ENV.cookieSecret).toBe(originalSecret);
    });
  });

  describe("orphaned-session Manus OAuth sync is gated by isManusAuthActive()", () => {
    const originalAuthProvider = ENV.authProvider;

    afterEach(() => {
      ENV.authProvider = originalAuthProvider;
    });

    it("[A] AUTH_PROVIDER=google + orphaned session -> rejects with no_user_record, and getUserInfoWithJwt/the OAuth HTTP client/the OAuth-sync upsertUser are NEVER called", async () => {
      ENV.authProvider = "google";
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId").mockResolvedValue(undefined);
      const upsertSpy = vi.spyOn(db, "upsertUser");
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt");
      // Also stubbed to reject fast (never actually resolve/hang on a real
      // network call) so that if the gate ever regresses, this test fails
      // cleanly on the wrong-error-type assertion below instead of timing
      // out trying to reach a real OAuth server.
      const oauthClientPostSpy = vi
        .spyOn(oauthHttpClient, "post")
        .mockRejectedValue(new Error("[TEST] the Manus OAuth HTTP client must never be called in google mode"));

      const token = await sdk.createSessionToken("orphaned-google-user", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("no_user_record");
      expect(getUserByOpenIdSpy).toHaveBeenCalledWith("orphaned-google-user");
      expect(getUserInfoWithJwtSpy).not.toHaveBeenCalled();
      expect(oauthClientPostSpy).not.toHaveBeenCalled();
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it("[B] AUTH_PROVIDER=manus + the same orphaned session -> the existing Manus OAuth sync path still executes exactly as before", async () => {
      ENV.authProvider = "manus";
      vi.spyOn(db, "getUserByOpenId")
        .mockResolvedValueOnce(undefined) // not found yet
        .mockResolvedValueOnce(fakeUser({ openId: "orphaned-manus-user" })); // found after sync
      const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
        openId: "orphaned-manus-user",
        name: "Somchai",
        email: null,
        platform: "google",
      } as any);

      const token = await sdk.createSessionToken("orphaned-manus-user", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(getUserInfoWithJwtSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy).toHaveBeenCalled();
      expect(result.openId).toBe("orphaned-manus-user");
    });

    it("[C] AUTH_PROVIDER=transition + the same orphaned session -> the existing Manus OAuth sync path still executes exactly as before", async () => {
      ENV.authProvider = "transition";
      vi.spyOn(db, "getUserByOpenId")
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(fakeUser({ openId: "orphaned-transition-user" }));
      const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt").mockResolvedValue({
        openId: "orphaned-transition-user",
        name: "Somchai",
        email: null,
        platform: "google",
      } as any);

      const token = await sdk.createSessionToken("orphaned-transition-user", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(getUserInfoWithJwtSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy).toHaveBeenCalled();
      expect(result.openId).toBe("orphaned-transition-user");
    });

    it("[D] AUTH_PROVIDER=google + an EXISTING db user -> succeeds normally, with no Manus OAuth call of any kind", async () => {
      ENV.authProvider = "google";
      const user = fakeUser({ openId: "existing-google-user" });
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt");
      const oauthClientPostSpy = vi
        .spyOn(oauthHttpClient, "post")
        .mockRejectedValue(new Error("[TEST] the Manus OAuth HTTP client must never be called for an existing user"));

      const token = await sdk.createSessionToken("existing-google-user", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(user);
      expect(getUserInfoWithJwtSpy).not.toHaveBeenCalled();
      expect(oauthClientPostSpy).not.toHaveBeenCalled();
      // Routine session authentication is read-only for an existing user;
      // lastSignedIn belongs to the actual login/callback boundary, not
      // every auth.me/API request.
      expect(upsertSpy).not.toHaveBeenCalled();
    });

    it("[E] AUTH_PROVIDER=google + database unavailable -> still propagates the infrastructure error, never misclassified as no_user_record, no OAuth sync attempted", async () => {
      ENV.authProvider = "google";
      const dbOutage = new Error("[Database] Database connection is not available");
      vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(dbOutage);
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId");
      const getUserInfoWithJwtSpy = vi.spyOn(sdk, "getUserInfoWithJwt");

      const token = await sdk.createSessionToken("some-user", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBe(dbOutage);
      expect(error).not.toBeInstanceOf(AnonymousCredentialError);
      expect(getUserByOpenIdSpy).not.toHaveBeenCalled();
      expect(getUserInfoWithJwtSpy).not.toHaveBeenCalled();
    });

    it("[F] AUTH_PROVIDER=google + no cookie -> still AnonymousCredentialError(no_cookie), unaffected by the new gate", async () => {
      ENV.authProvider = "google";

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(undefined)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("no_cookie");
    });

    it("[F] AUTH_PROVIDER=google + a malformed/garbage cookie -> still AnonymousCredentialError(invalid_session_token), unaffected by the new gate", async () => {
      ENV.authProvider = "google";

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie("garbage")));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
    });

    it("[F] AUTH_PROVIDER=google + an expired session -> still AnonymousCredentialError(invalid_session_token), unaffected by the new gate", async () => {
      ENV.authProvider = "google";
      const token = await sdk.createSessionToken("expiring-user", { expiresInMs: -1000 });

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
    });

    it("static: the orphaned-user getUserInfoWithJwt sync block is guarded by isManusAuthActive(), not left unconditional", () => {
      const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sdk.ts"), "utf8");
      // Anchored to the actual `if` condition immediately guarding the
      // sync block - not merely "isManusAuthActive appears somewhere in
      // the file" - so a future refactor that moves the call elsewhere
      // without actually gating this block would still fail this check.
      expect(source).toMatch(/if\s*\(\s*!user\s*&&\s*isManusAuthActive\(\)\s*\)\s*\{/);
    });
  });
});
