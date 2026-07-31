import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// auth.googleConnected backs ProfilePage's "Connected Accounts" section
// (server/routers.ts). protectedProcedure-gated, returns only a boolean -
// see server/db.ts's getAuthIdentityByUserAndProvider for the underlying
// lookup this wraps.

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function authenticatedContext(userId = 55): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: "sample-user",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "manus",
    role: "user",
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

describe("auth.googleConnected", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unauthenticated caller -> rejected with UNAUTHORIZED, the database is never queried", async () => {
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider");
    const caller = appRouter.createCaller(anonymousContext());

    await expect(caller.auth.googleConnected()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("unauthenticated caller -> the rejection is a real TRPCError, not some other unrelated failure", async () => {
    const caller = appRouter.createCaller(anonymousContext());
    await expect(caller.auth.googleConnected()).rejects.toBeInstanceOf(TRPCError);
  });

  it("authenticated, no linked Google identity -> { googleConnected: false }", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(55));

    const result = await caller.auth.googleConnected();

    expect(result).toEqual({ googleConnected: false });
  });

  it("authenticated, has a linked Google identity -> { googleConnected: true }", async () => {
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
      id: 1,
      userId: 55,
      provider: "google",
      providerSubject: "google-sub-abc",
      emailAtLink: "user@example.com",
    } as any);
    const caller = appRouter.createCaller(authenticatedContext(55));

    const result = await caller.auth.googleConnected();

    expect(result).toEqual({ googleConnected: true });
    expect(lookupSpy).toHaveBeenCalledWith(55, "google");
  });

  it("the response never includes providerSubject, sub, emailAtLink, or any other internal authIdentities column - only the googleConnected boolean", async () => {
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
      id: 1,
      userId: 55,
      provider: "google",
      providerSubject: "google-sub-abc",
      emailAtLink: "user@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const caller = appRouter.createCaller(authenticatedContext(55));

    const result = await caller.auth.googleConnected();

    expect(Object.keys(result)).toEqual(["googleConnected"]);
    expect(JSON.stringify(result)).not.toMatch(/google-sub-abc|providerSubject|emailAtLink/);
  });

  it("looks up the identity for the CURRENT session's user id, never anything client-supplied", async () => {
    const lookupSpy = vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(authenticatedContext(999));

    await caller.auth.googleConnected();

    expect(lookupSpy).toHaveBeenCalledWith(999, "google");
  });
});
