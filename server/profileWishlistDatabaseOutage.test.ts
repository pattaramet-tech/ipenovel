import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import * as db from "./db";

// fix/profile-wishlist-error-handling - a database outage must never be
// mistaken for "no wishlist items" ([]) or "novel not found" (NOT_FOUND).
// Same vi.mock + vi.spyOn dependency-injection pattern as
// admin.login.databaseUnavailable.test.ts - no real database connection
// anywhere in this file.
vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

function ctxFor(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `wishlist-outage-${userId}`,
      email: `wishlist-outage-${userId}@example.test`,
      name: "Wishlist Outage Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

async function captureTRPCError(promise: Promise<unknown>): Promise<TRPCError> {
  try {
    await promise;
    throw new Error("expected the call to reject, but it resolved");
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return error;
  }
}

describe("wishlists - database outage handling (no real database)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wishlists.list rejects with SERVICE_UNAVAILABLE, never an empty array, when the database is unreachable", async () => {
    vi.spyOn(db, "getDb").mockResolvedValue(null);
    const caller = appRouter.createCaller(ctxFor(1));

    const error = await captureTRPCError(caller.wishlists.list());
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("wishlists.list never leaks the raw driver error message to the client", async () => {
    vi.spyOn(db, "getDb").mockRejectedValue(
      new Error("connect ECONNREFUSED mysql://dbuser:hunter2@db.internal.example:3306/prod")
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const caller = appRouter.createCaller(ctxFor(1));

    const error = await captureTRPCError(caller.wishlists.list());
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.message).not.toContain("hunter2");
    expect(error.message).not.toContain("mysql://");

    const loggedText = JSON.stringify(errorSpy.mock.calls);
    expect(loggedText).not.toContain("hunter2");
    expect(loggedText).not.toContain("mysql://");
  });

  it("wishlists.add rejects with SERVICE_UNAVAILABLE (never NOT_FOUND) when the database is unreachable, and never even checks the novel", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockRejectedValue(
      new Error("[Database] Database connection is not available")
    );
    const getNovelByIdSpy = vi.spyOn(db, "getNovelById");
    const caller = appRouter.createCaller(ctxFor(1));

    const error = await captureTRPCError(caller.wishlists.add({ novelId: 123456 }));
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.code).not.toBe("NOT_FOUND");
    expect(getNovelByIdSpy).not.toHaveBeenCalled();
  });

  it("wishlists.add proceeds to the normal novel-exists check once the database IS available - the guard changes nothing on the normal path", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    const getNovelByIdSpy = vi.spyOn(db, "getNovelById").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(ctxFor(1));

    const error = await captureTRPCError(caller.wishlists.add({ novelId: 123456 }));
    expect(error.code).toBe("NOT_FOUND");
    expect(getNovelByIdSpy).toHaveBeenCalledTimes(1);
  });
});
