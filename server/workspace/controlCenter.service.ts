import { and, asc, desc, eq } from "drizzle-orm";
import {
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceNovels,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishOwnershipTransitions,
  workspacePublishRuns,
  workspacePublishingDestinations,
} from "../../drizzle/schema";
import { getDb } from "../db";

export class WorkspaceControlCenterError extends Error {
  constructor(
    readonly code: "DATABASE_UNAVAILABLE" | "MEMBERSHIP_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceControlCenterError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceControlCenterError(
      "DATABASE_UNAVAILABLE",
      "Workspace Control Center database is unavailable."
    );
  }
  return db;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active")
    ))
    .limit(1);
  if (!membership) {
    throw new WorkspaceControlCenterError(
      "MEMBERSHIP_REQUIRED",
      "Active workspace membership is required for the Control Center."
    );
  }
  return membership;
}

/**
 * Read-only M03-M06 publish operations projection for the Control Center UI.
 * It deliberately exposes persisted operational evidence only. It never
 * claims work, retries jobs, writes receipts, changes ownership, publishes,
 * or invokes a provider.
 */
export async function getWorkspacePublishOperationalOverview(input: {
  actorUserId: number;
  workspaceId: number;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);

  const [runRows, itemRows, outboxRows, ownershipRows, transitions] = await Promise.all([
    db
      .select({
        run: workspacePublishRuns,
        destination: workspacePublishingDestinations,
        workspaceNovel: workspaceNovels,
      })
      .from(workspacePublishRuns)
      .innerJoin(
        workspacePublishingDestinations,
        eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id)
      )
      .innerJoin(
        workspaceNovels,
        eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id)
      )
      .where(eq(workspaceNovels.workspaceId, input.workspaceId))
      .orderBy(desc(workspacePublishRuns.createdAt), desc(workspacePublishRuns.id)),
    db
      .select({
        item: workspacePublishItems,
        runId: workspacePublishRuns.id,
      })
      .from(workspacePublishItems)
      .innerJoin(workspacePublishRuns, eq(workspacePublishItems.runId, workspacePublishRuns.id))
      .innerJoin(
        workspacePublishingDestinations,
        eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id)
      )
      .innerJoin(
        workspaceNovels,
        eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id)
      )
      .where(eq(workspaceNovels.workspaceId, input.workspaceId))
      .orderBy(asc(workspacePublishItems.id)),
    db
      .select()
      .from(workspaceOutbox)
      .where(eq(workspaceOutbox.workspaceId, input.workspaceId))
      .orderBy(asc(workspaceOutbox.id)),
    db
      .select({ entry: workspaceMigrationRegistry, workspaceNovel: workspaceNovels })
      .from(workspaceMigrationRegistry)
      .innerJoin(
        workspaceNovels,
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovels.id)
      )
      .where(and(
        eq(workspaceNovels.workspaceId, input.workspaceId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ))
      .orderBy(asc(workspaceNovels.id)),
    db
      .select()
      .from(workspacePublishOwnershipTransitions)
      .where(eq(workspacePublishOwnershipTransitions.workspaceId, input.workspaceId))
      .orderBy(desc(workspacePublishOwnershipTransitions.createdAt), desc(workspacePublishOwnershipTransitions.id)),
  ]);

  const ownershipByNovel = new Map(
    ownershipRows.map(row => [row.workspaceNovel.id, row.entry] as const)
  );

  const runs = runRows.map(row => {
    const items = itemRows
      .filter(candidate => candidate.runId === row.run.id)
      .map(candidate => candidate.item);
    const outbox = outboxRows.filter(candidate => candidate.publishRunId === row.run.id);
    const itemStatusCounts = {
      pending: 0,
      publishing: 0,
      published: 0,
      failed: 0,
      skipped: 0,
    };
    for (const item of items) itemStatusCounts[item.status] += 1;
    const outboxStatusCounts = {
      pending: 0,
      claimed: 0,
      delivered: 0,
      failed: 0,
      dead_letter: 0,
    };
    for (const row of outbox) outboxStatusCounts[row.status] += 1;

    return {
      run: row.run,
      destination: row.destination,
      workspaceNovel: row.workspaceNovel,
      ownership: ownershipByNovel.get(row.workspaceNovel.id) ?? null,
      itemStatusCounts,
      outboxStatusCounts,
      itemCount: items.length,
      outboxCount: outbox.length,
      unresolvedItemCount: items.filter(item => item.status !== "published" && item.status !== "skipped").length,
      outboxBacklogCount: outbox.filter(entry => entry.status !== "delivered").length,
    };
  });

  return {
    readOnly: true as const,
    ownership: ownershipRows,
    runs,
    transitions,
    sideEffectsApplied: false as const,
  };
}
