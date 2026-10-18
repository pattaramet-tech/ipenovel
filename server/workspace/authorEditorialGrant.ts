import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  novels,
  users,
  workspaceEditorialWorkItems,
  workspaceMembers,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { lockUserRowForUpdate } from "../db";

export type AuthorEditorialScope = {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
};

export type AuthorGrantLock = { lock: boolean };

const WRITE_MEMBER_ROLES = ["owner", "editor"] as const;
const READ_MEMBER_ROLES = ["owner", "editor", "reviewer", "viewer"] as const;

function notFound() {
  return new TRPCError({ code: "NOT_FOUND", message: "Workspace item not found" });
}

function forbidden() {
  return new TRPCError({
    code: "FORBIDDEN",
    message: "Author edit permission is required",
  });
}

function grantWhere(
  scope: AuthorEditorialScope,
  memberRoles: readonly ["owner", "editor"] | readonly ["owner", "editor", "reviewer", "viewer"],
) {
  return and(
    eq(users.id, scope.actorUserId),
    eq(users.role, "author"),
    eq(workspaceMembers.userId, scope.actorUserId),
    eq(workspaceMembers.status, "active"),
    inArray(workspaceMembers.role, [...memberRoles]),
    eq(workspaceWorkspaces.id, scope.workspaceId),
    eq(workspaceWorkspaces.status, "active"),
    isNull(workspaceWorkspaces.deletedAt),
    eq(workspaceNovels.workspaceId, scope.workspaceId),
    eq(workspaceNovels.status, "active"),
    eq(novels.authorUserId, scope.actorUserId),
    eq(workspaceEditorialWorkItems.id, scope.workItemId),
    eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id),
  );
}

function grantSelect(
  db: any,
  scope: AuthorEditorialScope,
  memberRoles: readonly ["owner", "editor"] | readonly ["owner", "editor", "reviewer", "viewer"],
  lock: boolean,
) {
  const query = db
    .select({ id: workspaceEditorialWorkItems.id })
    .from(workspaceEditorialWorkItems)
    .innerJoin(
      workspaceNovels,
      eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id),
    )
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(grantWhere(scope, memberRoles))
    .limit(1);
  return lock ? query.for("update") : query;
}

/**
 * Database grant for an Author write. `lock` is for the call that already
 * holds the work-item row lock inside the write transaction. Idempotent
 * replays must use that locked call before they return stored content.
 */
export async function assertAuthorEditorialWrite(
  db: any,
  scope: AuthorEditorialScope,
  options: AuthorGrantLock = { lock: false },
) {
  if (options.lock) {
    // Work item, then user, then the grant join. Every Author write, including
    // the QC board projection, uses this order. A projection that locked the
    // user first deadlocked with a write that already held the work item.
    await db
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, scope.workItemId))
      .for("update")
      .limit(1);
    const actor = await lockUserRowForUpdate(scope.actorUserId, db);
    if (!actor || actor.role !== "author") throw notFound();
  }
  const writeRows = await grantSelect(db, scope, WRITE_MEMBER_ROLES, options.lock);
  if (writeRows.length) return;
  const readRows = await grantSelect(db, scope, READ_MEMBER_ROLES, options.lock);
  if (readRows.length) throw forbidden();
  throw notFound();
}
