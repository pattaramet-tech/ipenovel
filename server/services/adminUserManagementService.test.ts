import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { ENV } from "../_core/env";
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

/** A stable placeholder openId shared by every mocked row that doesn't
 *  care about owner-protection - deliberately never equal to any
 *  OWNER_OPEN_ID value a test sets, so existing tests are unaffected by
 *  db.lockUserRowForUpdate's real return shape now including openId. */
const NON_OWNER_OPEN_ID = "test-non-owner-openid";

function fakeUserRow(
  overrides: Partial<{ id: number; role: "user" | "admin"; name: string | null; openId: string }> = {}
) {
  return { id: 1, role: "user" as const, name: "Somchai", openId: NON_OWNER_OPEN_ID, ...overrides };
}

/** A currently-valid admin actor - the default row for id 9, the
 *  actorAdminId every test below uses unless it's deliberately testing
 *  self-edit (actorAdminId === userId) or actor revalidation itself. */
const VALID_ACTOR_ROW = { id: 9, name: "Admin Nine", role: "admin" as const, openId: NON_OWNER_OPEN_ID };

/** Mocks db.lockUserRowForUpdate to answer by id from `rows`, defaulting
 *  id 9 to VALID_ACTOR_ROW unless explicitly overridden (including to
 *  `undefined`, for the "actor row no longer exists" case). `openId` is
 *  optional on each row here (defaulting to NON_OWNER_OPEN_ID) purely so
 *  every pre-existing call site that predates the owner-protection column
 *  keeps compiling and behaving identically - only tests that explicitly
 *  care about owner-protection need to pass a real `openId`. Returns the
 *  spy so callers can assert call order/arguments (lock ordering, same-tx
 *  proof, duplicate-lock avoidance). */
function mockUserLocks(
  rows: Record<
    number,
    { id: number; name: string | null; role: "user" | "admin"; openId?: string } | undefined
  >
) {
  const merged: Record<
    number,
    { id: number; name: string | null; role: "user" | "admin"; openId?: string } | undefined
  > = {
    9: VALID_ACTOR_ROW,
    ...rows,
  };
  return vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
    const row = merged[id];
    if (!row) return undefined;
    return { ...row, openId: row.openId ?? NON_OWNER_OPEN_ID };
  });
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
    // Under the fixed lock hierarchy (see updateAdminUserProfile's own
    // "LOCK HIERARCHY" docstring), ANY request that supplies `role` locks
    // the admin-set FIRST, before per-user locks or the self-demotion
    // check even run - so this IS called exactly once here, even though
    // the request is ultimately rejected as a self role-change. It must
    // never be called a SECOND time.
    const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 9 }, { id: 10 }]);

    await expect(
      updateAdminUserProfile({
        actorAdminId: 9,
        userId: 9,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 9",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(lockAdminsSpy).toHaveBeenCalledTimes(1);
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

    it("[follow-up finding] actor role=\"user\" (demoted) AND target does not exist -> FORBIDDEN, never NOT_FOUND - actor is checked first, so a demoted caller learns nothing about whether the target id exists", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        1: undefined, // target does not exist
        9: { id: 9, name: "Admin Nine", role: "user" }, // actor demoted
      });
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("[follow-up finding] actor row does not exist AND target does not exist -> FORBIDDEN, never NOT_FOUND", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        1: undefined, // target does not exist
        9: undefined, // actor does not exist
      });
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("[follow-up finding] actor is still a valid admin BUT the target does not exist -> NOT_FOUND (the actor-first ordering only changes outcomes when the actor itself is invalid)", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 1: undefined }); // target does not exist; actor(9) defaults to VALID_ACTOR_ROW
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("[follow-up finding, self-edit] actorAdminId === userId and that row does not exist -> FORBIDDEN (treated as an invalid actor, never NOT_FOUND)", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockSpy = mockUserLocks({ 9: undefined });
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

      await expect(
        updateAdminUserProfile({ actorAdminId: 9, userId: 9, name: "New Name", reason: "valid reason" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      // Self-edit still locks exactly one row (id 9), even on the not-found path.
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(lockSpy).toHaveBeenCalledWith(9, expect.anything());
      expect(updateSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
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
        id === 2 ? fakeUserRow({ id: 2, name: "Admin Two", role: "admin" }) : fakeUserRow({ id: 9, name: "Old" })
      );
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);
      await updateAdminUserProfile({ actorAdminId: 2, userId: 9, name: "New", reason: "valid reason" });
      expect(lockSpyB.mock.calls.map((c) => c[0])).toEqual([2, 9]);
    });
  });

  // ---- Review finding "Use one lock hierarchy for admin demotions"
  // (PRRT_kwDOTeQWFc6a59CE): the admin-set lock must be the FIRST lock any
  // role-changing request acquires - not just a confirmed demotion -
  // otherwise two concurrent demotions of disjoint admin pairs can each
  // already hold their own actor/target row locks before reaching the
  // all-admin lock and deadlock waiting on each other. ----
  describe("lock hierarchy", () => {
    it("[demotion] acquires the admin-set lock BEFORE either per-user lock", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 2 }, { id: 9 }];
      });
      vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return id === 2 ? fakeUserRow({ id: 2, role: "admin" }) : VALID_ACTOR_ROW;
      });
      // Reached by the audit-log step regardless of promotion/demotion
      // (records googleConnected in safeMetadata) - see Step 8's own
      // db.getAuthIdentityByUserAndProvider call.
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      });

      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:2", "lockUserRowForUpdate:9"]);
    });

    it("[promotion] uses the SAME hierarchy - the admin-set lock is acquired first even though promotion never needs the admin count", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 9 }];
      });
      vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return id === 2 ? fakeUserRow({ id: 2, role: "user" }) : VALID_ACTOR_ROW;
      });
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue({ id: 1, provider: "google" } as any);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "admin",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      });

      expect(result.role).toBe("admin");
      expect(lockAdminsSpy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:2", "lockUserRowForUpdate:9"]);
    });

    it("the admin-set lock and the per-user locks are acquired via the SAME transaction executor", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      const lockUserSpy = mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin" }) });
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      });

      const adminLockTx = lockAdminsSpy.mock.calls[0][0];
      const userLockTxs = lockUserSpy.mock.calls.map((call) => call[1]);
      expect(userLockTxs.every((tx) => tx === adminLockTx)).toBe(true);
    });

    it("the admin-set lock is acquired exactly ONCE per role-change request - the last-admin check reuses that same snapshot, never re-locking", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }]); // only one admin
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin" }) });
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

      expect(lockAdminsSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).not.toHaveBeenCalled();
    });

  });

  // ---- PR #45 follow-up P2 finding "Include name-only edits in the lock
  // hierarchy" (PRRT_kwDOTeQWFc6a9DtH): a name-only edit must now join the
  // SAME fixed hierarchy (admin-set lock, then per-user locks) as a
  // role-changing request, never skip the admin-set lock. Supersedes the
  // OLD assertion (removed) that a name-only update never called
  // db.lockAdminRoleRows at all - that was exactly the un-unified
  // behavior the deadlock finding says to fix. ----
  describe("unified lock hierarchy (name-only edits)", () => {
    it("a NAME-ONLY update now DOES acquire the admin-set lock - exactly once, before any per-user lock", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 9 }];
      });
      vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return id === 1 ? fakeUserRow({ id: 1, name: "Old" }) : VALID_ACTOR_ROW;
      });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      await updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New", reason: "valid reason" });

      expect(lockAdminsSpy).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:1", "lockUserRowForUpdate:9"]);
    });

    it("[target id LOWER than actor id] name-only edit still acquires the admin-set lock before either per-user lock", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 9 }];
      });
      vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return id === 2 ? fakeUserRow({ id: 2, name: "Old" }) : VALID_ACTOR_ROW;
      });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      // target(2) < actor(9)
      await updateAdminUserProfile({ actorAdminId: 9, userId: 2, name: "New", reason: "valid reason" });

      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:2", "lockUserRowForUpdate:9"]);
    });

    it("[target id HIGHER than actor id] name-only edit still acquires the admin-set lock before either per-user lock", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 2 }];
      });
      vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return id === 20 ? fakeUserRow({ id: 20, name: "Old" }) : fakeUserRow({ id: 2, role: "admin" });
      });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      // target(20) > actor(2)
      await updateAdminUserProfile({ actorAdminId: 2, userId: 20, name: "New", reason: "valid reason" });

      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:2", "lockUserRowForUpdate:20"]);
    });

    it("[name-only self-edit] admin-set lock is acquired first, and the per-user row is locked exactly ONCE (never twice)", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const callOrder: string[] = [];
      vi.spyOn(db, "lockAdminRoleRows").mockImplementation(async () => {
        callOrder.push("lockAdminRoleRows");
        return [{ id: 9 }];
      });
      const lockUserSpy = vi.spyOn(db, "lockUserRowForUpdate").mockImplementation(async (id: number) => {
        callOrder.push(`lockUserRowForUpdate:${id}`);
        return { id: 9, name: "Old Admin Name", role: "admin" as const, openId: NON_OWNER_OPEN_ID };
      });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 9,
        name: "New Admin Name",
        reason: "valid reason",
      });

      expect(result.name).toBe("New Admin Name");
      expect(callOrder).toEqual(["lockAdminRoleRows", "lockUserRowForUpdate:9"]);
      expect(lockUserSpy).toHaveBeenCalledTimes(1);
    });

    it("admin-set lock and per-user locks share the SAME transaction executor for a name-only edit too", async () => {
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockAdminsSpy = vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 9 }]);
      const lockUserSpy = mockUserLocks({ 1: fakeUserRow({ id: 1, name: "Old" }) });
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      await updateAdminUserProfile({ actorAdminId: 9, userId: 1, name: "New", reason: "valid reason" });

      const adminLockTx = lockAdminsSpy.mock.calls[0][0];
      const userLockTxs = lockUserSpy.mock.calls.map((call) => call[1]);
      expect(userLockTxs.every((tx) => tx === adminLockTx)).toBe(true);
    });
  });

  // ---- PR #45 P1 finding "Reject demotion of the configured owner"
  // (PRRT_kwDOTeQWFc6a9DtE) ----
  describe("owner protection", () => {
    const originalOwnerOpenId = ENV.ownerOpenId;
    const OWNER_OPEN_ID = "configured-owner-openid-test";

    afterEach(() => {
      // Same save/restore-in-afterEach pattern as server/_core/env.test.ts's
      // own ENV mutation tests - process.env.OWNER_OPEN_ID itself is never
      // touched (ENV.ownerOpenId is a plain, mutable module-level property
      // computed once at import time, not re-read from process.env), so
      // restoring THIS property is what actually matters between tests.
      ENV.ownerOpenId = originalOwnerOpenId;
    });

    it("another admin attempting to demote the configured owner -> FORBIDDEN", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: OWNER_OPEN_ID }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);

      await expect(
        updateAdminUserProfile({
          actorAdminId: 9,
          userId: 2,
          role: "user",
          reason: "valid reason",
          confirmText: "CHANGE ROLE 2",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("when rejected, updateAdminUserFields and insertAdminUserAuditLog are NEVER called", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: OWNER_OPEN_ID }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      const updateSpy = vi.spyOn(db, "updateAdminUserFields");
      const auditSpy = vi.spyOn(db, "insertAdminUserAuditLog");

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
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it("the owner check uses target.openId from the SAME locked row read Step 2 already performed - never a second query", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      const lockUserSpy = mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: OWNER_OPEN_ID }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      const getUserByOpenIdSpy = vi.spyOn(db, "getUserByOpenId");

      await expect(
        updateAdminUserProfile({
          actorAdminId: 9,
          userId: 2,
          role: "user",
          reason: "valid reason",
          confirmText: "CHANGE ROLE 2",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      expect(lockUserSpy).toHaveBeenCalledWith(2, expect.anything());
      expect(getUserByOpenIdSpy).not.toHaveBeenCalled();
    });

    it("the owner's NAME-ONLY edit still succeeds - only a role change is blocked", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        2: fakeUserRow({ id: 2, role: "admin", name: "Old Owner Name", openId: OWNER_OPEN_ID }),
      });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        name: "New Owner Name",
        reason: "valid reason",
      });

      expect(result.name).toBe("New Owner Name");
    });

    it("demoting a NON-owner admin still works normally, even with OWNER_OPEN_ID configured", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: "some-other-admin-openid" }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      });

      expect(result.role).toBe("user");
    });

    it("OWNER_OPEN_ID not configured (empty string) -> no owner-specific rejection ever triggers, even against an empty-string target openId", async () => {
      ENV.ownerOpenId = "";
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      // Defensive/edge case only - a real row's openId is NOT NULL and can
      // never actually be "" - proves the check is `ownerOpenId &&`
      // guarded, not just a bare equality that "" === "" would pass.
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: "" }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);
      vi.spyOn(db, "getAuthIdentityByUserAndProvider").mockResolvedValue(undefined);
      vi.spyOn(db, "updateAdminUserFields").mockResolvedValue(true);
      vi.spyOn(db, "insertAdminUserAuditLog").mockResolvedValue(undefined);

      const result = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      });

      expect(result.role).toBe("user");
    });

    it("[actor authorization still precedes any target/owner check] a stale/demoted actor gets FORBIDDEN even when the target IS the configured owner", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({
        2: fakeUserRow({ id: 2, role: "admin", openId: OWNER_OPEN_ID }),
        9: { id: 9, name: "Admin Nine", role: "user" }, // actor demoted
      });
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

    it("no `openId` or `OWNER_OPEN_ID`-shaped value appears anywhere in the thrown error", async () => {
      ENV.ownerOpenId = OWNER_OPEN_ID;
      vi.spyOn(db, "assertDatabaseAvailable").mockResolvedValue(undefined);
      vi.spyOn(db, "getDb").mockResolvedValue(fakeDatabase() as any);
      mockUserLocks({ 2: fakeUserRow({ id: 2, role: "admin", openId: OWNER_OPEN_ID }) });
      vi.spyOn(db, "lockAdminRoleRows").mockResolvedValue([{ id: 2 }, { id: 9 }]);

      const error = await updateAdminUserProfile({
        actorAdminId: 9,
        userId: 2,
        role: "user",
        reason: "valid reason",
        confirmText: "CHANGE ROLE 2",
      }).catch((e) => e);

      expect(error).toBeInstanceOf(AdminUserManagementError);
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(OWNER_OPEN_ID);
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
