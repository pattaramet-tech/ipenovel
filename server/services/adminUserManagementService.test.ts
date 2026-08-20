import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import {
  AdminUserManagementError,
  deleteAdminUserSafely,
  updateAdminUserProfile,
} from "./adminUserManagementService";

vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof db>("../db");
  return { ...actual };
});

/** The service issues NO raw tx.execute calls itself anymore for
 *  updateAdminUserProfile - actor/target row locking goes exclusively
 *  through db.lockUserRowForUpdate (mocked below via mockUserLocks), and
 *  every other write (lockAdminRoleRows, updateAdminUserFields,
 *  getAuthIdentityByUserAndProvider, insertAdminUserAuditLog) is a
 *  separate db.ts export mocked directly - same split as
 *  accountRecoveryService.test.ts's own fakeDatabase helper.
 *  deleteAdminUserSafely (below) still issues its own raw tx.execute for
 *  its target lock, so its own fakeDatabase(targetRow) is unaffected. */
function fakeDatabase(targetRow?: any) {
  const tx = { execute: async () => [[targetRow]] };
  return { transaction: async (cb: (tx: any) => Promise<any>) => cb(tx) };
}

function fakeUserRow(overrides: Partial<{ id: number; role: "user" | "admin"; name: string | null }> = {}) {
  return { id: 1, role: "user" as const, name: "Somchai", ...overrides };
}

/** A currently-valid admin actor - the default row for id 9, the
 *  actorAdminId every test below uses unless it's deliberately testing
 *  self-edit (actorAdminId === userId) or actor revalidation itself. */
const VALID_ACTOR_ROW = { id: 9, name: "Admin Nine", role: "admin" as const };

/** Mocks db.lockUserRowForUpdate to answer by id from `rows`, defaulting
 *  id 9 to VALID_ACTOR_ROW unless explicitly overridden (including to
 *  `undefined`, for the "actor row no longer exists" case). Returns the
 *  spy so callers can assert call order/arguments (lock ordering, same-tx
 *  proof, duplicate-lock avoidance). */
function mockUserLocks(
  rows: Record<number, { id: number; name: string | null; role: "user" | "admin" } | undefined>
) {
  const merged: Record<number, { id: number; name: string | null; role: "user" | "admin" } | undefined> = {
    9: VALID_ACTOR_ROW,
    ...rows,
  };
  return vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => merged[id]);
}

describe("updateAdminUserProfile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reason shorter than 5 chars -> BAD_REQUEST, database never touched", async () => {
    const dbSpy = vi.spyOn(db, "getDb");
    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "hi" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("target user not found -> NOT_FOUND", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: undefined });

    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("no field actually changes (name equals current value, no role field) -> BAD_REQUEST, update is never applied", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: fakeUserRow({ name: "Somchai" }) });
    const updateSpy = vi.spyOn(db, "updateAdminUserFields");

    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "Somchai", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("name-only change -> applies the update and writes exactly one update_name audit log, no role audit log", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: fakeUserRow({ name: "Old Name" }) });
    const updateSpy = vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

    const result = await updateAdminUserProfile({
      actorAdminId: 9,
      userId: 1,
      name: "New Name",
      reason: "renamed at user's request",
    });

    expect(result).toEqual({ id: 1, name: "New Name", role: "user" });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, expectedRole: "user", name: "New Name", role: undefined }),
      expect.anything()
    );
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminId: 9, targetUserId: 1, action: "update_name" }),
      expect.anything()
    );
  });

  it("role change with no confirmText -> BAD_REQUEST, update never applied", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "user" }) });
    const updateSpy = vi.spyOn(db, "updateAdminUserFields");

    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 2, role: "admin", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("role change with WRONG confirmText -> BAD_REQUEST", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "user" }) });

    await expect(
      updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "admin",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 999",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("admin cannot demote/change their OWN role, even with correct confirmText", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 9: { id: 9, role: "admin", name: "Admin Nine" } });
    const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows");

    await expect(
      updateAdminUserProfile({
        actorAdminId: 9,
        userId: 9,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 9",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(lockAdminsSpy).not.toHaveBeenCalled();
  });

  it("cannot demote the LAST remaining admin", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin" }) });
    vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }]);
    const updateSpy = vi.spyOn(db, "updateAdminUserFields");

    await expect(
      updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("demoting an admin when other admins still exist -> succeeds", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin" }) });
    vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
    vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

    const result = await updateAdminUserProfile({
      actorAdminId: 9,
      userId: 2,
      role: "user",
      reason: "valid reason",
      confirmText: "CHANGE ROLE 2",
    });

    expect(result.role).toBe("user");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update_role" }),
      expect.anything()
    );
  });

  it("promoting a user with NO linked Google identity to admin -> FORBIDDEN, never applies the update", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "user" }) });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    const updateSpy = vi.spyOn(db, "updateAdminUserFields");

    await expect(
      updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "admin",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("promoting a user WITH a linked Google identity -> succeeds", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 2: fakeUserRow({ id: 2, role: "user" }) });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({ id: 1, provider: "google" } as any);
    vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

    const result = await updateAdminUserProfile({
      actorAdminId: 9,
      userId: 2,
      role: "admin",
      reason: "valid reason",
      confirmText: "CHANGE ROLE 2",
    });

    expect(result.role).toBe("admin");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ safeMetadata: expect.objectContaining({ googleConnected: true }) }),
      expect.anything()
    );
  });

  it("[concurrent change] updateAdminUserFields loses its conditional UPDATE (returns false) -> CONFLICT, no audit log written", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: fakeUserRow({ name: "Old" }) });
    vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(false);
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New", reason: "valid reason" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("[rollback] audit log write throws -> the whole call rejects (the transaction rolls back the already-applied update together with it)", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: fakeUserRow({ name: "Old" }) });
    vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
    vi.spyOn(db, "insertAdminUserAuditLog").mockRejectedValue(new Error("db write failed"));

    await expect(
      updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New", reason: "valid reason" })
    ).rejects.toThrow("db write failed");
  });

  it("email/openId/loginMethod/passwordHash/createdAt/lastSignedIn have no corresponding parameter at all - TypeScript itself rejects them", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
    mockUserLocks({ 1: fakeUserRow({ name: "Old" }) });
    vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
    vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

    await updateAdminUserProfile({
      actorAdminId: 9,
      userId: 1,
      name: "New",
      reason: "valid reason",
      // @ts-expect-error - email is not part of this function's parameter type at all.
      email: "hacked@example.com",
    });
  });

  // ---- PR #45 P1 finding: actor revalidation inside the transaction ----
  describe("actor revalidation", () => {
    it("[stale session] the actor was demoted to role=\"user\" before this transaction runs -> FORBIDDEN, never NOT_FOUND", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        1: fakeUserRow({ id: 1, name: "Somchai" }),
        9: { id: 9, name: "Admin Nine", role: "user" }, // demoted by another admin
      });

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("[deleted session] the actor row no longer exists at all -> FORBIDDEN", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        1: fakeUserRow({ id: 1, name: "Somchai" }),
        9: undefined,
      });

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("when actor revalidation fails, updateAdminUserFields and insertAdminUserAuditLog are NEVER called", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        1: fakeUserRow({ id: 1, name: "Somchai" }),
        9: { id: 9, name: "Admin Nine", role: "user" },
      });
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("actor still role=\"admin\" -> name update on a different target succeeds", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 1: fakeUserRow({ id: 1, name: "Old Name" }) });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 1,
        name: "New Name",
        reason: "valid reason",
      });

      expect(result.name).toBe("New Name");
    });

    it("[self-edit] actorAdminId === userId editing only their own name -> succeeds, and locks exactly ONE row (never twice)", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockSpy = mockUserLocks({ 9: { id: 9, name: "Old Admin Name", role: "admin" } });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 9,
        name: "New Admin Name",
        reason: "valid reason",
      });

      expect(result.name).toBe("New Admin Name");
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(lockSpy).toHaveBeenCalledWith(9, expect.anything());
    });

    it("locks the actor and target via the SAME transaction executor (proves revalidation happens inside the one locked transaction, not a separate read)", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockSpy = mockUserLocks({ 2: fakeUserRow({ id: 2, name: "Old" }) });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      await updateAdminUserProfile({ actorAdminId: 9, userId: 2, name: "New", reason: "valid reason" });

      expect(lockSpy).toHaveBeenCalledTimes(2);
      const [firstTx, secondTx] = lockSpy.mock.calls.map((call) => call[1]);
      expect(firstTx).toBe(secondTx);
    });

    it("[deterministic lock order] locks in ASCENDING id order regardless of which of actor/target has the smaller id", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);

      // Case A: actor(9) > target(2) - ascending order is [2, 9].
      const lockSpyA = mockUserLocks({ 2: fakeUserRow({ id: 2, name: "Old" }) });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
      await updateAdminUserProfile({ actorAdminId: 9, userId: 2, name: "New", reason: "valid reason" });
      expect(lockSpyA.mock.calls.map((c) => c[0])).toEqual([2, 9]);
      vi.restoreAllMocks();

      // Case B: actor(2) < target(9) - ascending order is STILL [2, 9],
      // i.e. never "actor first" as a fixed rule.
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockSpyB = vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) =>
        id === 2 ? { id: 2, name: "Admin Two", role: "admin" as const } : fakeUserRow({ id: 9, name: "Old" })
      );
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
      await updateAdminUserProfile({ actorAdminId: 2, userId: 9, name: "New", reason: "valid reason" });
      expect(lockSpyB.mock.calls.map((c) => c[0])).toEqual([2, 9]);
    });
  });
});

// NOTE (PR #45 security review): these tests prove deleteAdminUserSafely's
// BUSINESS rules (confirmation text, self/role checks, blocker handling,
// transactional rollback on a thrown error) with mocked db.ts functions -
// they do NOT prove, and must never be cited as proving, that this
// function is safe against a REAL concurrent write racing the assessment
// (see the function's own "NOT CONCURRENCY-SAFE YET" docstring). That gap
// can only be closed/proven with a real multi-connection database
// integration test, which does not exist yet - this function is
// deliberately not wired to any tRPC procedure in the meantime.
describe("deleteAdminUserSafely", () => {
  afterEach(() => vi.restoreAllMocks());

  it("confirmText that does not match 'DELETE USER <id>' -> BAD_REQUEST, database never touched", async () => {
    const dbSpy = vi.spyOn(db, "getDb");
    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 1, reason: "a valid ten char reason", confirmText: "delete user 1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("reason shorter than 10 chars -> BAD_REQUEST", async () => {
    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 1, reason: "short", confirmText: "DELETE USER 1" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("cannot delete your own account -> FORBIDDEN, before ever touching the database", async () => {
    const dbSpy = vi.spyOn(db, "getDb");
    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 9, reason: "a valid ten char reason", confirmText: "DELETE USER 9" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("target user not found -> NOT_FOUND", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(undefined) as any);

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 1, reason: "a valid ten char reason", confirmText: "DELETE USER 1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("target has role=admin -> FORBIDDEN, assessment never runs", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "admin" })) as any);
    const assessSpy = vi.spyOn(db, "getAdminUserDeleteAssessment");

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 2, reason: "a valid ten char reason", confirmText: "DELETE USER 2" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(assessSpy).not.toHaveBeenCalled();
  });

  it("[has orders] assessment reports a blocker -> CONFLICT, authIdentities/users are never deleted, no audit log written", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({
      userId: 2,
      canDelete: false,
      blockers: [{ table: "orders", reference: "Orders", count: 3, category: "economic" }],
    });
    const deleteIdentitiesSpy = vi.spyOn(db, "deleteAuthIdentitiesForUser");
    const deleteUserSpy = vi.spyOn(db, "deleteUsersRowChecked");
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 2, reason: "a valid ten char reason", confirmText: "DELETE USER 2" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deleteIdentitiesSpy).not.toHaveBeenCalled();
    expect(deleteUserSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("[rollback] audit log write throws -> the whole delete rejects, and authIdentities/users are never touched (the transaction rolls the failed audit write back too)", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({ userId: 2, canDelete: true, blockers: [] });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    vi.spyOn(db, "insertAdminUserAuditLog").mockRejectedValue(new Error("db write failed"));
    const deleteIdentitiesSpy = vi.spyOn(db, "deleteAuthIdentitiesForUser");
    const deleteUserSpy = vi.spyOn(db, "deleteUsersRowChecked");

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 2, reason: "a valid ten char reason", confirmText: "DELETE USER 2" })
    ).rejects.toThrow("db write failed");
    expect(deleteIdentitiesSpy).not.toHaveBeenCalled();
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("[genuinely empty account] no blockers -> deletes authIdentities then the users row, and writes exactly one delete_user audit log", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({ userId: 2, canDelete: true, blockers: [] });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({ id: 1, provider: "google" } as any);
    const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
    const deleteIdentitiesSpy = vi.spyOn(db, "deleteAuthIdentitiesForUser").mockResolvedValue(undefined);
    const deleteUserSpy = vi.spyOn(db, "deleteUsersRowChecked").mockResolvedValue(1);

    const result = await deleteAdminUserSafely({
      actorAdminId: 9,
      userId: 2,
      reason: "a valid ten char reason",
      confirmText: "DELETE USER 2",
    });

    expect(result).toEqual({ deleted: true });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actorAdminId: 9, targetUserId: 2, action: "delete_user" }),
      expect.anything()
    );
    expect(deleteIdentitiesSpy).toHaveBeenCalledWith(2, expect.anything());
    expect(deleteUserSpy).toHaveBeenCalledWith(2, expect.anything());
  });

  it("[rollback] deleteAuthIdentitiesForUser throws -> the whole delete rejects, and the users row is never deleted", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({ userId: 2, canDelete: true, blockers: [] });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
    vi.spyOn(db, "deleteAuthIdentitiesForUser").mockRejectedValue(new Error("db delete failed"));
    const deleteUserSpy = vi.spyOn(db, "deleteUsersRowChecked");

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 2, reason: "a valid ten char reason", confirmText: "DELETE USER 2" })
    ).rejects.toThrow("db delete failed");
    expect(deleteUserSpy).not.toHaveBeenCalled();
  });

  it("[unexpected zero-row delete] deleteUsersRowChecked reports 0 affected rows -> CONFLICT, even though the assessment was clean", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({ userId: 2, canDelete: true, blockers: [] });
    vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
    vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
    vi.spyOn(db, "deleteAuthIdentitiesForUser").mockResolvedValue(undefined);
    vi.spyOn(db, "deleteUsersRowChecked").mockResolvedValue(0);

    await expect(
      deleteAdminUserSafely({ actorAdminId: 9, userId: 2, reason: "a valid ten char reason", confirmText: "DELETE USER 2" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("there is no forceDelete/skipSafetyCheck/override parameter anywhere on this function's input type - TypeScript itself rejects one", async () => {
    vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
    vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase(fakeUserRow({ id: 2, role: "user" })) as any);
    vi.spyOn(db, "getAdminUserDeleteAssessment").mockResolvedValue({
      userId: 2,
      canDelete: false,
      blockers: [{ table: "orders", reference: "Orders", count: 1, category: "economic" }],
    });

    await expect(
      deleteAdminUserSafely({
        actorAdminId: 9,
        userId: 2,
        reason: "a valid ten char reason",
        confirmText: "DELETE USER 2",
        // @ts-expect-error - forceDelete is not part of this function's parameter type at all.
        forceDelete: true,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
