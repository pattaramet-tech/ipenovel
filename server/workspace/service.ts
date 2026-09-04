import { and, desc, eq, isNull } from "drizzle-orm";
import {
  novels,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceNovels,
  workspaceReadOnlyBindings,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  buildInitialMigrationOwnership,
  canBindPublicationNovel,
  canManageMembers,
  type WorkspaceRole,
  validateMembershipChange,
} from "./domain";

export class WorkspaceServiceError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORKSPACE_NOT_FOUND"
      | "MEMBERSHIP_REQUIRED"
      | "OWNER_ROLE_REQUIRED"
      | "NOVEL_NOT_FOUND"
      | "MEMBERSHIP_CONFLICT"
      | "INVALID_MEMBERSHIP_CHANGE",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceServiceError";
  }
}

async function database(): Promise<any> {
  const db = await getDb();
  if (!db) throw new WorkspaceServiceError("DATABASE_UNAVAILABLE", "Workspace is temporarily unavailable.");
  return db;
}

function insertId(result: any): number {
  const value = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkspaceServiceError("DATABASE_UNAVAILABLE", "Workspace was not persisted.");
  }
  return value;
}

async function activeMembership(db: any, workspaceId: number, userId: number) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active")
    ))
    .limit(1);
  return rows[0] as { role: WorkspaceRole; id: number } | undefined;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const membership = await activeMembership(db, workspaceId, userId);
  if (!membership) {
    throw new WorkspaceServiceError("MEMBERSHIP_REQUIRED", "You are not an active member of this workspace.");
  }
  return membership;
}

async function requireWorkspace(db: any, workspaceId: number) {
  const rows = await db.select().from(workspaceWorkspaces).where(and(
    eq(workspaceWorkspaces.id, workspaceId),
    eq(workspaceWorkspaces.status, "active"),
    isNull(workspaceWorkspaces.deletedAt)
  )).limit(1);
  if (!rows[0]) throw new WorkspaceServiceError("WORKSPACE_NOT_FOUND", "Workspace not found.");
  return rows[0];
}

export async function listWorkspacesForUser(userId: number) {
  const db = await database();
  return db
    .select({ workspace: workspaceWorkspaces, membership: workspaceMembers })
    .from(workspaceMembers)
    .innerJoin(workspaceWorkspaces, eq(workspaceMembers.workspaceId, workspaceWorkspaces.id))
    .where(and(
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      eq(workspaceWorkspaces.status, "active"),
      isNull(workspaceWorkspaces.deletedAt)
    ))
    .orderBy(desc(workspaceWorkspaces.updatedAt));
}

export async function createWorkspace(userId: number, name: string) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    const workspaceId = insertId(await tx.insert(workspaceWorkspaces).values({ name, ownerUserId: userId }));
    await tx.insert(workspaceMembers).values({
      workspaceId,
      userId,
      role: "owner",
      status: "active",
    });
    return { workspaceId };
  });
}

export async function getWorkspaceDetail(userId: number, workspaceId: number) {
  const db = await database();
  await requireWorkspace(db, workspaceId);
  const membership = await requireMembership(db, workspaceId, userId);
  const [members, novelRows] = await Promise.all([
    db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId)),
    db
      .select({ workspaceNovel: workspaceNovels, novel: novels })
      .from(workspaceNovels)
      .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
      .where(eq(workspaceNovels.workspaceId, workspaceId)),
  ]);
  const workspace = await requireWorkspace(db, workspaceId);
  return { workspace, membership, members, novels: novelRows };
}

export async function addOrUpdateMember(input: {
  actorUserId: number;
  workspaceId: number;
  userId: number;
  role: WorkspaceRole;
}) {
  const db = await database();
  await requireWorkspace(db, input.workspaceId);
  const actor = await requireMembership(db, input.workspaceId, input.actorUserId);
  if (!canManageMembers(actor.role)) {
    throw new WorkspaceServiceError("OWNER_ROLE_REQUIRED", "Only a workspace owner can manage members.");
  }

  const existingRows = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, input.workspaceId),
    eq(workspaceMembers.userId, input.userId)
  )).limit(1);
  const ownerRows = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, input.workspaceId),
    eq(workspaceMembers.role, "owner"),
    eq(workspaceMembers.status, "active")
  ));
  const failure = validateMembershipChange({
    actorUserId: input.actorUserId,
    targetUserId: input.userId,
    actorRole: actor.role,
    currentRole: existingRows[0]?.role,
    nextRole: input.role,
    activeOwnerCount: ownerRows.length,
  });
  if (failure) throw new WorkspaceServiceError("INVALID_MEMBERSHIP_CHANGE", failure);

  if (existingRows[0]) {
    await db.update(workspaceMembers)
      .set({ role: input.role, status: "active", version: (existingRows[0].version ?? 1) + 1 })
      .where(eq(workspaceMembers.id, existingRows[0].id));
  } else {
    await db.insert(workspaceMembers).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      status: "active",
    });
  }
  return { ok: true };
}

export async function bindPublicationNovel(input: {
  actorUserId: number;
  workspaceId: number;
  novelId: number;
}) {
  const db = await database();
  await requireWorkspace(db, input.workspaceId);
  const actor = await requireMembership(db, input.workspaceId, input.actorUserId);
  if (!canBindPublicationNovel(actor.role)) {
    throw new WorkspaceServiceError("OWNER_ROLE_REQUIRED", "Only workspace owners and editors can bind a novel.");
  }
  const novelRows = await db.select().from(novels).where(eq(novels.id, input.novelId)).limit(1);
  const novel = novelRows[0];
  if (!novel) throw new WorkspaceServiceError("NOVEL_NOT_FOUND", "Publication novel not found.");

  return db.transaction(async (tx: any) => {
    const existing = await tx.select().from(workspaceNovels).where(and(
      eq(workspaceNovels.workspaceId, input.workspaceId),
      eq(workspaceNovels.novelId, input.novelId)
    )).limit(1);

    const workspaceNovelId = existing[0]
      ? existing[0].id
      : insertId(await tx.insert(workspaceNovels).values({
          workspaceId: input.workspaceId,
          novelId: input.novelId,
          status: "active",
        }));

    if (!existing[0]) {
      await tx.insert(workspaceReadOnlyBindings).values({
        workspaceNovelId,
        sourceKind: "synthetic",
        sourceKey: `publication-novel:${input.novelId}`,
        displayName: `Synthetic source for ${novel.title}`,
        role: "source",
        sequence: 1,
        status: "active",
      });
      await tx.insert(workspaceMigrationRegistry).values(
        buildInitialMigrationOwnership().map((entry) => ({
          workspaceNovelId,
          capability: entry.capability,
          owner: entry.owner,
          cutoverEpoch: entry.cutoverEpoch,
          changedBy: input.actorUserId,
        }))
      );
    }
    return { workspaceNovelId, created: !existing[0] };
  });
}

export async function listReadOnlyBindings(userId: number, workspaceId: number) {
  const db = await database();
  await requireMembership(db, workspaceId, userId);
  return db
    .select({ binding: workspaceReadOnlyBindings, workspaceNovel: workspaceNovels, novel: novels })
    .from(workspaceReadOnlyBindings)
    .innerJoin(workspaceNovels, eq(workspaceReadOnlyBindings.workspaceNovelId, workspaceNovels.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .where(eq(workspaceNovels.workspaceId, workspaceId));
}

export async function listMigrationOwnership(userId: number, workspaceId: number) {
  const db = await database();
  await requireMembership(db, workspaceId, userId);
  return db
    .select({ entry: workspaceMigrationRegistry, workspaceNovel: workspaceNovels, novel: novels })
    .from(workspaceMigrationRegistry)
    .innerJoin(workspaceNovels, eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovels.id))
    .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
    .where(eq(workspaceNovels.workspaceId, workspaceId));
}
