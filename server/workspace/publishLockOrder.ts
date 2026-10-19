import { and, eq, inArray } from "drizzle-orm";
import {
  episodes,
  novels,
  workspaceMembers,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { lockUserRowForUpdate } from "../db";

/**
 * Execution-time provenance policy.
 * `stagedByUserId` stays the historical Stage creator and is not rewritten.
 * Controlled Publish authority stays the Admin-requested outbox.
 * This check does not give an Author permission to publish.
 * An Admin creator must still be a platform admin under a user-row lock.
 * An Author creator must still have an active owner or editor membership.
 * Both must still see an active workspace, a null deletedAt, and an active
 * workspace-novel link. Novel ownership is checked by the caller after the
 * novel lock. Lock order is user, workspace novel, workspace, then membership.
 * That follows Author Stage, which locks the user before the grant join.
 * The work item is not locked. The published-episode guard holds that row
 * until the episode commit finishes, and locking it here deadlocks that guard.
 */
export class StageCreatorAuthorityError extends Error {
  readonly code = "STAGE_NOT_READY" as const;

  constructor() {
    super("The Stage creator no longer holds Editorial authority for this work item.");
    this.name = "StageCreatorAuthorityError";
  }
}

export async function assertStageCreatorAuthorityLocked(
  tx: any,
  input: { workspaceId: number; novelId: number; stagedByUserId: number },
) {
  const actor = await lockUserRowForUpdate(input.stagedByUserId, tx);
  const [link] = await tx
    .select({ id: workspaceNovels.id, status: workspaceNovels.status })
    .from(workspaceNovels)
    .where(and(
      eq(workspaceNovels.workspaceId, input.workspaceId),
      eq(workspaceNovels.novelId, input.novelId),
    ))
    .limit(1)
    .for("update");
  if (!link || link.status !== "active") throw new StageCreatorAuthorityError();
  const [workspace] = await tx
    .select({
      status: workspaceWorkspaces.status,
      deletedAt: workspaceWorkspaces.deletedAt,
    })
    .from(workspaceWorkspaces)
    .where(eq(workspaceWorkspaces.id, input.workspaceId))
    .limit(1)
    .for("update");
  if (!workspace || workspace.status !== "active" || workspace.deletedAt) {
    throw new StageCreatorAuthorityError();
  }
  if (actor?.role === "admin") return "admin" as const;
  if (actor?.role !== "author") throw new StageCreatorAuthorityError();
  const [member] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.userId, input.stagedByUserId),
      eq(workspaceMembers.workspaceId, input.workspaceId),
      eq(workspaceMembers.status, "active"),
      inArray(workspaceMembers.role, ["owner", "editor"]),
    ))
    .limit(1)
    .for("update");
  if (!member) throw new StageCreatorAuthorityError();
  return "author" as const;
}

/**
 * One-shot hook for the MySQL deadlock regression. Production leaves it unset.
 * The provider clears it before awaiting so a retried transaction does not
 * enter the hook again.
 */
export const publishLockBarrier: {
  beforeLocks?: (tx: any) => Promise<void>;
  afterNovelLock?: (tx: any) => Promise<void>;
} = {};

/**
 * Novel row, then the target episode row.
 * Author and Admin Stage already lock the novel before episode rows.
 * Taking the episode lock first inverted that order with the later novel update.
 */
export async function lockNovelThenEpisode(tx: any, novelId: number, episodeId: number) {
  const [novel] = await tx
    .select({ id: novels.id })
    .from(novels)
    .where(eq(novels.id, novelId))
    .limit(1)
    .for("update");
  if (!novel) return null;
  const hook = publishLockBarrier.afterNovelLock;
  if (hook) {
    publishLockBarrier.afterNovelLock = undefined;
    await hook(tx);
  }
  const [episode] = await tx
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1)
    .for("update");
  return episode ?? null;
}
