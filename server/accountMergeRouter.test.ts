import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import * as db from "./db";
import * as accountMergePreviewService from "./services/accountMergePreviewService";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * Router-level tests for accountMerge.admin.preview - authorization and
 * request-origin boundaries the SERVICE layer cannot enforce on its own
 * (it has no notion of "which recovery request", only whatever
 * sourceUserId/targetUserId it is handed). Business-rule correctness
 * (target validation, table inventory, projections) is covered in
 * server/services/accountMergePreviewService.test.ts - these tests mock
 * the service layer entirely and focus on what routers.ts itself is
 * responsible for. Same pattern as server/accountRecoveryRouter.test.ts.
 */

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

vi.mock("./services/accountMergePreviewService", async () => {
  const actual = await vi.importActual<typeof accountMergePreviewService>("./services/accountMergePreviewService");
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

function fakeRequest(overrides: Partial<{ id: number; requesterUserId: number; status: string }> = {}) {
  return {
    id: 1,
    requesterUserId: 42,
    status: "blocked",
    requestedLegacyUserId: null,
    claimedLegacyEmail: null,
    claimedLegacyOpenId: null,
    claimedDisplayName: null,
    evidenceNote: null,
    referenceOrderNumber: null,
    reviewedByAdminId: null,
    reviewedAt: null,
    reviewReason: null,
    sourceUserId: null,
    targetUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("accountMerge.admin.preview", () => {
  afterEach(() => vi.restoreAllMocks());

  it("non-admin caller -> FORBIDDEN, the service is never invoked", async () => {
    const buildSpy = vi.spyOn(accountMergePreviewService, "buildAccountMergePreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));

    await expect(caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 99 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("unauthenticated caller -> UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 99 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("A. requestId names a request that does not exist -> NOT_FOUND, service never invoked", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(undefined);
    const buildSpy = vi.spyOn(accountMergePreviewService, "buildAccountMergePreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await expect(caller.accountMerge.admin.preview({ requestId: 999, targetUserId: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("A. a PENDING request (not yet blocked) -> BAD_REQUEST, service never invoked - preview can only originate from a BLOCKED request", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "pending" }) as any);
    const buildSpy = vi.spyOn(accountMergePreviewService, "buildAccountMergePreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const error = await caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5 }).catch((e) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "BAD_REQUEST" });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("A. an APPROVED request -> BAD_REQUEST, service never invoked", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "approved" }) as any);
    const buildSpy = vi.spyOn(accountMergePreviewService, "buildAccountMergePreview");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await expect(caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("A. a REJECTED request -> BAD_REQUEST, service never invoked", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "rejected" }) as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await expect(caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("A. a CANCELLED request -> BAD_REQUEST, service never invoked", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "cancelled" }) as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await expect(caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("A. a BLOCKED request -> reaches the service, sourceUserId is ALWAYS the request's own requesterUserId, never anything from the client input", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(
      fakeRequest({ id: 7, requesterUserId: 42, status: "blocked" }) as any
    );
    const buildSpy = vi
      .spyOn(accountMergePreviewService, "buildAccountMergePreview")
      .mockResolvedValue({ requestId: 7, sourceUserId: 42, targetUserId: 5 } as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await caller.accountMerge.admin.preview({ requestId: 7, targetUserId: 5 });

    expect(buildSpy).toHaveBeenCalledWith({ requestId: 7, sourceUserId: 42, targetUserId: 5 });
  });

  it("A. the input schema has NO sourceUserId field at all - a client cannot even attempt to supply one", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "blocked" }) as any);
    vi.spyOn(accountMergePreviewService, "buildAccountMergePreview").mockResolvedValue({} as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    // Extra/unknown fields on a zod object schema are stripped, not
    // rejected, by default - so this proves the field is simply never
    // read, not merely that the call succeeds.
    const buildSpy = vi.mocked(accountMergePreviewService.buildAccountMergePreview);
    await caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5, sourceUserId: 999 } as any);

    expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceUserId: fakeRequest().requesterUserId }));
    expect(buildSpy).not.toHaveBeenCalledWith(expect.objectContaining({ sourceUserId: 999 }));
  });

  it("returns exactly what the service produced, unmodified", async () => {
    vi.spyOn(db, "getAccountRecoveryRequestById").mockResolvedValue(fakeRequest({ status: "blocked" }) as any);
    const fakePreview = { requestId: 1, sourceUserId: 42, targetUserId: 5, isPreviewValid: true, hardBlockers: [] };
    vi.spyOn(accountMergePreviewService, "buildAccountMergePreview").mockResolvedValue(fakePreview as any);
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.accountMerge.admin.preview({ requestId: 1, targetUserId: 5 });
    expect(result).toEqual(fakePreview);
  });
});
