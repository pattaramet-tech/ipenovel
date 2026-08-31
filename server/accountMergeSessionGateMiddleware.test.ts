import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import * as db from "./db";
import type { TrpcContext } from "./_core/context";

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function userContext(overrides: Partial<AuthenticatedUser> = {}): TrpcContext {
  return {
    user: {
      id: 55,
      openId: "merged-source-openid",
      email: "source@example.test",
      name: "Merged Source",
      loginMethod: "google",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
      ...overrides,
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function markCompletedSource() {
  return vi.spyOn(db, "getCompletedAccountMergeForSource").mockResolvedValue({
    id: 9,
    sourceUserId: 55,
    targetUserId: 77,
    completedAt: new Date(),
  } as any);
}

describe("IPE-008 completed-merge Source session boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks an ordinary protected business mutation before any cart write", async () => {
    markCompletedSource();
    const cartSpy = vi.spyOn(db, "getOrCreateCart");
    const caller = appRouter.createCaller(userContext());

    const error = await caller.cart.clear().catch(e => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("FORBIDDEN");
    expect((error as any).cause?.code).toBe("ACCOUNT_MERGED_RELOGIN_REQUIRED");
    expect(cartSpy).not.toHaveBeenCalled();
  });

  it("blocks Account Recovery create through mergeAwareAuthenticatedProcedure before service writes", async () => {
    markCompletedSource();
    const createSpy = vi.spyOn(db, "createAccountRecoveryRequest");
    const caller = appRouter.createCaller(userContext());

    const error = await caller.accountRecovery
      .create({ evidenceNote: "should never write" })
      .catch(e => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as any).cause?.code).toBe("ACCOUNT_MERGED_RELOGIN_REQUIRED");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("keeps historical recovery reads reachable so the UI can explain the completed workflow", async () => {
    markCompletedSource();
    vi.spyOn(db, "listAccountRecoveryRequestsForUser").mockResolvedValue([
      { id: 1, status: "blocked" },
    ] as any);
    const caller = appRouter.createCaller(userContext());

    await expect(caller.accountRecovery.myRequests()).resolves.toEqual([
      { id: 1, status: "blocked" },
    ]);
  });

  it("auth status remains reachable and explicitly returns accountMerged=true without exposing target identity", async () => {
    markCompletedSource();
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(
      undefined
    );
    const caller = appRouter.createCaller(userContext());

    const result = await caller.auth.googleConnectionCutoffStatus();
    expect(result.accountMerged).toBe(true);
    expect(JSON.stringify(result)).not.toContain("77");
    expect(JSON.stringify(result)).not.toContain("source@example.test");
  });

  it("logout remains reachable so the stale session can terminate itself", async () => {
    markCompletedSource();
    const caller = appRouter.createCaller(userContext());
    await expect(caller.auth.logout()).resolves.toEqual({ success: true });
  });
});
