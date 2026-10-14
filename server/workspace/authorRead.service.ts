import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  novels,
  users,
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
  workspaceMembers,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * IPE-070R4A-R2 — The SQL predicate, NOT a standalone JavaScript row-policy,
 * is the authoritative read permission check on every returned record.
 * Admin Workspace services are deliberately separate and unchanged.
 */
async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Workspace unavailable" });
  return db;
}
const missing = () => new TRPCError({ code: "NOT_FOUND", message: "Workspace item not found" });

export type AuthorReadPageInput = {
  cursor?: number;
  limit?: number;
};
export const AUTHOR_READ_PAGE_DEFAULT = 25;
export const AUTHOR_READ_PAGE_MAX = 100;

function pageArguments(input: AuthorReadPageInput = {}) {
  const limit = input.limit ?? AUTHOR_READ_PAGE_DEFAULT;
  const cursor = input.cursor;
  if (!Number.isInteger(limit) || limit < 1 || limit > AUTHOR_READ_PAGE_MAX ||
      (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor <= 0))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid Workspace page" });
  }
  return { cursor, limit };
}
function nextPage<T extends Record<K, number>, K extends keyof T>(
  rows: T[], limit: number, cursorKey: K,
) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, nextCursor: hasMore ? items[items.length - 1][cursorKey] : null };
}

/** All owner/membership facts are freshly resolved inside each SQL SELECT. */
function authorScope(actorUserId: number) {
  return and(
    eq(users.id, actorUserId),
    eq(users.role, "author"),
    eq(workspaceMembers.userId, actorUserId),
    eq(workspaceMembers.status, "active"),
    inArray(workspaceMembers.role, ["owner", "editor", "reviewer", "viewer"]),
    eq(workspaceWorkspaces.status, "active"),
    isNull(workspaceWorkspaces.deletedAt),
    eq(workspaceNovels.status, "active"),
    eq(novels.authorUserId, actorUserId),
  );
}

/** Cursor across distinct active workspaces containing owned active novels. */
export async function listAuthorWorkspaceReadModels(
  actorUserId: number, input: AuthorReadPageInput = {},
) {
  const { cursor, limit } = pageArguments(input);
  const db = await database();
  const rows = await db.selectDistinct({
    workspaceId: workspaceWorkspaces.id,
    name: workspaceWorkspaces.name,
  })
    .from(workspaceNovels)
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(authorScope(actorUserId), cursor ? gt(workspaceWorkspaces.id, cursor) : undefined))
    .orderBy(asc(workspaceWorkspaces.id))
    .limit(limit + 1);
  return nextPage(rows, limit, "workspaceId");
}

/** A scoped lookup, never a scan of the actor's other Workspaces. */
export async function getAuthorWorkspaceReadModel(actorUserId: number, workspaceId: number) {
  const db = await database();
  const rows = await db.selectDistinct({
    workspaceId: workspaceWorkspaces.id,
    name: workspaceWorkspaces.name,
  })
    .from(workspaceNovels)
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(authorScope(actorUserId), eq(workspaceWorkspaces.id, workspaceId)))
    .limit(1);
  if (!rows.length) throw missing();
  return rows[0];
}

export async function listAuthorWorkspaceNovels(
  actorUserId: number, workspaceId: number, input: AuthorReadPageInput = {},
) {
  const { cursor, limit } = pageArguments(input);
  // Ensures a forbidden or empty workspace does not masquerade as an empty page.
  await getAuthorWorkspaceReadModel(actorUserId, workspaceId);
  const db = await database();
  const rows = await db.selectDistinct({
    workspaceNovelId: workspaceNovels.id,
    novelId: novels.id,
    title: novels.title,
    publicationStatus: novels.publicationStatus,
  })
    .from(workspaceNovels)
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      authorScope(actorUserId),
      eq(workspaceWorkspaces.id, workspaceId),
      cursor ? gt(workspaceNovels.id, cursor) : undefined,
    ))
    .orderBy(asc(workspaceNovels.id))
    .limit(limit + 1);
  return nextPage(rows, limit, "workspaceNovelId");
}

export async function listAuthorWorkspaceWorkItems(
  actorUserId: number, workspaceId: number, input: AuthorReadPageInput = {},
) {
  const { cursor, limit } = pageArguments(input);
  await getAuthorWorkspaceReadModel(actorUserId, workspaceId);
  const db = await database();
  const rows = await db.selectDistinct({
    workItemId: workspaceEditorialWorkItems.id,
    workspaceNovelId: workspaceNovels.id,
    novelId: novels.id,
    workItemType: workspaceEditorialWorkItems.workItemType,
    episodeNumber: workspaceEditorialWorkItems.episodeNumber,
    episodeTitle: workspaceEditorialWorkItems.episodeTitle,
  })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      authorScope(actorUserId),
      eq(workspaceWorkspaces.id, workspaceId),
      cursor ? gt(workspaceEditorialWorkItems.id, cursor) : undefined,
    ))
    .orderBy(asc(workspaceEditorialWorkItems.id))
    .limit(limit + 1);
  return nextPage(rows, limit, "workItemId");
}

/**
 * A bare workItemId is never trusted. Both existence and draft data SELECTs
 * join the original workspace, active membership, current DB role and novel owner.
 */
export async function getAuthorWorkspaceDraftReadModel(
  actorUserId: number, workspaceId: number, workItemId: number,
) {
  const db = await database();
  const eligibleItems = await db.select({ id: workspaceEditorialWorkItems.id })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(authorScope(actorUserId), eq(workspaceWorkspaces.id, workspaceId),
      eq(workspaceEditorialWorkItems.id, workItemId)))
    .limit(1);
  if (!eligibleItems.length) throw missing();

  const drafts = await db.select({
    id: workspaceEditorialDrafts.id,
    version: workspaceEditorialDrafts.version,
    presentationJson: workspaceEditorialDrafts.presentationJson,
    warningsJson: workspaceEditorialDrafts.warningsJson,
    draftSha256: workspaceEditorialDrafts.draftSha256,
  })
    .from(workspaceEditorialDrafts)
    .innerJoin(workspaceEditorialWorkItems, eq(workspaceEditorialDrafts.workItemId, workspaceEditorialWorkItems.id))
    .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
    .innerJoin(workspaceWorkspaces, eq(workspaceNovels.workspaceId, workspaceWorkspaces.id))
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(authorScope(actorUserId), eq(workspaceWorkspaces.id, workspaceId),
      eq(workspaceEditorialWorkItems.id, workItemId)))
    .orderBy(desc(workspaceEditorialDrafts.version), desc(workspaceEditorialDrafts.id))
    .limit(1);
  return drafts[0] ?? null;
}
