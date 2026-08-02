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

describe("accountRecovery.admin.previewApproval - privacy: never leaks the Google sub, a full email, or any token/credential", () => {
  afterEach(() => vi.restoreAllMocks());

  const SECRET_GOOGLE_SUB = "sub-123456789-SHOULD-NEVER-LEAVE-THE-SERVER";
  const SECRET_FULL_EMAIL = "very-real-legacy-owner@example.com";

  function mockAssessmentWithRealIdentity() {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({
      id: 1,
      requesterUserId: 10,
      status: "pending",
    } as any);
    // Mocks the SERVICE layer's internal assessment (never mocks
    // toSafeAdminAssessmentDto itself - that's the real, unmocked
    // stripping function this test exists to prove actually runs).
    vi.spyOn(accountRecoveryService, "assessAccountRecoverySafety").mockResolvedValue({
      requestId: 1,
      sourceUserId: 10,
      targetUserId: 20,
      sourceExists: true,
      targetExists: true,
      sourceIsAdmin: false,
      targetIsAdmin: false,
      sourceGoogleIdentity: { id: 900, providerSubject: SECRET_GOOGLE_SUB, emailAtLink: SECRET_FULL_EMAIL },
      targetHasGoogleIdentity: false,
      economicDataFindings: [],
      userOwnedDataFindings: [],
      blockReasons: [],
      warnings: [],
      canApprove: true,
      isFullyAutomatable: true,
    });
  }

  it("the response never contains the Google sub (providerSubject)", async () => {
    mockAssessmentWithRealIdentity();
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountRecovery.admin.previewApproval({ requestId: 1, targetUserId: 20 });

    expect(JSON.stringify(result)).not.toMatch(new RegExp(SECRET_GOOGLE_SUB));
  });

  it("the response never contains the full linked email address", async () => {
    mockAssessmentWithRealIdentity();
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountRecovery.admin.previewApproval({ requestId: 1, targetUserId: 20 });

    expect(JSON.stringify(result)).not.toMatch(new RegExp(SECRET_FULL_EMAIL.replace(/[.]/g, "\\.")));
  });

  it("the response has no 'providerSubject', 'emailAtLink', 'sourceGoogleIdentity', 'token', 'cookie', or 'authorization' key anywhere - only the allowlisted DTO shape", async () => {
    mockAssessmentWithRealIdentity();
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountRecovery.admin.previewApproval({ requestId: 1, targetUserId: 20 });
    const raw = JSON.stringify(result).toLowerCase();

    expect(raw).not.toMatch(/providersubject/);
    expect(raw).not.toMatch(/emailatlink/);
    expect(raw).not.toMatch(/sourcegoogleidentity/);
    expect(raw).not.toMatch(/token/);
    expect(raw).not.toMatch(/cookie/);
    expect(raw).not.toMatch(/authorization/);
    expect(Object.keys(result).sort()).toEqual(
      [
        "blockReasons",
        "canApprove",
        "economicDataFindings",
        "isFullyAutomatable",
        "requestId",
        "sourceExists",
        "sourceHasGoogleIdentity",
        "sourceIsAdmin",
        "sourceUserId",
        "targetExists",
        "targetHasGoogleIdentity",
        "targetIsAdmin",
        "targetUserId",
        "userOwnedDataFindings",
        "warnings",
      ].sort()
    );
  });

  it("sourceHasGoogleIdentity is still correctly derived as a boolean (true) even though the identity object itself is stripped", async () => {
    mockAssessmentWithRealIdentity();
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountRecovery.admin.previewApproval({ requestId: 1, targetUserId: 20 });

    expect(result.sourceHasGoogleIdentity).toBe(true);
  });

  it("non-admin -> FORBIDDEN before the service is ever invoked", async () => {
    const assessSpy = vi.spyOn(accountRecoveryService, "assessAccountRecoverySafety");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));

    await expect(
      caller.accountRecovery.admin.previewApproval({ requestId: 1, targetUserId: 20 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(assessSpy).not.toHaveBeenCalled();
  });
});

describe("accountRecovery.admin.detail - privacy: no Google sub or full email in the response either", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requester field only ever contains the masked shape (maskUserForAdmin) - never a raw authIdentities row, never a full email", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue({
      id: 1,
      requesterUserId: 10,
      status: "pending",
      requestedLegacyUserId: null,
      claimedLegacyEmail: null,
      claimedLegacyOpenId: null,
      claimedDisplayName: null,
      evidenceNote: null,
      referenceOrderNumber: null,
    } as any);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({
      id: 900,
      userId: 10,
      provider: "google",
      providerSubject: "sub-should-never-leak",
      emailAtLink: "requester-full-email@example.com",
    } as any);
    vi.spyOn(db, "findAccountRecoveryEconomicData").mockResolvedValue([]);
    vi.spyOn(db, "findAccountRecoveryUserOwnedData").mockResolvedValue([]);
    vi.spyOn(db, "getUserById").mockResolvedValue({
      id: 10,
      openId: "requester-open-id",
      name: "Requester",
      email: "requester-full-email@example.com",
      loginMethod: "google",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any);

    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));
    const result = await caller.accountRecovery.admin.detail({ requestId: 1 });

    const raw = JSON.stringify(result);
    expect(raw).not.toMatch(/sub-should-never-leak/);
    expect(raw).not.toMatch(/requester-full-email@example\.com/);
  });
});
