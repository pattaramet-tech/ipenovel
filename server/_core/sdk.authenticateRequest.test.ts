import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { COOKIE_NAME } from "@shared/const";
import * as db from "../db";
import { AnonymousCredentialError } from "./authErrors";
import { ENV } from "./env";
import { sdk } from "./sdk";

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

  it("valid session for a known user returns that user and refreshes lastSignedIn only", async () => {
    const token = await sdk.createSessionToken("user-123", { name: "Somchai" });
    const user = fakeUser();
    vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
    const upsertSpy = vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

    const result = await sdk.authenticateRequest(requestWithCookie(token));

    expect(result).toBe(user);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "user-123" })
    );
    // Only lastSignedIn is refreshed for an already-known user - name must
    // not be part of this call at all (nothing to normalize; the user was
    // already found by openId, this is not the OAuth-sync path).
    expect(upsertSpy.mock.calls[0][0]).not.toHaveProperty("name");
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

  describe("local admin session (\"admin-<id>\" openId)", () => {
    it("returns the user when the database confirms role: admin", async () => {
      const adminUser = fakeUser({ id: 7, openId: "admin-7", role: "admin" });
      vi.spyOn(db, "getUserById").mockResolvedValue(adminUser);

      const token = await sdk.createSessionToken("admin-7", { name: "admin@example.invalid" });
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(adminUser);
    });

    it("rejects with reason admin_session_invalid (not cleared, see context.test.ts) when the database role is not admin - the JWT alone never grants access", async () => {
      const demotedUser = fakeUser({ id: 7, openId: "admin-7", role: "user" });
      vi.spyOn(db, "getUserById").mockResolvedValue(demotedUser);

      const token = await sdk.createSessionToken("admin-7", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("admin_session_invalid");
    });

    it("rejects (AnonymousCredentialError) when no such admin user exists in the database", async () => {
      vi.spyOn(db, "getUserById").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("admin-999", {});
      await expect(sdk.authenticateRequest(requestWithCookie(token))).rejects.toBeInstanceOf(
        AnonymousCredentialError
      );
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

    it("valid admin JWT + database unavailable -> rejects, NOT AnonymousCredentialError, NOT reinterpreted as a demoted/deleted admin", async () => {
      const dbOutage = new Error("[Database] Database connection is not available");
      vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(dbOutage);
      const getUserByIdSpy = vi.spyOn(db, "getUserById");

      const token = await sdk.createSessionToken("admin-7", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));

      expect(error).toBe(dbOutage);
      expect(error).not.toBeInstanceOf(AnonymousCredentialError);
      // In particular, this must not surface as reason: "admin_session_invalid"
      // (which would silently misreport a database outage as a demoted/deleted
      // admin account) - it isn't even the same error class.
      expect((error as any).reason).toBeUndefined();
      expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it("database query throwing AFTER the availability guard passes still propagates as-is (unaffected by the new guard)", async () => {
      const queryError = new Error("ER_LOCK_WAIT_TIMEOUT");
      vi.spyOn(db, "getUserByOpenId").mockRejectedValue(queryError);

      const token = await sdk.createSessionToken("user-123", {});
      await expect(sdk.authenticateRequest(requestWithCookie(token))).rejects.toBe(queryError);
    });

    it("an actually-nonexistent admin, with the database genuinely available, still rejects per existing policy (the guard does not change this outcome)", async () => {
      vi.spyOn(db, "getUserById").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("admin-999", {});
      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("admin_session_invalid");
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
    });

    it("no cutoff configured (null) -> an old session still authenticates normally", async () => {
      ENV.forceReloginAfterSeconds = null;
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const token = await sdk.createSessionToken("user-123", {});
      const result = await sdk.authenticateRequest(requestWithCookie(token));

      expect(result).toBe(user);
    });

    it("a regular user's session issued BEFORE the cutoff -> rejected with AnonymousCredentialError reason forced_relogin, never logs the JWT/cookie value", async () => {
      const token = await sdk.createSessionToken("user-123", {});
      // Cutoff strictly in the future relative to the token's own iat (now).
      ENV.forceReloginAfterSeconds = Math.floor(Date.now() / 1000) + 3600;

      const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(token)));
      expect(error).toBeInstanceOf(AnonymousCredentialError);
      expect((error as AnonymousCredentialError).reason).toBe("forced_relogin");
      expect((error as Error).message).not.toContain(token);
    });

    it("a regular user's session issued AFTER the cutoff -> authenticates normally, exactly as if the cutoff didn't exist", async () => {
      const token = await sdk.createSessionToken("user-123", {});
      // Cutoff strictly in the past relative to the token's own iat (now).
      ENV.forceReloginAfterSeconds = Math.floor(Date.now() / 1000) - 3600;
      const user = fakeUser();
      vi.spyOn(db, "getUserByOpenId").mockResolvedValue(user);
      vi.spyOn(db, "upsertUser").mockResolvedValue(undefined);

      const result = await sdk.authenticateRequest(requestWithCookie(token));
      expect(result).toBe(user);
    });

    it("a LOCAL ADMIN session (openId \"admin-*\") issued BEFORE the cutoff is NEVER rejected for forced_relogin - the admin-openId branch returns/throws before the cutoff check is ever reached", async () => {
      const adminUser = fakeUser({ id: 7, openId: "admin-7", role: "admin" });
      vi.spyOn(db, "getUserById").mockResolvedValue(adminUser);

      const token = await sdk.createSessionToken("admin-7", {});
      ENV.forceReloginAfterSeconds = Math.floor(Date.now() / 1000) + 3600;

      const result = await sdk.authenticateRequest(requestWithCookie(token));
      expect(result).toBe(adminUser);
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
});
