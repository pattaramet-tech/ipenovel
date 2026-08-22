import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "./db";
import * as adminUserManagementService from "./services/adminUserManagementService";
import { AdminUserManagementError } from "./services/adminUserManagementService";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Router-level tests for admin.users.* - authorization boundaries and
// input wiring that routers.ts itself is responsible for. Business-rule
// correctness (role-safety, delete-safety, transactions) is covered in
// server/services/adminUserManagementService.test.ts - these tests mock
// the service/db layer entirely, same split as accountRecoveryRouter.test.ts.

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof db>("./db");
  return { ...actual };
});

vi.mock("./services/adminUserManagementService", async () => {
  const actual = await vi.importActual<typeof adminUserManagementService>("./services/adminUserManagementService");
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

const VALID_LIST_INPUT = { page: 1, pageSize: 20 as const };

describe("admin.users.list - authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("anonymous caller -> UNAUTHORIZED, the database is never queried", async () => {
    const listSpy = vi.spyOn(db, "getAdminUsersList");
    const caller = appRouter.createCaller(contextFor(null));
    await expect(caller.admin.users.list(VALID_LIST_INPUT)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("regular (role: user) caller -> FORBIDDEN, the database is never queried", async () => {
    const listSpy = vi.spyOn(db, "getAdminUsersList");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(caller.admin.users.list(VALID_LIST_INPUT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("admin caller -> reaches db.getAdminUsersList with the validated input", async () => {
    const listSpy = vi.spyOn(db, "getAdminUsersList").mockResolvedValue({
      users: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await caller.admin.users.list({ page: 2, pageSize: 50, search: "test", role: "user" });

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 50, search: "test", role: "user" })
    );
  });

  it("the response for a row containing openId/passwordHash-shaped data never leaks those fields (db layer's own allowlist, proven end to end through the router)", async () => {
    vi.spyOn(db, "getAdminUsersList").mockResolvedValue({
      users: [
        {
          id: 1,
          name: "Somchai",
          email: "somchai@example.com",
          loginMethod: "google",
          role: "user",
          googleConnected: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSignedIn: new Date(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    const result = await caller.admin.users.list(VALID_LIST_INPUT);
    const raw = JSON.stringify(result).toLowerCase();

    expect(raw).not.toMatch(/openid/);
    expect(raw).not.toMatch(/passwordhash/);
    expect(raw).not.toMatch(/providersubject/);
    expect(raw).not.toMatch(/emailatlink/);
  });
});

describe("admin.users.update - authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("anonymous caller -> UNAUTHORIZED, the service is never invoked", async () => {
    const updateSpy = vi.spyOn(adminUserManagementService, "updateAdminUserProfile");
    const caller = appRouter.createCaller(contextFor(null));
    await expect(
      caller.admin.users.update({ userId: 2, name: "New Name", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("regular (role: user) caller -> FORBIDDEN, the service is never invoked", async () => {
    const updateSpy = vi.spyOn(adminUserManagementService, "updateAdminUserProfile");
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "user" })));
    await expect(
      caller.admin.users.update({ userId: 2, name: "New Name", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("admin caller -> reaches the service with the CALLER's own id as actorAdminId, never client-suppliable", async () => {
    const updateSpy = vi
      .spyOn(adminUserManagementService, "updateAdminUserProfile")
      .mockResolvedValue({ id: 2, name: "New Name", role: "user" });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 5, role: "admin" })));

    await caller.admin.users.update({ userId: 2, name: "New Name", reason: "valid reason" });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminId: 5, userId: 2, name: "New Name" })
    );
  });

  it("an empty/whitespace-only name is normalized to null before reaching the service", async () => {
    const updateSpy = vi
      .spyOn(adminUserManagementService, "updateAdminUserProfile")
      .mockResolvedValue({ id: 2, name: null, role: "user" });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 5, role: "admin" })));

    await caller.admin.users.update({ userId: 2, name: "   ", reason: "valid reason" });

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ name: null }));
  });

  it("a field NOT supplied at all is forwarded as undefined (leave untouched), never coerced to null", async () => {
    const updateSpy = vi
      .spyOn(adminUserManagementService, "updateAdminUserProfile")
      .mockResolvedValue({ id: 2, name: "Existing", role: "user" });
    const caller = appRouter.createCaller(contextFor(fakeUser({ id: 5, role: "admin" })));

    await caller.admin.users.update({ userId: 2, reason: "valid reason" });

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ name: undefined }));
  });

  it("a service-thrown AdminUserManagementError maps to the matching TRPCError code", async () => {
    vi.spyOn(adminUserManagementService, "updateAdminUserProfile").mockRejectedValue(
      new AdminUserManagementError("FORBIDDEN", "Cannot demote the last remaining admin")
    );
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await expect(
      caller.admin.users.update({ userId: 2, role: "user", reason: "valid reason", confirmText: "CHANGE ROLE 2" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("there is no `email` field on this input schema at all - TypeScript itself rejects an attempt to send one", async () => {
    vi.spyOn(adminUserManagementService, "updateAdminUserProfile").mockResolvedValue({
      id: 2,
      name: "Existing",
      role: "user",
    });
    const caller = appRouter.createCaller(contextFor(fakeUser({ role: "admin" })));

    await caller.admin.users.update({
      userId: 2,
      name: "New Name",
      reason: "valid reason",
      // @ts-expect-error - email is not part of this input's schema; zod
      // strips it silently, so the only proof it can never reach the
      // service is this compile-time rejection.
      email: "new@example.com",
    });
  });
});

describe("admin.users.delete / admin.users.deleteAssessment - deliberately NOT exposed in this PR", () => {
  afterEach(() => vi.restoreAllMocks());

  // PR #45 security review finding: hard-delete's transaction only locks
  // the target `users` row, but every business table it checks (orders,
  // carts, wallet, points, ...) uses a plain, unenforced `userId` int with
  // no foreign key back to `users.id` - so a concurrent INSERT into any of
  // those tables can race past the assessment and land after the delete
  // commits, leaving an orphaned row behind. Until that gap is closed
  // (either DB-enforced constraints proven safe with a real MariaDB
  // concurrency test, or an equivalent application-level guarantee), the
  // mutation and its read-only preview are withheld entirely - see
  // server/routers.ts's admin.users router for the full rationale. This
  // test proves that withdrawal, not just documents it: neither procedure
  // exists on the router at all.
  it("admin.users.delete does not exist as a callable procedure", () => {
    expect((appRouter.admin.users as any).delete).toBeUndefined();
  });

  it("admin.users.deleteAssessment does not exist as a callable procedure", () => {
    expect((appRouter.admin.users as any).deleteAssessment).toBeUndefined();
  });
});
