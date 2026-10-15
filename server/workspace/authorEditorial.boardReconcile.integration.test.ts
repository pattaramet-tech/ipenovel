import mysql from "mysql2/promise";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  novels,
  users,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceMembers,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "../test-helpers/testDbConnectionOptions";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { getTestDb } from "../test-helpers/testDb";
import { getAuthorEditorialSurface, runAuthorEditorialChecker } from "./authorEditorial.service";
import { reconcileEditorialCheckerBoard } from "./editorialForeignChecker.service";
import { createEditorialEpisodeWorkItem, ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource, type EditorialSourcePayload } from "./editorialDraft.service";
import { bindPublicationNovel, createWorkspace } from "./service";

function source(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:author-r4b-board-reconcile",
    mimeType: "text/plain",
    title: "episode-12.txt",
    revisionKey: "author-r4b-board",
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 12",
      paragraphs: ["บทที่ 12 ชื่อบท", "เนื้อหาสะอาดไม่มี finding", "จบตอน"],
    }],
  };
}

type Fixture = {
  db: ReturnType<typeof getTestDb>;
  scope: { actorUserId: number; workspaceId: number; workItemId: number };
  draftId: number;
  runId: number;
  blockingIssueCount: number;
  targetColumnKey: "needs_fix" | "pending_confirm";
  cardId: number;
  adminId: number;
  authorId: number;
  otherAuthorId: number;
  novelId: number;
  workspaceId: number;
  boardId: number;
};

async function columnKey(db: Fixture["db"], workItemId: number) {
  const [row] = await db
    .select({ key: workspaceKanbanColumns.key })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
    .where(eq(workspaceEditorialWorkItems.id, workItemId))
    .limit(1);
  return row?.key ?? null;
}

async function columnId(db: Fixture["db"], workItemId: number, key: string) {
  const [item] = await db
    .select({ boardId: workspaceKanbanCards.boardId })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
    .where(eq(workspaceEditorialWorkItems.id, workItemId))
    .limit(1);
  const [column] = await db
    .select({ id: workspaceKanbanColumns.id })
    .from(workspaceKanbanColumns)
    .where(and(
      eq(workspaceKanbanColumns.boardId, item.boardId),
      eq(workspaceKanbanColumns.key, key),
    ))
    .limit(1);
  return column.id;
}

async function moveCard(db: Fixture["db"], cardId: number, workItemId: number, key: string) {
  const id = await columnId(db, workItemId, key);
  await db.update(workspaceKanbanCards).set({ columnId: id }).where(eq(workspaceKanbanCards.id, cardId));
}

async function clearCheckerTransitions(db: Fixture["db"], cardId: number) {
  await db.delete(workspaceKanbanTransitions).where(and(
    eq(workspaceKanbanTransitions.cardId, cardId),
    like(workspaceKanbanTransitions.idempotencyKey, "editorial-qc-%"),
  ));
}

async function transitionCount(db: Fixture["db"], cardId: number, idempotencyKey: string) {
  const rows = await db
    .select({ id: workspaceKanbanTransitions.id })
    .from(workspaceKanbanTransitions)
    .where(and(
      eq(workspaceKanbanTransitions.cardId, cardId),
      eq(workspaceKanbanTransitions.idempotencyKey, idempotencyKey),
    ));
  return rows.length;
}

function reconcile(ctx: Fixture, draftId = ctx.draftId) {
  return reconcileEditorialCheckerBoard({
    ...ctx.scope,
    authorGrant: true,
    draftId,
    runId: ctx.runId,
    blockingIssueCount: ctx.blockingIssueCount,
  });
}

describe("IPE-070R4B board reconciliation under real locks", () => {
  let ctx: Fixture;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const admin = await createTestUser({ role: "admin" });
    const author = await createTestUser({ role: "author" });
    const otherAuthor = await createTestUser({ role: "author" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(admin.id, "Author R4B board reconcile");
    await bindPublicationNovel({
      actorUserId: admin.id,
      workspaceId: workspace.workspaceId,
      novelId: novel.id,
    });
    await db.update(novels).set({ authorUserId: author.id }).where(eq(novels.id, novel.id));
    await db.insert(workspaceMembers).values({
      workspaceId: workspace.workspaceId,
      userId: author.id,
      role: "editor",
      status: "active",
    });
    const board = await ensureEditorialBoard({
      actorUserId: admin.id,
      workspaceId: workspace.workspaceId,
    });
    const story = board?.columns.flatMap(column => column.cards)
      .find(card => card.workItemType === "NEW_STORY");
    const created = await createEditorialEpisodeWorkItem({
      actorUserId: admin.id,
      workspaceId: workspace.workspaceId,
      workspaceNovelId: story!.workspaceNovelId!,
      episodeNumber: "12",
      episodeTitle: "ชื่อจาก Intake",
      saleMode: "package",
      price: "12.00",
      isFree: false,
    });
    const workItemId = created.board?.columns.flatMap(column => column.cards)
      .find(card => card.workItemType === "NEW_EPISODE" && card.episodeNumber === "12")!.workItemId!;
    await importEditorialSource({
      actorUserId: admin.id,
      workspaceId: workspace.workspaceId,
      workItemId,
      payload: source(),
    });
    const scope = { actorUserId: author.id, workspaceId: workspace.workspaceId, workItemId };
    const surface = await getAuthorEditorialSurface(scope);
    const checked = await runAuthorEditorialChecker({
      ...scope,
      expectedDraftId: surface.draft!.id,
    });
    const targetColumnKey = checked.kanbanProjection.targetColumnKey;
    if (targetColumnKey !== "needs_fix" && targetColumnKey !== "pending_confirm") {
      throw new Error(`checker projection target was ${String(targetColumnKey)}`);
    }
    const [item] = await db
      .select({ cardId: workspaceEditorialWorkItems.cardId })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, workItemId))
      .limit(1);
    ctx = {
      db,
      scope,
      draftId: surface.draft!.id,
      runId: Number(checked.run!.id),
      blockingIssueCount: Number(checked.blockingIssueCount ?? 0),
      targetColumnKey,
      cardId: item.cardId!,
      adminId: admin.id,
      authorId: author.id,
      otherAuthorId: otherAuthor.id,
      novelId: novel.id,
      workspaceId: workspace.workspaceId,
      boardId: board!.board.id,
    };
  }, 60000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.db.delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, ctx.boardId));
    await ctx.db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
    await ctx.db.delete(novels).where(eq(novels.id, ctx.novelId));
    await ctx.db.delete(users).where(eq(users.id, ctx.adminId));
    await ctx.db.delete(users).where(eq(users.id, ctx.authorId));
    await ctx.db.delete(users).where(eq(users.id, ctx.otherAuthorId));
  });

  beforeEach(async () => {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "editing");
    await clearCheckerTransitions(ctx.db, ctx.cardId);
  });

  it("applies a deferred checker projection, then a repeat leaves the same transition", async () => {
    const key = `editorial-qc-${ctx.runId}-${ctx.targetColumnKey}`;
    const first = await reconcile(ctx);
    expect(first.applied).toBe(true);
    expect(first.deferred).toBe(false);
    expect(first.status).toBe("updated");
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe(ctx.targetColumnKey);
    expect(await transitionCount(ctx.db, ctx.cardId, key)).toBe(1);

    const second = await reconcile(ctx);
    expect(second.applied).toBe(true);
    expect(second.deferred).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe(ctx.targetColumnKey);
    expect(await transitionCount(ctx.db, ctx.cardId, key)).toBe(1);
  });

  it("leaves a card that stages while reconciliation is waiting for the work item lock", async () => {
    const options = buildTestDbConnectionOptions(
      process.env.TEST_DATABASE_URL,
      parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT),
    );
    const readyId = await columnId(ctx.db, ctx.scope.workItemId, "ready_to_publish");
    const holder = await mysql.createConnection(options);
    const watcher = await mysql.createConnection(options);
    let pending: Promise<unknown> | null = null;
    try {
      await holder.beginTransaction();
      await holder.query(
        "SELECT id FROM workspaceEditorialWorkItems WHERE id = ? FOR UPDATE",
        [ctx.scope.workItemId],
      );
      let settled = false;
      pending = reconcile(ctx).finally(() => {
        settled = true;
      });
      const started = Date.now();
      let waiting = false;
      while (Date.now() - started < 5000) {
        const [rows] = await watcher.query(
          "SELECT COUNT(*) AS waiting FROM performance_schema.data_lock_waits",
        ) as unknown as [Array<{ waiting: number }>];
        if (Number(rows[0]?.waiting ?? 0) > 0) {
          waiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);
      await holder.query(
        "UPDATE workspaceKanbanCards c INNER JOIN workspaceEditorialWorkItems w ON w.cardId = c.id SET c.columnId = ? WHERE w.id = ?",
        [readyId, ctx.scope.workItemId],
      );
      await holder.commit();
      const result = await pending;
      pending = null;
      expect(result).toMatchObject({
        applied: false,
        deferred: false,
        reason: "LATER_BOARD_OWNS_COLUMN",
      });
      expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("ready_to_publish");
      expect(await transitionCount(
        ctx.db,
        ctx.cardId,
        `editorial-qc-${ctx.runId}-${ctx.targetColumnKey}`,
      )).toBe(0);
    } finally {
      await holder.rollback().catch(() => undefined);
      await holder.end();
      await watcher.end();
      if (pending) await pending.catch(() => undefined);
    }
  }, 30000);

  it("does not move a published card back to the checker column", async () => {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "published");
    const result = await reconcile(ctx);
    expect(result).toMatchObject({
      applied: false,
      deferred: false,
      reason: "LATER_BOARD_OWNS_COLUMN",
    });
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("published");
  });

  it("rejects a stale draft and a revoked owner without moving the card", async () => {
    const stale = await reconcile(ctx, ctx.draftId + 100000);
    expect(stale).toMatchObject({ applied: false, deferred: false, reason: "STALE_DRAFT" });
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");

    await ctx.db.update(novels).set({ authorUserId: ctx.otherAuthorId }).where(eq(novels.id, ctx.novelId));
    await expect(reconcile(ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    await ctx.db.update(novels).set({ authorUserId: ctx.authorId }).where(eq(novels.id, ctx.novelId));
  });
});
