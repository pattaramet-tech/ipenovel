import { and, desc, eq, sql } from "drizzle-orm";
import {
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
} from "../../drizzle/schema";

export type EditorialQcColumnKey =
  "editing" | "needs_fix" | "pending_confirm" | "ready_to_publish" | "published";

export async function projectEditorialQcColumn(
  tx: any,
  input: {
    workItemId: number;
    expectedDraftId: number;
    targetColumnKey: EditorialQcColumnKey;
    actorUserId: number;
    reason: string;
    idempotencyKey: string;
  }
) {
  const [row] = await tx
    .select({
      workItem: workspaceEditorialWorkItems,
      card: workspaceKanbanCards,
    })
    .from(workspaceEditorialWorkItems)
    .innerJoin(
      workspaceKanbanCards,
      eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
    )
    .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
    .for("update")
    .limit(1);
  if (!row) return { changed: false, reason: "WORK_ITEM_NOT_FOUND" as const };

  const [latestDraft] = await tx
    .select({ id: workspaceEditorialDrafts.id })
    .from(workspaceEditorialDrafts)
    .where(eq(workspaceEditorialDrafts.workItemId, input.workItemId))
    .orderBy(
      desc(workspaceEditorialDrafts.version),
      desc(workspaceEditorialDrafts.id)
    )
    .limit(1);
  if (!latestDraft || latestDraft.id !== input.expectedDraftId) {
    return {
      changed: false,
      reason: "STALE_DRAFT" as const,
      latestDraftId: latestDraft?.id ?? null,
    };
  }

  const [target] = await tx
    .select()
    .from(workspaceKanbanColumns)
    .where(
      and(
        eq(workspaceKanbanColumns.boardId, row.card.boardId),
        eq(workspaceKanbanColumns.key, input.targetColumnKey),
        eq(workspaceKanbanColumns.status, "active")
      )
    )
    .limit(1);
  if (!target) return { changed: false, reason: "COLUMN_NOT_FOUND" as const };

  const [replay] = await tx
    .select()
    .from(workspaceKanbanTransitions)
    .where(
      and(
        eq(workspaceKanbanTransitions.cardId, row.card.id),
        eq(workspaceKanbanTransitions.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (replay) {
    return {
      changed: false,
      replayed: true,
      columnId: replay.toColumnId,
    };
  }

  if (row.card.columnId === target.id) {
    return { changed: false, replayed: false, columnId: target.id };
  }

  const update = await tx
    .update(workspaceKanbanCards)
    .set({
      columnId: target.id,
      version: sql`${workspaceKanbanCards.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceKanbanCards.id, row.card.id),
        eq(workspaceKanbanCards.version, row.card.version)
      )
    );
  const affected = Number(
    (update as any)[0]?.affectedRows ?? (update as any).affectedRows ?? 0
  );
  if (affected !== 1) {
    throw new Error("EDITORIAL_QC_CARD_VERSION_CONFLICT");
  }

  await tx.insert(workspaceKanbanTransitions).values({
    cardId: row.card.id,
    fromColumnId: row.card.columnId,
    toColumnId: target.id,
    actorUserId: input.actorUserId,
    reason: input.reason.slice(0, 500),
    idempotencyKey: input.idempotencyKey,
  });

  return { changed: true, replayed: false, columnId: target.id };
}
