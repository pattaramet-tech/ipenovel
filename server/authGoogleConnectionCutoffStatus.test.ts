import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { appRouter } from "./routers";
import { ENV } from "./_core/env";
import type { TrpcContext } from "./_core/context";

// auth.googleConnectionCutoffStatus backs <MigrationGate>/<GoogleConnectionCutoffBanner>/UpgradeLoginPage
// (client/src/_core/hooks/migrationGate.ts's top-of-file docstring) - the single
// server-authoritative status response those components act on. Wraps
// server/_core/env.ts's evaluateGoogleConnectionCutoff plus this user's own
// connected/exempt status - see server/routers.ts.

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function authenticatedContext(userId = 55, role: "user" | "admin" = "user"): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function anonymousContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("auth.googleConnectionCutoffStatus", () => {
  const originalAuthProvider = ENV.authProvider;
  const originalRequire = ENV.requireGoogleConnection;
  const originalCutoff = ENV.googleConnectionCutoffAfterMs;

  beforeEach(() => {
    ENV.authProvider = "transition";
    ENV.requireGoogleConnection = true;
    ENV.googleConnectionCutoffAfterMs = null;
  });

  afterEach(() => {
    ENV.authProvider = originalAuthProvider;
    ENV.requireGoogleConnection = originalRequire;
    ENV.googleConnectionCutoffAfterMs = originalCutoff;
    vi.restoreAllMocks();
  });

  it("unauthenticated caller -> rejected with UNAUTHORIZED, the database is never queried", async () => {
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");
    const caller = appRouter.createCaller(anonymousContext());

    await expect(caller.auth.googleConnectionCutoffStatus()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("unauthenticated caller -> a real TRPCError, not some other unrelated failure", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    await expect(caller.auth.googleConnectionCutoffStatus()).rejects.toBeInstanceOf(TRPCError);
  });

  it("[rule 9] a regular authenticated user, not connected, gate active -> needsConnection: true, exempt: false", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(55, "user"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(result.enabled).toBe(true);
    expect(result.activeNow).toBe(true);
    expect(result.googleConnected).toBe(false);
    expect(result.exempt).toBe(false);
    expect(result.needsConnection).toBe(true);
  });

  it("[rule 4] a user WITH a linked Google identity -> googleConnected: true, needsConnection: false even though the gate is active", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
      id: 1,
      userId: 55,
      provider: "google",
      providerSubject: "google-sub-abc",
    } as any);
    const caller = appRouter.createCaller(authenticatedContext(55, "user"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(result.googleConnected).toBe(true);
    expect(result.needsConnection).toBe(false);
  });

  it("[rule 5] an admin caller -> exempt: true, needsConnection: false regardless of connection status", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(1, "admin"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(result.exempt).toBe(true);
    expect(result.googleConnected).toBe(false);
    expect(result.needsConnection).toBe(false);
  });

  it("[rule 3] a future cutoff -> enabled true, activeNow false, needsConnection false pre-cutoff even when unconnected", async () => {
    ENV.googleConnectionCutoffAfterMs = Date.now() + 1_000_000;
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(55, "user"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(result.enabled).toBe(true);
    expect(result.activeNow).toBe(false);
    expect(result.needsConnection).toBe(false);
  });

  it("[rule 1] gate disabled entirely -> needsConnection always false, even unconnected", async () => {
    ENV.requireGoogleConnection = false;
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(55, "user"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(result.enabled).toBe(false);
    expect(result.needsConnection).toBe(false);
  });

  it("looks up the identity for the CURRENT session's user id, never anything client-supplied", async () => {
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(999, "user"));

    await caller.auth.googleConnectionCutoffStatus();

    expect(lookupSpy).toHaveBeenCalledWith(999, "google");
  });

  it("[rule 9] response includes serverNow, cutoffAt fields sourced only from the server clock/config - never anything client-suppliable (no input accepted at all)", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(55, "user"));

    const result = await caller.auth.googleConnectionCutoffStatus();

    expect(typeof result.serverNow).toBe("string");
    expect(new Date(result.serverNow).toString()).not.toBe("Invalid Date");
    expect(result.cutoffAt).toBeNull();
  });
});
