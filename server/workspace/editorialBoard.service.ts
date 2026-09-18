import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  novels,
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
  editorialStoryLogicalKey,
  isCanonicalEditorialColumn,
  parseEditorialStoryLogicalKey,
} from "./editorialBoard.domain";

export class WorkspaceEditorialBoardError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORKSPACE_NOT_FOUND"
      | "EDITORIAL_BOARD_NOT_FOUND"
      | "EDITORIAL_BOARD_CONFLICT",
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

  const [columns, cards, transitions, storyRows] = await Promise.all([
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
  ]);

  const stories = new Map<number, any>(
    storyRows.map((row: any) => [row.workspaceNovel.id, row])
  );
  const projectedCards = cards.map((card: any) => {
    const identity = parseEditorialStoryLogicalKey(card.logicalItemKey);
    const story = identity ? stories.get(identity.workspaceNovelId) : undefined;
    return {
      ...card,
      workItemType: identity?.workItemType ?? "UNKNOWN",
      workspaceNovelId: identity?.workspaceNovelId ?? null,
      novel: story?.novel ?? null,
    };
  });

  return {
    board,
    columns: columns.map((column: any) => ({
      ...column,
      cards: projectedCards.filter((card: any) => card.columnId === column.id),
    })),
    transitions: transitions.map((row: any) => row.transition),
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
