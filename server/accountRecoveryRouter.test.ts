import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import * as accountRecoveryService from "./services/accountRecoveryService";
import { AccountRecoveryError } from "./services/accountRecoveryService";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Router-level tests for the accountRecovery.* procedures - authorization
// and ownership boundaries the SERVICE layer cannot enforce on its own
// (it has no notion of "the caller's own session"). Business-rule
// correctness (safety assessment, transactional approval) is covered in
// server/services/accountRecoveryService.test.ts - these tests mock the
// service layer entirely and focus on what routers.ts itself is
// responsible for.

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

vi.mock("./services/accountRecoveryService", async () => {
  const actual = await vi.importActual<typeof accountRecoveryService>("./services/accountRecoveryService");
  return { ...actual };
});

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function contextFor(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function fakeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 1,
    openId: "user-1",
    email: "user@example.com",
    name: "Somchai",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...overrides,
  };
}

describe("accountRecovery.create", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unauthenticated caller -> UNAUTHORIZED, the service is never invoked", async () => {
    const submitSpy = vi.spyOn(accountRecoveryService, "submitAccountRecoveryRequest");
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.accountRecovery.create({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("always uses the caller's OWN session id as requesterUserId, never anything from input (create has no such input field at all)", async () => {
    const submitSpy = vi
      .spyOn(accountRecoveryService, "submitAccountRecoveryRequest")
      .mockResolvedValue({ id: 1 } as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 42 })));

    await caller.accountRecovery.create({ claimedLegacyEmail: "old@example.com" });

    expect(submitSpy).toHaveBeenCalledWith(expect.objectContaining({ requesterUserId: 42 }));
  });

  it("[non-Google requester] service rejects with NOT_GOOGLE_LINKED -> mapped to a real TRPCError with BAD_REQUEST", async () => {
    vi.spyOn(accountRecoveryService, "submitAccountRecoveryRequest").mockRejectedValue(
      new AccountRecoveryError("NOT_GOOGLE_LINKED", "You must be signed in with a real, connected Google account")
    );
    const caller = appRouter.createCaller(contextFor(fakeUser()));

    const error = await caller.accountRecovery.create({}).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("already-pending -> mapped to CONFLICT", async () => {
    vi.spyOn(accountRecoveryService, "submitAccountRecoveryRequest").mockRejectedValue(
      new AccountRecoveryError("ALREADY_PENDING", "You already have a pending account recovery request")
    );
    const caller = appRouter.createCaller(contextFor(fakeUser()));

    await expect(caller.accountRecovery.create({})).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("accountRecovery.myRequests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unauthenticated caller -> UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.accountRecovery.myRequests()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("only ever lists the CALLER's own requests, never accepts a target user id", async () => {
    const listSpy = vi.spyOn(db, "listAccountRecoveryRequestsForUser").mockResolvedValue([]);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 77 })));
    await caller.accountRecovery.myRequests();
    expect(listSpy).toHaveBeenCalledWith(77);
  });
});

describe("accountRecovery.cancel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unauthenticated caller -> UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.accountRecovery.cancel({ requestId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a request that belongs to a DIFFERENT user -> NOT_FOUND, never reveals it exists, never cancels it", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({ id: 1, requesterUserId: 999, status: "pending" } as any);
    const reviewSpy = vi.spyOn(accountRecoveryService, "reviewAccountRecoveryRequest");
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 1 })));

    await expect(caller.accountRecovery.cancel({ requestId: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it("a request that does not exist at all -> the same NOT_FOUND (indistinguishable from someone else's request)", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 1 })));
    await expect(caller.accountRecovery.cancel({ requestId: 999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the caller's own request -> cancels via the service, with action='cancel' and actorAdminId null", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({ id: 1, requesterUserId: 1, status: "pending" } as any);
    const reviewSpy = vi
      .spyOn(accountRecoveryService, "reviewAccountRecoveryRequest")
      .mockResolvedValue({ id: 1, status: "cancelled" } as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 1 })));

    await caller.accountRecovery.cancel({ requestId: 1 });

    expect(reviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 1, action: "cancel", actorAdminId: null })
    );
  });
});

describe("accountRecovery.admin.* - every mutation/query requires a real admin session", () => {
  afterEach(() => vi.restoreAllMocks());

  it("list: non-admin (regular user) -> FORBIDDEN", async () => {
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.accountRecovery.admin.list({ page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("list: unauthenticated -> UNAUTHORIZED, never FORBIDDEN (distinguishes 'no session' from 'wrong role')", async () => {
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.accountRecovery.admin.list({ page: 1, pageSize: 20 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("detail: non-admin -> FORBIDDEN, the database is never queried", async () => {
    const getSpy = vi.spyOn(db, "getAccountRecoveryRequestById");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.accountRecovery.admin.detail({ requestId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("searchLegacyAccount: non-admin -> FORBIDDEN", async () => {
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(
      caller.accountRecovery.admin.searchLegacyAccount({ mode: "id", value: "1" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("approve: non-admin -> FORBIDDEN, the service is never invoked", async () => {
    const executeSpy = vi.spyOn(accountRecoveryService, "executeAccountRecovery");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(
      caller.accountRecovery.admin.approve({ requestId: 1, targetUserId: 2, reason: "verified" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("reject: non-admin -> FORBIDDEN", async () => {
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.accountRecovery.admin.reject({ requestId: 1, reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("block: non-admin -> FORBIDDEN", async () => {
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.accountRecovery.admin.block({ requestId: 1, reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("approve: real admin -> reaches the service layer, passing the admin's own id (never client-suppliable) as adminId", async () => {
    const executeSpy = vi
      .spyOn(accountRecoveryService, "executeAccountRecovery")
      .mockResolvedValue({ request: { id: 1, status: "approved" }, assessment: {} } as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 5, role: "admin" })));

    await caller.accountRecovery.admin.approve({ requestId: 1, targetUserId: 2, reason: "verified via order #123" });

    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 1, targetUserId: 2, adminId: 5, reason: "verified via order #123" })
    );
  });

  it("searchLegacyAccount: admin search results never include passwordHash - only the masked/allowlisted fields", async () => {
    vi.spyOn(db, "getUserById").mockResolvedValue({
      id: 2,
      openId: "legacy-user-2",
      name: "Legacy Name",
      email: "legacy@example.com",
      loginMethod: "manus",
      passwordHash: "should-never-appear",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountRecovery.admin.searchLegacyAccount({ mode: "id", value: "2" });

    expect(JSON.stringify(result)).not.toMatch(/should-never-appear/);
    expect(JSON.stringify(result)).not.toMatch(/legacy@example\.com/); // full email never returned, only masked
  });
});
