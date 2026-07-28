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
  });

  afterEach(() => {
    ENV.cookieSecret = originalSecret;
    ENV.appId = originalAppId;
    vi.restoreAllMocks();
  });

  it("missing cookie -> AnonymousCredentialError with reason no_cookie, no DB access", async () => {
    const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId");

    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie(undefined)));
    expect(error).toBeInstanceOf(AnonymousCredentialError);
    expect((error as AnonymousCredentialError).reason).toBe("no_cookie");
    expect(getUserByOpenIdSpy).not.toHaveBeenCalled();
  });

  it("malformed cookie -> AnonymousCredentialError with reason invalid_session_token (so createContext knows to clear it)", async () => {
    const error = await captureRejection(sdk.authenticateRequest(requestWithCookie("garbage")));
    expect(error).toBeInstanceOf(AnonymousCredentialError);
    expect((error as AnonymousCredentialError).reason).toBe("invalid_session_token");
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
});
