import { sql } from "drizzle-orm";
import * as db from "../db";
import { ENV } from "../_core/env";

/**
 * Central safety/execution logic for the Admin Users Management page - edit
 * (name/role) and hard-delete. Every rule the task spec enumerates is
 * enforced HERE, once, inside a single locked transaction per mutation -
 * never re-derived per call site, and never trusting anything the client
 * sent beyond the target user id and the free-text reason. Mirrors
 * server/services/accountRecoveryService.ts's own split: this file owns
 * orchestration/transactions/error-mapping, server/db.ts owns the
 * low-level query helpers (getAdminUserDeleteAssessment,
 * updateAdminUserFields, lockAdminRoleRows, ...).
 *
 * `ENV.ownerOpenId` (server/_core/env.ts) is consulted ONLY as a
 * server-side comparison key for the configured-owner demotion guard
 * below - it is never included in any return value, error message, log
 * line, or audit `safeMetadata`.
 */

export class AdminUserManagementError extends Error {
  code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT";

  constructor(code: AdminUserManagementError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "AdminUserManagementError";
  }
}

/** mysql2's raw `.execute()` resolves to a [rows, fields] tuple, not the
 *  bare rows array - same unwrap as accountRecoveryService.ts's
 *  unwrapRows/server/db.ts's lockCartForCheckout. */
function unwrapRows(rawResult: any): any[] {
  const rows = Array.isArray(rawResult?.[0]) ? rawResult[0] : rawResult;
  return rows || [];
}

export type UpdateAdminUserResult = {
  id: number;
  name: string | null;
  role: "user" | "admin";
};

/**
 * The single-transaction Edit flow:
 *  1. lock the WHOLE admin-role row set FIRST, UNCONDITIONALLY, for every
 *  mutation this function performs - see "LOCK HIERARCHY" below,
 *  2. lock the target (and, unless it's a self-edit, the ACTOR) user row,
 *  in ascending id order - see "Actor revalidation" below,
 *  3. verify the actor is still a real, currently-role="admin" account
 *  (checked BEFORE target existence - see "Actor revalidation" below for
 *  why the order matters), 4. verify the target row actually exists,
 *  5. compute which fields actually change (reject a true no-op),
 *  6. if role is changing, re-verify EVERY role-safety rule against the
 *  LOCKED target snapshot (never trust the assessment the admin UI showed
 *  moments earlier) - self-demotion, configured-owner protection (see
 *  "OWNER PROTECTION" below), last-admin (using the admin-set snapshot
 *  already locked in step 1, never re-locked), and
 *  Google-identity-required-to-promote, 7. apply the conditional UPDATE,
 *  8. write the audit log(s), 9. commit (implicit - any throw rolls back
 *  everything together).
 *
 * `name`/`role` are `undefined` when the caller does not intend to touch
 * that field at all (not merely "unchanged") - see server/routers.ts's
 * admin.users.update, which only forwards a field when the client actually
 * supplied it. `name` must already be trimmed/normalized-to-null by the
 * caller (email/openId/loginMethod/passwordHash/createdAt/lastSignedIn are
 * never accepted here at all - there is no parameter for them).
 *
 * LOCK HIERARCHY (PR #45 review findings "Use one lock hierarchy for admin
 * demotions" (PRRT_kwDOTeQWFc6a59CE) and its follow-up "Include name-only
 * edits in the lock hierarchy" (PRRT_kwDOTeQWFc6a9DtH)): an earlier
 * version of this function acquired the admin-set lock
 * (db.lockAdminRoleRows) ONLY for requests that supplied `role`, AFTER the
 * actor/target row locks (step 2 above) - and a still-earlier version
 * acquired it only for an actual admin->user demotion. Either way, some
 * request shapes (a name-only edit; with the earliest version, a
 * promotion or no-op role attempt too) locked their actor/target rows
 * WITHOUT ever taking the admin-set lock first. With 4+ admins, one such
 * request touching a lower-id admin could hold that row and wait on its
 * own admin-actor row, while a CONCURRENT role-changing request already
 * held the entire admin-set lock and was waiting on that very same
 * user row - a classic AB-BA deadlock InnoDB has to abort one side of,
 * with no retry anywhere in this codepath. Fixed by making the admin-set
 * lock the FIRST thing EVERY mutation this function performs acquires -
 * name-only edits included, not just requests that supply `role` - so
 * every possible request shape acquires it in the exact same position in
 * a single, fixed hierarchy: admin-set lock, THEN per-user locks, THEN
 * validation, THEN safety checks, THEN the write. Two transactions can
 * now only ever be serialized entirely behind one another (whichever
 * acquires the admin-set lock first proceeds through its own per-user
 * locks uncontested), never partially interleaved, regardless of whether
 * either request touches `role` at all. The resulting row set is
 * captured once and reused for the later last-admin check when role IS
 * changing (see step 6) - a name-only edit computes this same snapshot
 * but simply never consults it. db.lockAdminRoleRows is never called a
 * second time within one transaction, for any request shape.
 *
 * ACTOR REVALIDATION (PR #45 security review finding): `adminProcedure`
 * only proves ctx.user.role was "admin" at the moment the SESSION/request
 * was authenticated - that's a snapshot, not a live fact. Between then and
 * this transaction actually running, a second admin could have demoted
 * `actorAdminId` to role="user" (or deleted them outright). Without
 * re-checking, a request from an admin whose privilege was JUST revoked
 * could still land a name/role change on some other account. So this
 * function locks the actor's OWN row (SELECT ... FOR UPDATE, via
 * db.lockUserRowForUpdate) inside this same transaction and re-checks
 * role === "admin" against that fresh read - ctx.user.role itself is never
 * consulted here at all. When actorAdminId === userId (an admin editing
 * their own name), the target lock IS the actor lock - only one row is
 * ever locked, never twice, regardless of whether the admin-set lock (step
 * 1) also ran first. When actor and target differ, both ids are locked
 * via the SAME shared helper in ASCENDING id order (never "target first"
 * or "actor first" as a fixed rule) - so a request editing {actor: A,
 * target: B} and a concurrent request editing {actor: B, target: A} lock
 * in the same relative order and cannot deadlock against each other (the
 * same fixed-lock-order technique executeAccountRecovery already uses for
 * its source/target user locks).
 *
 * ACTOR CHECK BEFORE TARGET-EXISTENCE CHECK (follow-up review finding on
 * this same PR): an earlier version of this function checked target
 * existence first, so a request from an already-demoted/deleted actor
 * against a NON-existent target id returned NOT_FOUND instead of
 * FORBIDDEN - i.e. the response leaked whether an arbitrary target id
 * exists to a caller who is no longer authorized to be asking at all.
 * Checking the actor FIRST means an unauthorized caller always gets the
 * SAME FORBIDDEN regardless of the target id or whether it exists -
 * authorization is verified before anything about the target is even
 * consulted, exactly as it should be. The configured-owner check below
 * runs strictly AFTER this ordering is already established, so it never
 * changes it: an unauthorized/stale actor still gets FORBIDDEN before
 * anything about the target - owner or otherwise - is ever consulted.
 *
 * OWNER PROTECTION (PR #45 P1 review finding "Reject demotion of the
 * configured owner", PRRT_kwDOTeQWFc6a9DtE): every authentication cycle
 * calls db.upsertUser (or db.createGoogleUserWithIdentity for a
 * brand-new Google sign-in), and BOTH unconditionally re-promote
 * `ENV.ownerOpenId` back to role="admin" the moment that account signs
 * in again - see server/db.ts's own doc comments on those two functions.
 * That owner auto-promotion behavior is intentional and is NOT changed
 * here. But it means a demotion applied through this page could never
 * actually stick: the very next login (or a concurrent authentication
 * write already in flight) silently restores admin access, and the admin
 * who performed the demotion has no way to tell their action didn't
 * durably take effect. So instead of allowing a demotion that cannot
 * hold, an attempt to change the configured owner's role from "admin" to
 * "user" is rejected outright, using `target.openId` from the SAME
 * locked row read Step 2 already performed - never a second query, and
 * never a value taken from client input or the caller's session. A
 * name-only edit of the owner's account (never touching `role`) is
 * completely unaffected and still succeeds normally. If `OWNER_OPEN_ID`
 * is not configured (`ENV.ownerOpenId === ""`), this check can never
 * match any real account's openId (a `NOT NULL` column that is never an
 * empty string) and this rule is effectively inert - existing behavior
 * for every deployment without a configured owner is unchanged. Neither
 * the owner's openId nor the configured `OWNER_OPEN_ID` value is ever
 * included in this function's return value, its thrown error's message,
 * any console log, or any audit `safeMetadata` - the rejection is
 * reported generically, the same way "last remaining admin" is.
 */
export async function updateAdminUserProfile(params: {
  actorAdminId: number;
  userId: number;
  name?: string | null;
  role?: "user" | "admin";
  reason: string;
  confirmText?: string;
}): Promise<UpdateAdminUserResult> {
  const reason = params.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new AdminUserManagementError("BAD_REQUEST", "A reason (5-500 characters) is required");
  }

  await db.assertDatabaseAvailable();
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  return database.transaction(async (tx: any) => {
    // Step 1: admin-set lock FIRST, before ANY per-user lock, for EVERY
    // mutation this function performs - name-only edits included, not
    // just requests that supply `role` - see this function's own "LOCK
    // HIERARCHY" docstring above for the deadlock this unconditional
    // ordering closes. Captured once and reused by the last-admin check
    // in step 6 below when role IS changing - never locked a second time,
    // and never re-derived - a name-only edit simply never consults it.
    const adminRowsSnapshot: Array<{ id: number }> = await db.lockAdminRoleRows(tx);

    // Step 2: lock the target row and (unless this is a self-edit) the
    // actor's row too, via the SAME shared helper, in ascending id order.
    const isSelfEdit = params.actorAdminId === params.userId;
    const idsToLock = isSelfEdit
      ? [params.userId]
      : [params.actorAdminId, params.userId].sort((a, b) => a - b);

    const lockedById = new Map<
      number,
      { id: number; name: string | null; role: "user" | "admin"; openId: string }
    >();
    for (const id of idsToLock) {
      const row = await db.lockUserRowForUpdate(id, tx);
      if (row) lockedById.set(id, row);
    }

    // Step 3: actor revalidation, checked BEFORE target existence - see
    // this function's own "ACTOR REVALIDATION" docstring above. A missing
    // actor row (deleted concurrently) or a role that is no longer
    // "admin" both fail closed as FORBIDDEN, never NOT_FOUND (this is an
    // authorization failure on the CALLER, and must be indistinguishable
    // from "the caller is unauthorized" regardless of whether the target
    // happens to exist - checking target-existence first would let an
    // already-demoted/deleted actor learn whether an arbitrary target id
    // exists via the NOT_FOUND/FORBIDDEN split, which is not this
    // function's authorization boundary to leak). Works identically for a
    // self-edit (isSelfEdit locked only params.userId === actorAdminId,
    // under that same key) and for a distinct actor/target pair - no
    // separate self-edit branch needed here.
    const actor = lockedById.get(params.actorAdminId);
    if (!actor || actor.role !== "admin") {
      throw new AdminUserManagementError(
        "FORBIDDEN",
        "Acting admin session is no longer valid - your account may have been demoted or removed"
      );
    }

    // Step 4: NOW check the target exists - only reachable once the actor
    // is confirmed to be a real, currently-admin account.
    const target = lockedById.get(params.userId);
    if (!target) throw new AdminUserManagementError("NOT_FOUND", "User not found");

    // Step 5: compute real changes - a client-supplied field equal to the
    // current value is not a change, and a request with no real change at
    // all must be rejected outright (never a silent success).
    const nameChanged = params.name !== undefined && params.name !== (target.name ?? null);
    const roleChanged = params.role !== undefined && params.role !== target.role;
    if (!nameChanged && !roleChanged) {
      throw new AdminUserManagementError("BAD_REQUEST", "No changes to apply");
    }

    // Step 6: role-safety rules - only evaluated when the role is actually
    // changing. Every rule here is re-checked against the LOCKED `target`
    // row read above, not the input the client sent.
    if (roleChanged) {
      const expectedConfirmText = `CHANGE ROLE ${params.userId}`;
      if (params.confirmText !== expectedConfirmText) {
        throw new AdminUserManagementError("BAD_REQUEST", "Confirmation text does not match");
      }

      // "ห้าม Admin ลด Role ของตัวเอง" - since the actor calling this is
      // always an admin (adminProcedure), the only role transition that
      // can ever apply to the actor's own account is a demotion; blocking
      // any self role-change is equivalent and simpler to reason about.
      if (target.id === params.actorAdminId) {
        throw new AdminUserManagementError("FORBIDDEN", "Admins cannot change their own role");
      }

      if (target.role === "admin" && params.role === "user") {
        // Configured-owner protection - see this function's own "OWNER
        // PROTECTION" docstring above. Checked using target.openId from
        // the SAME locked row read in Step 2 - never a second query,
        // never client input. ENV.ownerOpenId === "" (unconfigured) can
        // never equal a real, NOT-NULL openId, so this is a no-op on any
        // deployment without a configured owner.
        if (ENV.ownerOpenId && target.openId === ENV.ownerOpenId) {
          throw new AdminUserManagementError(
            "FORBIDDEN",
            "This account is the configured owner and its role cannot be changed"
          );
        }

        // Reuses the admin-set snapshot already locked in Step 1 - never
        // re-locked here (see db.lockAdminRoleRows's own docstring and
        // this function's "LOCK HIERARCHY" note above for why re-locking
        // mid-transaction would defeat the fixed hierarchy this exists to
        // enforce).
        if (adminRowsSnapshot.length <= 1) {
          throw new AdminUserManagementError("FORBIDDEN", "Cannot demote the last remaining admin");
        }
      }

      if (target.role === "user" && params.role === "admin") {
        const identity = await db.getAuthIdentityByUserAndProvider(target.id, "google", tx);
        if (!identity) {
          throw new AdminUserManagementError(
            "FORBIDDEN",
            "User must have a linked Google identity before being promoted to admin"
          );
        }
      }
    }

    // Step 7: apply the update - conditional on the role still matching
    // what this transaction just locked and read (see
    // db.updateAdminUserFields's own docstring).
    const applied = await db.updateAdminUserFields(
      {
        userId: params.userId,
        expectedRole: target.role,
        name: nameChanged ? params.name : undefined,
        role: roleChanged ? params.role : undefined,
      },
      tx
    );
    if (!applied) {
      throw new AdminUserManagementError("CONFLICT", "Update failed - the account may have changed concurrently");
    }

    // Step 8: audit log(s) - one row per changed field type, matching the
    // adminUserAuditLogs.action enum. Never the old/new name, never the
    // email - only that the name field changed, and (for a role change)
    // the old/new role plus whether the target has a linked Google
    // identity, which is exactly what "safeMetadata" is scoped to allow
    // (see drizzle/schema.ts's adminUserAuditLogs doc comment).
    if (nameChanged) {
      await db.insertAdminUserAuditLog(
        {
          actorAdminId: params.actorAdminId,
          targetUserId: params.userId,
          action: "update_name",
          reason,
          safeMetadata: { fieldChanged: "name" },
        },
        tx
      );
    }
    if (roleChanged) {
      const identity = await db.getAuthIdentityByUserAndProvider(params.userId, "google", tx);
      await db.insertAdminUserAuditLog(
        {
          actorAdminId: params.actorAdminId,
          targetUserId: params.userId,
          action: "update_role",
          reason,
          safeMetadata: {
            fieldChanged: "role",
            roleBefore: target.role,
            roleAfter: params.role,
            googleConnected: Boolean(identity),
          },
        },
        tx
      );
    }

    return {
      id: params.userId,
      name: nameChanged ? (params.name ?? null) : (target.name ?? null),
      role: roleChanged ? (params.role as "user" | "admin") : target.role,
    };
  });
}

/**
 * The single-transaction hard-Delete flow:
 *  1. lock the target user row, 2. verify not-self and still role="user",
 *  3. re-run the FULL delete-safety assessment (see
 *  db.getAdminUserDeleteAssessment) inside the SAME transaction as the
 *  locked target-row read, 4. any blocker at all -> rollback with CONFLICT,
 *  5. write the audit log, 6. delete authIdentities, 7. delete the users
 *  row, 8. assert exactly one row was deleted, 9. commit (implicit - any
 *  throw rolls back everything, including the audit log).
 *
 * There is deliberately no `forceDelete`/`skipSafetyCheck`/`override`
 * parameter anywhere in this function's signature or body - the ONLY way
 * to make a user deletable is for their own data to genuinely become
 * empty first.
 *
 * NOT CONCURRENCY-SAFE YET, AND NOT WIRED TO ANY tRPC PROCEDURE - PR #45
 * security review finding: step 1 locks ONLY the target `users` row
 * (SELECT ... FOR UPDATE). Step 3's assessment then reads ~24 OTHER
 * tables (orders, carts, walletAccounts, pointsTransactions, ...), every
 * one of which stores `userId` as a plain, unenforced int with NO foreign
 * key back to `users.id` (see drizzle/schema.ts) - locking `users` does
 * nothing to block a concurrent INSERT into any of those tables. A
 * transaction here can legitimately observe zero blockers at step 3, while
 * a different, concurrent transaction commits a brand-new order/cart/
 * wallet row for this same user microseconds later - after step 4's
 * check has already passed, before step 7's delete commits. The result is
 * a business row left referencing a `users.id` that no longer exists.
 * Neither re-running the same COUNT queries again nor locking `users` a
 * second time closes this gap - the missing piece is either DB-enforced
 * referential integrity across every referencing table (which would need
 * to be proven safe with a real multi-connection MariaDB integration test,
 * see docs on PR #45) or an equivalent application-level guarantee, and
 * neither exists yet. This function is kept, and its non-concurrency
 * business rules (self/last-admin/audit-actor protection, no override
 * parameter, transactional rollback) are still correct and unit-tested
 * (see adminUserManagementService.test.ts) - but server/routers.ts
 * deliberately does NOT expose an `admin.users.delete` procedure that
 * calls it. Do not wire this up to an endpoint without first closing the
 * gap described here.
 */
export async function deleteAdminUserSafely(params: {
  actorAdminId: number;
  userId: number;
  reason: string;
  confirmText: string;
}): Promise<{ deleted: true }> {
  const reason = params.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new AdminUserManagementError("BAD_REQUEST", "A reason (10-500 characters) is required");
  }
  const expectedConfirmText = `DELETE USER ${params.userId}`;
  if (params.confirmText !== expectedConfirmText) {
    throw new AdminUserManagementError("BAD_REQUEST", "Confirmation text does not match");
  }
  if (params.userId === params.actorAdminId) {
    throw new AdminUserManagementError("FORBIDDEN", "Admins cannot delete their own account");
  }

  await db.assertDatabaseAvailable();
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  return database.transaction(async (tx: any) => {
    // Step 1: lock the target user row.
    const targetRows = unwrapRows(await tx.execute(sql`SELECT * FROM users WHERE id = ${params.userId} FOR UPDATE`));
    const target = targetRows[0];
    if (!target) throw new AdminUserManagementError("NOT_FOUND", "User not found");

    // Step 2: not-self, still role="user" (re-checked against the LOCKED
    // row, not whatever the admin UI last saw).
    if (target.id === params.actorAdminId) {
      throw new AdminUserManagementError("FORBIDDEN", "Admins cannot delete their own account");
    }
    if (target.role !== "user") {
      throw new AdminUserManagementError("FORBIDDEN", "Only accounts with role \"user\" can be hard-deleted");
    }

    // Step 3: re-run the full delete-safety assessment inside this same
    // transaction. NOTE: this reads ~24 OTHER tables, none of which are
    // locked by anything in this function (only the target `users` row
    // is, from step 1) - see this function's own top-of-file "NOT
    // CONCURRENCY-SAFE YET" warning for why that is a real, currently
    // unresolved gap, not just a note for the future.
    const assessment = await db.getAdminUserDeleteAssessment(params.userId, tx);

    // Step 4: any blocker at all -> rollback with CONFLICT. Never
    // overridable - there is no parameter anywhere in this function that
    // can skip this check.
    if (!assessment.canDelete) {
      throw new AdminUserManagementError(
        "CONFLICT",
        "บัญชีนี้มีข้อมูลธุรกรรมหรือข้อมูลการใช้งาน จึงไม่สามารถลบแบบถาวรได้"
      );
    }

    const identity = await db.getAuthIdentityByUserAndProvider(params.userId, "google", tx);

    // Step 5: audit log - written BEFORE the actual deletes so a failure
    // partway through steps 6-8 rolls the log back together with them
    // (this is one transaction; nothing here is "already recorded" until
    // the whole function returns normally).
    await db.insertAdminUserAuditLog(
      {
        actorAdminId: params.actorAdminId,
        targetUserId: params.userId,
        action: "delete_user",
        reason,
        safeMetadata: {
          googleConnected: Boolean(identity),
          assessment: { canDelete: true, blockerCount: 0 },
        },
      },
      tx
    );

    // Step 6: delete the target's own login identities (never third-party
    // data - see adminUserDeletionClassification.ts's "login_data"
    // category).
    await db.deleteAuthIdentitiesForUser(params.userId, tx);

    // Step 7-8: delete the users row itself and assert exactly one row
    // was actually removed.
    const affectedRows = await db.deleteUsersRowChecked(params.userId, tx);
    if (affectedRows !== 1) {
      throw new AdminUserManagementError("CONFLICT", "Delete failed unexpectedly - please try again");
    }

    // Step 9 (commit) is implicit - returning normally here lets
    // database.transaction() commit; any throw above already rolled
    // everything back.
    return { deleted: true as const };
  });
}
