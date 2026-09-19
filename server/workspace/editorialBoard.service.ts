import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  novels,
  users,
  workspaceEditorialWorkItemEvents,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  EDITORIAL_BOARD_NAME,
  EDITORIAL_BOARD_SLUG,
  EDITORIAL_COLUMNS,
  editorialEpisodeLogicalKey,
  editorialStoryLogicalKey,
  isCanonicalEditorialColumn,
  normalizeEditorialEpisodeKey,
  parseEditorialLogicalKey,
} from "./editorialBoard.domain";

export class WorkspaceEditorialBoardError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORKSPACE_NOT_FOUND"
      | "EDITORIAL_BOARD_NOT_FOUND"
      | "EDITORIAL_BOARD_CONFLICT"
      | "EDITORIAL_WORK_ITEM_NOT_FOUND"
      | "EDITORIAL_WORK_ITEM_CONFLICT"
      | "EDITORIAL_ASSIGNEE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialBoardError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialBoardError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}
async function requireActiveWorkspace(db: any, workspaceId: number) {
  const [workspace] = await db
    .select()
    .from(workspaceWorkspaces)
    .where(
      and(
        eq(workspaceWorkspaces.id, workspaceId),
        eq(workspaceWorkspaces.status, "active")
      )
    )
    .limit(1);
  if (!workspace) {
    throw new WorkspaceEditorialBoardError(
      "WORKSPACE_NOT_FOUND",
      "Workspace not found."
    );
  }
  return workspace;
}

async function loadEditorialBoard(db: any, workspaceId: number) {
  const [board] = await db
    .select()
    .from(workspaceKanbanBoards)
    .where(
      and(
        eq(workspaceKanbanBoards.workspaceId, workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
        eq(workspaceKanbanBoards.status, "active")
      )
    )
    .limit(1);
  return board ?? null;
}

async function loadEditorialBoardReadModel(db: any, workspaceId: number) {
  const board = await loadEditorialBoard(db, workspaceId);
  if (!board) return null;

  const [
    columns,
    cards,
    transitions,
    storyRows,
    workItemRows,
    workItemEventRows,
    adminUsers,
  ] = await Promise.all([
    db
      .select()
      .from(workspaceKanbanColumns)
      .where(
        and(
          eq(workspaceKanbanColumns.boardId, board.id),
          eq(workspaceKanbanColumns.status, "active")
        )
      )
      .orderBy(asc(workspaceKanbanColumns.position)),
    db
      .select()
      .from(workspaceKanbanCards)
      .where(eq(workspaceKanbanCards.boardId, board.id))
      .orderBy(asc(workspaceKanbanCards.rank), asc(workspaceKanbanCards.id)),
    db
      .select({ transition: workspaceKanbanTransitions })
      .from(workspaceKanbanTransitions)
      .innerJoin(
        workspaceKanbanCards,
        eq(workspaceKanbanTransitions.cardId, workspaceKanbanCards.id)
      )
      .where(eq(workspaceKanbanCards.boardId, board.id))
      .orderBy(
        desc(workspaceKanbanTransitions.createdAt),
        desc(workspaceKanbanTransitions.id)
      ),
    db
      .select({ workspaceNovel: workspaceNovels, novel: novels })
      .from(workspaceNovels)
      .innerJoin(novels, eq(workspaceNovels.novelId, novels.id))
      .where(
        and(
          eq(workspaceNovels.workspaceId, workspaceId),
          eq(workspaceNovels.status, "active")
        )
      ),
    db
      .select({ workItem: workspaceEditorialWorkItems })
      .from(workspaceEditorialWorkItems)
      .innerJoin(
        workspaceKanbanCards,
        eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
      )
      .where(eq(workspaceKanbanCards.boardId, board.id)),
    db
      .select({
        event: workspaceEditorialWorkItemEvents,
        workItem: workspaceEditorialWorkItems,
      })
      .from(workspaceEditorialWorkItemEvents)
      .innerJoin(
        workspaceEditorialWorkItems,
        eq(workspaceEditorialWorkItemEvents.workItemId, workspaceEditorialWorkItems.id)
      )
      .innerJoin(
        workspaceKanbanCards,
        eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
      )
      .where(eq(workspaceKanbanCards.boardId, board.id))
      .orderBy(
        desc(workspaceEditorialWorkItemEvents.createdAt),
        desc(workspaceEditorialWorkItemEvents.id)
      ),
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.role, "admin"))
      .orderBy(asc(users.id)),
  ]);

  const stories = new Map<number, any>(
    storyRows.map((row: any) => [row.workspaceNovel.id, row])
  );
  const workItemsByCard = new Map<number, any>(
    workItemRows.map((row: any) => [row.workItem.cardId, row.workItem])
  );
  const adminsById = new Map<number, any>(
    adminUsers.map((admin: any) => [admin.id, admin])
  );
  const transitionHistory = new Map<number, any[]>();
  for (const row of transitions) {
    const history = transitionHistory.get(row.transition.cardId) ?? [];
    history.push({
      kind: "transition",
      id: row.transition.id,
      actorUserId: row.transition.actorUserId,
      actor: adminsById.get(row.transition.actorUserId) ?? null,
      fromColumnId: row.transition.fromColumnId,
      toColumnId: row.transition.toColumnId,
      reason: row.transition.reason,
      createdAt: row.transition.createdAt,
    });
    transitionHistory.set(row.transition.cardId, history);
  }
  const workItemHistory = new Map<number, any[]>();
  for (const row of workItemEventRows) {
    const history = workItemHistory.get(row.workItem.cardId) ?? [];
    history.push({
      kind: "work_item_event",
      id: row.event.id,
      eventType: row.event.eventType,
      actorUserId: row.event.actorUserId,
      actor: adminsById.get(row.event.actorUserId) ?? null,
      fromAssigneeUserId: row.event.fromAssigneeUserId,
      toAssigneeUserId: row.event.toAssigneeUserId,
      createdAt: row.event.createdAt,
    });
    workItemHistory.set(row.workItem.cardId, history);
  }

  const projectedCards = cards.map((card: any) => {
    const workItem = workItemsByCard.get(card.id);
    const fallbackIdentity = parseEditorialLogicalKey(card.logicalItemKey);
    const workspaceNovelId =
      workItem?.workspaceNovelId ?? fallbackIdentity?.workspaceNovelId ?? null;
    const story = workspaceNovelId ? stories.get(workspaceNovelId) : undefined;
    const history = [
      ...(transitionHistory.get(card.id) ?? []),
      ...(workItemHistory.get(card.id) ?? []),
    ].sort((a: any, b: any) => {
      const timeDelta =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return timeDelta || b.id - a.id;
    });

    return {
      ...card,
      workItemId: workItem?.id ?? null,
      workItemVersion: workItem?.version ?? null,
      workItemType:
        workItem?.workItemType === "new_story"
          ? "NEW_STORY"
          : workItem?.workItemType === "new_episode"
            ? "NEW_EPISODE"
            : fallbackIdentity?.workItemType ?? "UNKNOWN",
      workspaceNovelId,
      novel: story?.novel ?? null,
      episodeNumber: workItem?.episodeNumber ?? null,
      episodeTitle: workItem?.episodeTitle ?? null,
      note: workItem?.note ?? null,
      assigneeUserId: workItem?.assigneeUserId ?? null,
      assignee: workItem?.assigneeUserId
        ? adminsById.get(workItem.assigneeUserId) ?? null
        : null,
      history,
    };
  });

  return {
    board,
    columns: columns.map((column: any) => ({
      ...column,
      cards: projectedCards.filter((card: any) => card.columnId === column.id),
    })),
    transitions: transitions.map((row: any) => row.transition),
    assignees: adminUsers,
  };
}

export async function getEditorialBoard(input: {
  actorUserId: number;
  workspaceId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  await requireActiveWorkspace(db, input.workspaceId);
  return loadEditorialBoardReadModel(db, input.workspaceId);
}
export async function ensureEditorialBoard(input: {
  actorUserId: number;
  workspaceId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  await requireActiveWorkspace(db, input.workspaceId);

  await db.transaction(async (tx: any) => {
    await tx
      .insert(workspaceKanbanBoards)
      .values({
        workspaceId: input.workspaceId,
        name: EDITORIAL_BOARD_NAME,
        slug: EDITORIAL_BOARD_SLUG,
        status: "active",
      })
      .onDuplicateKeyUpdate({
        set: { id: sql`LAST_INSERT_ID(${workspaceKanbanBoards.id})` },
      });

    const board = await loadEditorialBoard(tx, input.workspaceId);
    if (!board) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_BOARD_NOT_FOUND",
        "Editorial board could not be resolved."
      );
    }

    const existingColumns = await tx
      .select()
      .from(workspaceKanbanColumns)
      .where(eq(workspaceKanbanColumns.boardId, board.id));

    for (const existing of existingColumns) {
      if (!isCanonicalEditorialColumn(existing)) {
        throw new WorkspaceEditorialBoardError(
          "EDITORIAL_BOARD_CONFLICT",
          "Existing editorial board columns do not match the canonical workflow."
        );
      }
    }

    for (const column of EDITORIAL_COLUMNS) {
      await tx
        .insert(workspaceKanbanColumns)
        .values({
          boardId: board.id,
          key: column.key,
          name: column.name,
          position: column.position,
          status: "active",
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`LAST_INSERT_ID(${workspaceKanbanColumns.id})` },
        });
    }

    const [newColumn] = await tx
      .select()
      .from(workspaceKanbanColumns)
      .where(
        and(
          eq(workspaceKanbanColumns.boardId, board.id),
          eq(workspaceKanbanColumns.key, "new")
        )
      )
      .limit(1);
    if (!newColumn) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_BOARD_CONFLICT",
        "Editorial New column was not created."
      );
    }
    const storyRows = await tx
      .select({ workspaceNovel: workspaceNovels })
      .from(workspaceNovels)
      .where(
        and(
          eq(workspaceNovels.workspaceId, input.workspaceId),
          eq(workspaceNovels.status, "active")
        )
      );

    for (const row of storyRows) {
      const logicalItemKey = editorialStoryLogicalKey(row.workspaceNovel.id);
      await tx
        .insert(workspaceKanbanCards)
        .values({
          boardId: board.id,
          columnId: newColumn.id,
          bindingId: null,
          logicalItemKey,
          rank: row.workspaceNovel.id,
          status: "active",
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`LAST_INSERT_ID(${workspaceKanbanCards.id})` },
        });

      const [card] = await tx
        .select()
        .from(workspaceKanbanCards)
        .where(
          and(
            eq(workspaceKanbanCards.boardId, board.id),
            eq(workspaceKanbanCards.logicalItemKey, logicalItemKey)
          )
        )
        .limit(1);
      if (!card) {
        throw new WorkspaceEditorialBoardError(
          "EDITORIAL_BOARD_CONFLICT",
          "Editorial story card could not be resolved."
        );
      }

      await tx
        .insert(workspaceEditorialWorkItems)
        .values({
          cardId: card.id,
          workspaceNovelId: row.workspaceNovel.id,
          workItemType: "new_story",
          itemKey: "story",
          createdByUserId: input.actorUserId,
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`LAST_INSERT_ID(${workspaceEditorialWorkItems.id})` },
        });
      const [workItem] = await tx
        .select()
        .from(workspaceEditorialWorkItems)
        .where(eq(workspaceEditorialWorkItems.cardId, card.id))
        .limit(1);
      if (
        !workItem ||
        workItem.workspaceNovelId !== row.workspaceNovel.id ||
        workItem.workItemType !== "new_story" ||
        workItem.itemKey !== "story"
      ) {
        throw new WorkspaceEditorialBoardError(
          "EDITORIAL_BOARD_CONFLICT",
          "Editorial story metadata conflicts with the durable story identity."
        );
      }
      const [existingInitialTransition] = await tx
        .select({ id: workspaceKanbanTransitions.id })
        .from(workspaceKanbanTransitions)
        .where(
          and(
            eq(workspaceKanbanTransitions.cardId, card.id),
            eq(workspaceKanbanTransitions.idempotencyKey, "editorial-initial")
          )
        )
        .limit(1);
      await tx
        .insert(workspaceEditorialWorkItemEvents)
        .values({
          workItemId: workItem.id,
          eventType: existingInitialTransition ? "backfilled" : "created",
          actorUserId: input.actorUserId,
          fromAssigneeUserId: null,
          toAssigneeUserId: workItem.assigneeUserId,
          idempotencyKey: "metadata-initial",
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`LAST_INSERT_ID(${workspaceEditorialWorkItemEvents.id})` },
        });

      await tx
        .insert(workspaceKanbanTransitions)
        .values({
          cardId: card.id,
          fromColumnId: null,
          toColumnId: newColumn.id,
          actorUserId: input.actorUserId,
          reason: "editorial_story_bound",
          idempotencyKey: "editorial-initial",
        })
        .onDuplicateKeyUpdate({
          set: { id: sql`LAST_INSERT_ID(${workspaceKanbanTransitions.id})` },
        });
    }
  });

  return getEditorialBoard(input);
}

async function requireAdminAssignee(db: any, assigneeUserId: number | null) {
  if (assigneeUserId === null) return null;
  const [assignee] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, assigneeUserId), eq(users.role, "admin")))
    .limit(1);
  if (!assignee) {
    throw new WorkspaceEditorialBoardError(
      "EDITORIAL_ASSIGNEE_INVALID",
      "Editorial assignee must be a platform admin."
    );
  }
  return assignee;
}

export async function listEditorialAssignees(input: {
  actorUserId: number;
  workspaceId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  await requireActiveWorkspace(db, input.workspaceId);
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.id));
}

export async function createEditorialEpisodeWorkItem(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  episodeNumber: string;
  episodeTitle?: string;
  assigneeUserId?: number | null;
}) {
  await ensureEditorialBoard({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
  });
  const db = await database();
  await requireAdminAssignee(db, input.assigneeUserId ?? null);
  const itemKey = normalizeEditorialEpisodeKey(input.episodeNumber);
  const episodeTitle = input.episodeTitle?.trim() || null;
  if (!itemKey || itemKey.length > 100) {
    throw new WorkspaceEditorialBoardError(
      "EDITORIAL_WORK_ITEM_CONFLICT",
      "Episode number is required and must not exceed 100 characters."
    );
  }

  let created = false;
  await db.transaction(async (tx: any) => {
    const board = await loadEditorialBoard(tx, input.workspaceId);
    if (!board) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_BOARD_NOT_FOUND",
        "Editorial board was not found."
      );
    }
    const [workspaceNovel] = await tx
      .select()
      .from(workspaceNovels)
      .where(
        and(
          eq(workspaceNovels.id, input.workspaceNovelId),
          eq(workspaceNovels.workspaceId, input.workspaceId),
          eq(workspaceNovels.status, "active")
        )
      )
      .limit(1);
    if (!workspaceNovel) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_WORK_ITEM_NOT_FOUND",
        "Workspace novel was not found."
      );
    }
    const [newColumn] = await tx
      .select()
      .from(workspaceKanbanColumns)
      .where(
        and(
          eq(workspaceKanbanColumns.boardId, board.id),
          eq(workspaceKanbanColumns.key, "new"),
          eq(workspaceKanbanColumns.status, "active")
        )
      )
      .limit(1);
    if (!newColumn) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_BOARD_CONFLICT",
        "Editorial New column was not found."
      );
    }

    const [existingWorkItem] = await tx
      .select()
      .from(workspaceEditorialWorkItems)
      .where(
        and(
          eq(workspaceEditorialWorkItems.workspaceNovelId, input.workspaceNovelId),
          eq(workspaceEditorialWorkItems.workItemType, "new_episode"),
          eq(workspaceEditorialWorkItems.itemKey, itemKey)
        )
      )
      .limit(1);
    if (existingWorkItem) {
      if (
        (existingWorkItem.episodeTitle ?? null) !== episodeTitle ||
        (existingWorkItem.assigneeUserId ?? null) !==
          (input.assigneeUserId ?? null)
      ) {
        throw new WorkspaceEditorialBoardError(
          "EDITORIAL_WORK_ITEM_CONFLICT",
          "This episode identity already exists with different intake metadata."
        );
      }
      return;
    }

    const logicalItemKey = editorialEpisodeLogicalKey(
      input.workspaceNovelId,
      input.episodeNumber
    );
    await tx
      .insert(workspaceKanbanCards)
      .values({
        boardId: board.id,
        columnId: newColumn.id,
        bindingId: null,
        logicalItemKey,
        rank: 0,
        status: "active",
      })
      .onDuplicateKeyUpdate({
        set: { id: sql`LAST_INSERT_ID(${workspaceKanbanCards.id})` },
      });
    const [card] = await tx
      .select()
      .from(workspaceKanbanCards)
      .where(
        and(
          eq(workspaceKanbanCards.boardId, board.id),
          eq(workspaceKanbanCards.logicalItemKey, logicalItemKey)
        )
      )
      .limit(1);
    if (!card) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_BOARD_CONFLICT",
        "Editorial episode card could not be resolved."
      );
    }

    await tx
      .insert(workspaceEditorialWorkItems)
      .values({
        cardId: card.id,
        workspaceNovelId: input.workspaceNovelId,
        workItemType: "new_episode",
        itemKey,
        episodeNumber: input.episodeNumber.trim(),
        episodeTitle,
        assigneeUserId: input.assigneeUserId ?? null,
        createdByUserId: input.actorUserId,
      })
      .onDuplicateKeyUpdate({
        set: { id: sql`LAST_INSERT_ID(${workspaceEditorialWorkItems.id})` },
      });
    const [workItem] = await tx
      .select()
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.cardId, card.id))
      .limit(1);
    if (
      !workItem ||
      workItem.workspaceNovelId !== input.workspaceNovelId ||
      workItem.workItemType !== "new_episode" ||
      workItem.itemKey !== itemKey ||
      (workItem.episodeTitle ?? null) !== episodeTitle ||
      (workItem.assigneeUserId ?? null) !== (input.assigneeUserId ?? null)
    ) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_WORK_ITEM_CONFLICT",
        "Editorial episode identity was already used for different metadata."
      );
    }

    await tx
      .insert(workspaceKanbanTransitions)
      .values({
        cardId: card.id,
        fromColumnId: null,
        toColumnId: newColumn.id,
        actorUserId: input.actorUserId,
        reason: "editorial_episode_intake",
        idempotencyKey: "editorial-initial",
      })
      .onDuplicateKeyUpdate({
        set: { id: sql`LAST_INSERT_ID(${workspaceKanbanTransitions.id})` },
      });
    await tx
      .insert(workspaceEditorialWorkItemEvents)
      .values({
        workItemId: workItem.id,
        eventType: "created",
        actorUserId: input.actorUserId,
        fromAssigneeUserId: null,
        toAssigneeUserId: workItem.assigneeUserId,
        idempotencyKey: "metadata-initial",
      })
      .onDuplicateKeyUpdate({
        set: {
          id: sql`LAST_INSERT_ID(${workspaceEditorialWorkItemEvents.id})`,
        },
      });
    created = true;
  });

  return {
    created,
    board: await getEditorialBoard({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
    }),
  };
}

export async function updateEditorialWorkItemNote(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  note: string | null;
  expectedVersion: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  await requireActiveWorkspace(db, input.workspaceId);
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) {
    throw new WorkspaceEditorialBoardError(
      "EDITORIAL_WORK_ITEM_CONFLICT",
      "Editorial note must not exceed 1000 characters."
    );
  }

  const [owned] = await db
    .select({ id: workspaceEditorialWorkItems.id })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
    .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
    .where(
      and(
        eq(workspaceEditorialWorkItems.id, input.workItemId),
        eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG)
      )
    )
    .limit(1);
  if (!owned) {
    throw new WorkspaceEditorialBoardError(
      "EDITORIAL_WORK_ITEM_NOT_FOUND",
      "Editorial work item was not found."
    );
  }
  const result = await db
    .update(workspaceEditorialWorkItems)
    .set({
      note,
      version: sql`${workspaceEditorialWorkItems.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceEditorialWorkItems.id, input.workItemId),
        eq(workspaceEditorialWorkItems.version, input.expectedVersion)
      )
    );
  if (Number(result?.[0]?.affectedRows ?? 0) !== 1) {
    throw new WorkspaceEditorialBoardError(
      "EDITORIAL_WORK_ITEM_CONFLICT",
      "Editorial work item changed before the note could be saved."
    );
  }
  const [workItem] = await db
    .select()
    .from(workspaceEditorialWorkItems)
    .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
    .limit(1);
  return { workItem };
}

export async function assignEditorialWorkItem(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  assigneeUserId: number | null;
  expectedVersion: number;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  await requireActiveWorkspace(db, input.workspaceId);
  await requireAdminAssignee(db, input.assigneeUserId);

  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select({
        workItem: workspaceEditorialWorkItems,
        card: workspaceKanbanCards,
        board: workspaceKanbanBoards,
      })
      .from(workspaceEditorialWorkItems)
      .innerJoin(
        workspaceKanbanCards,
        eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
      )
      .innerJoin(
        workspaceKanbanBoards,
        eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id)
      )
      .where(
        and(
          eq(workspaceEditorialWorkItems.id, input.workItemId),
          eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
          eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG)
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_WORK_ITEM_NOT_FOUND",
        "Editorial work item was not found."
      );
    }

    const [replay] = await tx
      .select()
      .from(workspaceEditorialWorkItemEvents)
      .where(
        and(
          eq(workspaceEditorialWorkItemEvents.workItemId, input.workItemId),
          eq(
            workspaceEditorialWorkItemEvents.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.eventType !== "assignee_changed" ||
        replay.actorUserId !== input.actorUserId ||
        (replay.toAssigneeUserId ?? null) !== input.assigneeUserId
      ) {
        throw new WorkspaceEditorialBoardError(
          "EDITORIAL_WORK_ITEM_CONFLICT",
          "Editorial assignment idempotency key was reused with another payload."
        );
      }
      return { workItem: row.workItem, replayed: true, unchanged: false };
    }

    if ((row.workItem.assigneeUserId ?? null) === input.assigneeUserId) {
      return { workItem: row.workItem, replayed: false, unchanged: true };
    }

    const update = await tx
      .update(workspaceEditorialWorkItems)
      .set({
        assigneeUserId: input.assigneeUserId,
        version: sql`${workspaceEditorialWorkItems.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceEditorialWorkItems.id, input.workItemId),
          eq(workspaceEditorialWorkItems.version, input.expectedVersion)
        )
      );
    const affected = Number(
      (update as any)[0]?.affectedRows ?? (update as any).affectedRows ?? 0
    );
    if (affected !== 1) {
      throw new WorkspaceEditorialBoardError(
        "EDITORIAL_WORK_ITEM_CONFLICT",
        "Editorial work item version conflict."
      );
    }

    await tx.insert(workspaceEditorialWorkItemEvents).values({
      workItemId: input.workItemId,
      eventType: "assignee_changed",
      actorUserId: input.actorUserId,
      fromAssigneeUserId: row.workItem.assigneeUserId,
      toAssigneeUserId: input.assigneeUserId,
      idempotencyKey: input.idempotencyKey,
    });
    const [workItem] = await tx
      .select()
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .limit(1);
    return { workItem, replayed: false, unchanged: false };
  });
}
