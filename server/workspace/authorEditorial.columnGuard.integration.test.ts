import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceEditorialDrafts,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceMembers,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "../test-helpers/testDbConnectionOptions";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { getTestDb } from "../test-helpers/testDb";
import {
  approveAuthorEditorialDraft,
  editAuthorEditorialDraft,
  getAuthorEditorialSurface,
  runAuthorEditorialChecker,
  stageAuthorEditorialDraft,
  undoAuthorEditorialDraft,
} from "./authorEditorial.service";
import { createEditorialEpisodeWorkItem, ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource, type EditorialSourcePayload } from "./editorialDraft.service";
import { applyEditorialEditorEdit } from "./editorialEditor.service";
import { bindPublicationNovel, createWorkspace } from "./service";

function source(revisionKey: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: `uploaded-file:${revisionKey}`,
    mimeType: "text/plain",
    title: "episode-12.txt",
    revisionKey,
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 12",
      paragraphs: ["บทที่ 12 ชื่อบท", "เนื้อหาสะอาดไม่มี finding", "จบตอน"],
    }],
  };
}

type Surface = Awaited<ReturnType<typeof getAuthorEditorialSurface>>;

function tabEdit(surface: Surface, replacement: string, idempotencyKey: string) {
  const tab = surface.tabs[0]!;
  const expectedText = tab.paragraphs.map(paragraph => paragraph.text).join("\n\n");
  return {
    expectedDraftId: surface.draft!.id,
    expectedDraftVersion: surface.draft!.version,
    expectedDraftSha256: surface.draft!.draftSha256,
    command: {
      kind: "replace_tab" as const,
      sourceTabId: tab.sourceTabId,
      expectedTabStructuralSha256: tab.structuralSha256,
      expectedText,
      replacementText: `${expectedText}\n\n${replacement}`,
      replacementParagraphKeys: [...tab.paragraphs.map(paragraph => paragraph.paragraphKey), ""],
    },
    idempotencyKey,
  };
}

type Fixture = {
  db: ReturnType<typeof getTestDb>;
  scope: { actorUserId: number; workspaceId: number; workItemId: number };
  adminId: number;
  authorId: number;
  otherAuthorId: number;
  novelId: number;
  workspaceId: number;
  boardId: number;
  cardId: number;
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
  const rows = await db
    .select({ id: workspaceKanbanColumns.id, key: workspaceKanbanColumns.key })
    .from(workspaceKanbanColumns)
    .where(eq(workspaceKanbanColumns.boardId, item.boardId));
  const found = rows.find(row => row.key === key);
  if (!found) throw new Error(`missing column ${key}`);
  return found.id;
}

async function moveCard(db: Fixture["db"], cardId: number, workItemId: number, key: string) {
  const id = await columnId(db, workItemId, key);
  await db.update(workspaceKanbanCards).set({ columnId: id }).where(eq(workspaceKanbanCards.id, cardId));
}

async function draftCount(db: Fixture["db"], workItemId: number) {
  const rows = await db
    .select({ id: workspaceEditorialDrafts.id })
    .from(workspaceEditorialDrafts)
    .where(eq(workspaceEditorialDrafts.workItemId, workItemId));
  return rows.length;
}

async function episodeRow(db: Fixture["db"], episodeId: number) {
  const [row] = await db
    .select({
      id: episodes.id,
      title: episodes.title,
      content: episodes.content,
      isPublished: episodes.isPublished,
    })
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  return row;
}

async function stageRows(db: Fixture["db"], workItemId: number) {
  return db
    .select({
      id: workspaceEditorialEpisodeStages.id,
      draftId: workspaceEditorialEpisodeStages.draftId,
      stagedDraftSha256: workspaceEditorialEpisodeStages.stagedDraftSha256,
      episodeId: workspaceEditorialEpisodeStages.episodeId,
    })
    .from(workspaceEditorialEpisodeStages)
    .where(eq(workspaceEditorialEpisodeStages.workItemId, workItemId));
}

async function buildFixture(label: string): Promise<Fixture> {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const db = getTestDb();
  const admin = await createTestUser({ role: "admin" });
  const author = await createTestUser({ role: "author" });
  const otherAuthor = await createTestUser({ role: "author" });
  const novel = await createTestNovel();
  const workspace = await createWorkspace(admin.id, `Author column guard ${label}`);
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
  const card = created.board?.columns.flatMap(column => column.cards)
    .find(item => item.workItemType === "NEW_EPISODE" && item.episodeNumber === "12");
  const workItemId = card!.workItemId!;
  await importEditorialSource({
    actorUserId: admin.id,
    workspaceId: workspace.workspaceId,
    workItemId,
    payload: source(label),
  });
  const [item] = await db
    .select({ cardId: workspaceEditorialWorkItems.cardId })
    .from(workspaceEditorialWorkItems)
    .where(eq(workspaceEditorialWorkItems.id, workItemId))
    .limit(1);
  return {
    db,
    scope: { actorUserId: author.id, workspaceId: workspace.workspaceId, workItemId },
    adminId: admin.id,
    authorId: author.id,
    otherAuthorId: otherAuthor.id,
    novelId: novel.id,
    workspaceId: workspace.workspaceId,
    boardId: board!.board.id,
    cardId: item.cardId!,
  };
}

async function cleanup(ctx: Fixture | undefined) {
  if (!ctx) return;
  await ctx.db.delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, ctx.boardId));
  await ctx.db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, ctx.workspaceId));
  await ctx.db.delete(novels).where(eq(novels.id, ctx.novelId));
  await ctx.db.delete(users).where(eq(users.id, ctx.adminId));
  await ctx.db.delete(users).where(eq(users.id, ctx.authorId));
  await ctx.db.delete(users).where(eq(users.id, ctx.otherAuthorId));
}

describe("IPE-070R4B author save and undo before stage", () => {
  let ctx: Fixture;

  beforeAll(async () => {
    ctx = await buildFixture("before-stage");
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "editing");
  }, 60000);

  afterAll(async () => {
    await cleanup(ctx);
  });

  it("saves and undoes while the card is still editing", async () => {
    const before = await getAuthorEditorialSurface(ctx.scope);
    const beforeCount = await draftCount(ctx.db, ctx.scope.workItemId);
    const saved = await editAuthorEditorialDraft({
      ...ctx.scope,
      ...tabEdit(before, "เนื้อหาก่อนจัดคิว", "column-guard-before-save"),
    });
    expect(saved.replayed).toBe(false);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeCount + 1);

    const undone = await undoAuthorEditorialDraft({
      ...ctx.scope,
      expectedDraftId: saved.draft.id,
      expectedDraftVersion: saved.draft.version,
      expectedDraftSha256: saved.draft.draftSha256,
      idempotencyKey: "column-guard-before-undo",
    });
    expect(undone.replayed).toBe(false);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeCount + 2);
  });

  it("replays the same save without another draft or a column change", async () => {
    const before = await getAuthorEditorialSurface(ctx.scope);
    const input = tabEdit(before, "เนื้อหาสำหรับ replay", "column-guard-replay");
    const beforeCount = await draftCount(ctx.db, ctx.scope.workItemId);
    const saved = await editAuthorEditorialDraft({ ...ctx.scope, ...input });
    const replayed = await editAuthorEditorialDraft({ ...ctx.scope, ...input });
    expect(replayed.replayed).toBe(true);
    expect(replayed.draft.id).toBe(saved.draft.id);
    expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeCount + 1);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
  });

  it("rejects a stale draft without writing or moving the card", async () => {
    const before = await getAuthorEditorialSurface(ctx.scope);
    const beforeCount = await draftCount(ctx.db, ctx.scope.workItemId);
    const input = tabEdit(before, "เนื้อหาที่ไม่อัปเดต", "column-guard-stale");
    await expect(editAuthorEditorialDraft({
      ...ctx.scope,
      ...input,
      expectedDraftSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeCount);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    expect((await getAuthorEditorialSurface(ctx.scope)).draft?.id).toBe(before.draft!.id);
  });

  it("rejects a revoked owner without writing", async () => {
    const before = await getAuthorEditorialSurface(ctx.scope);
    const beforeCount = await draftCount(ctx.db, ctx.scope.workItemId);
    await ctx.db.update(novels).set({ authorUserId: ctx.otherAuthorId }).where(eq(novels.id, ctx.novelId));
    try {
      await expect(editAuthorEditorialDraft({
        ...ctx.scope,
        ...tabEdit(before, "เนื้อหาหลังโอนสิทธิ์", "column-guard-revoked"),
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeCount);
      expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    } finally {
      await ctx.db.update(novels).set({ authorUserId: ctx.authorId }).where(eq(novels.id, ctx.novelId));
    }
  });
});

describe("IPE-070R4B author save and undo after stage or publish", () => {
  let ctx: Fixture;
  let editInput: ReturnType<typeof tabEdit>;
  let episodeId: number;
  let stagedEpisode: { title: string; content: string | null; isPublished: boolean };

  beforeAll(async () => {
    ctx = await buildFixture("after-stage");
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "editing");
    const before = await getAuthorEditorialSurface(ctx.scope);
    editInput = tabEdit(before, "เนื้อหาที่ผู้เขียนแก้", "column-guard-stage-edit");
    const edited = await editAuthorEditorialDraft({ ...ctx.scope, ...editInput });
    await runAuthorEditorialChecker({ ...ctx.scope, expectedDraftId: edited.draft.id });
    const ready = await getAuthorEditorialSurface(ctx.scope);
    if (!ready.approval.qcReady) throw new Error(`QC was not ready: ${ready.approval.qcReason}`);
    const approved = await approveAuthorEditorialDraft({
      ...ctx.scope,
      expectedDraftId: ready.draft!.id,
      expectedDraftVersion: ready.draft!.version,
      expectedDraftSha256: ready.draft!.draftSha256,
      expectedCheckerRunId: ready.approval.checkerRunId!,
      expectedQcEvidenceSha256: ready.approval.qcEvidenceSha256!,
      idempotencyKey: "column-guard-approve",
    });
    const staged = await stageAuthorEditorialDraft({
      ...ctx.scope,
      approvalId: approved.approval.id,
      expectedDraftId: ready.draft!.id,
      expectedDraftVersion: ready.draft!.version,
      expectedDraftSha256: ready.draft!.draftSha256,
      idempotencyKey: "column-guard-stage",
    });
    episodeId = staged.episode.id;
    stagedEpisode = {
      title: staged.episode.title,
      content: staged.episode.content,
      isPublished: staged.episode.isPublished,
    };
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("ready_to_publish");
  }, 60000);

  afterAll(async () => {
    await cleanup(ctx);
  });

  async function preserved() {
    return {
      draftId: (await getAuthorEditorialSurface(ctx.scope)).draft!.id,
      drafts: await draftCount(ctx.db, ctx.scope.workItemId),
      column: await columnKey(ctx.db, ctx.scope.workItemId),
      episode: await episodeRow(ctx.db, episodeId),
      stages: await stageRows(ctx.db, ctx.scope.workItemId),
    };
  }

  it("rejects save and undo after stage and keeps the episode", async () => {
    const before = await preserved();
    const surface = await getAuthorEditorialSurface(ctx.scope);
    await expect(editAuthorEditorialDraft({
      ...ctx.scope,
      ...tabEdit(surface, "เนื้อหาหลังจัดคิว", "column-guard-save-after-stage"),
    })).rejects.toMatchObject({ code: "BOARD_COLUMN_CONFLICT" });
    await expect(undoAuthorEditorialDraft({
      ...ctx.scope,
      expectedDraftId: surface.draft!.id,
      expectedDraftVersion: surface.draft!.version,
      expectedDraftSha256: surface.draft!.draftSha256,
      idempotencyKey: "column-guard-undo-after-stage",
    })).rejects.toMatchObject({ code: "BOARD_COLUMN_CONFLICT" });
    const after = await preserved();
    expect(after).toEqual(before);
    expect(after.column).toBe("ready_to_publish");
    expect(after.episode).toMatchObject(stagedEpisode);
  });

  it("rejects a stale draft on a staged card before the column guard", async () => {
    const before = await preserved();
    const surface = await getAuthorEditorialSurface(ctx.scope);
    await expect(editAuthorEditorialDraft({
      ...ctx.scope,
      ...tabEdit(surface, "เนื้อหาเก่า", "column-guard-stale-staged"),
      expectedDraftSha256: "b".repeat(64),
    })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    expect(await preserved()).toEqual(before);
  });

  it("replays the pre-stage save after the card is staged without moving it", async () => {
    const before = await preserved();
    const replayed = await editAuthorEditorialDraft({ ...ctx.scope, ...editInput });
    expect(replayed.replayed).toBe(true);
    expect(await preserved()).toEqual(before);
    expect((await preserved()).column).toBe("ready_to_publish");
  });

  async function raceSave(nextColumn: "ready_to_publish" | "published") {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "editing");
    const surface = await getAuthorEditorialSurface(ctx.scope);
    const beforeDrafts = await draftCount(ctx.db, ctx.scope.workItemId);
    const beforeEpisode = await episodeRow(ctx.db, episodeId);
    const beforeStages = await stageRows(ctx.db, ctx.scope.workItemId);
    const options = buildTestDbConnectionOptions(
      process.env.TEST_DATABASE_URL,
      parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT),
    );
    const nextId = await columnId(ctx.db, ctx.scope.workItemId, nextColumn);
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
      pending = editAuthorEditorialDraft({
        ...ctx.scope,
        ...tabEdit(surface, `เนื้อหาระหว่าง ${nextColumn}`, `column-guard-race-${nextColumn}`),
      }).finally(() => {
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
        [nextId, ctx.scope.workItemId],
      );
      await holder.commit();
      await expect(pending).rejects.toMatchObject({ code: "BOARD_COLUMN_CONFLICT" });
      pending = null;
      expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe(nextColumn);
      expect(await draftCount(ctx.db, ctx.scope.workItemId)).toBe(beforeDrafts);
      expect((await getAuthorEditorialSurface(ctx.scope)).draft?.id).toBe(surface.draft!.id);
      expect(await episodeRow(ctx.db, episodeId)).toEqual(beforeEpisode);
      expect(await stageRows(ctx.db, ctx.scope.workItemId)).toEqual(beforeStages);
    } finally {
      await holder.rollback().catch(() => undefined);
      await holder.end();
      await watcher.end();
      if (pending) await pending.catch(() => undefined);
    }
  }

  it("rejects a save that was waiting while stage committed ready_to_publish", async () => {
    await raceSave("ready_to_publish");
  }, 30000);

  it("rejects a save that was waiting while publish projection committed published", async () => {
    await raceSave("published");
  }, 30000);

  it("rejects save and undo after the card is published", async () => {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "published");
    const before = await preserved();
    const surface = await getAuthorEditorialSurface(ctx.scope);
    await expect(editAuthorEditorialDraft({
      ...ctx.scope,
      ...tabEdit(surface, "เนื้อหาหลังเผยแพร่", "column-guard-save-after-publish"),
    })).rejects.toMatchObject({ code: "BOARD_COLUMN_CONFLICT" });
    await expect(undoAuthorEditorialDraft({
      ...ctx.scope,
      expectedDraftId: surface.draft!.id,
      expectedDraftVersion: surface.draft!.version,
      expectedDraftSha256: surface.draft!.draftSha256,
      idempotencyKey: "column-guard-undo-after-publish",
    })).rejects.toMatchObject({ code: "BOARD_COLUMN_CONFLICT" });
    const after = await preserved();
    expect(after).toEqual(before);
    expect(after.column).toBe("published");
    expect(after.episode?.isPublished).toBe(stagedEpisode.isPublished);
  });

  it("rejects a revoked owner after stage without moving the card", async () => {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "ready_to_publish");
    const surface = await getAuthorEditorialSurface(ctx.scope);
    const before = {
      drafts: await draftCount(ctx.db, ctx.scope.workItemId),
      column: await columnKey(ctx.db, ctx.scope.workItemId),
      episode: await episodeRow(ctx.db, episodeId),
      stages: await stageRows(ctx.db, ctx.scope.workItemId),
    };
    await ctx.db.update(novels).set({ authorUserId: ctx.otherAuthorId }).where(eq(novels.id, ctx.novelId));
    try {
      await expect(editAuthorEditorialDraft({
        ...ctx.scope,
        ...tabEdit(surface, "เนื้อหาหลังถูกถอด", "column-guard-revoked-staged"),
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect({
        drafts: await draftCount(ctx.db, ctx.scope.workItemId),
        column: await columnKey(ctx.db, ctx.scope.workItemId),
        episode: await episodeRow(ctx.db, episodeId),
        stages: await stageRows(ctx.db, ctx.scope.workItemId),
      }).toEqual(before);
      expect(before.column).toBe("ready_to_publish");
    } finally {
      await ctx.db.update(novels).set({ authorUserId: ctx.authorId }).where(eq(novels.id, ctx.novelId));
    }
  });

  it("lets an admin revision leave the staged episode in place and move the card to editing", async () => {
    await moveCard(ctx.db, ctx.cardId, ctx.scope.workItemId, "ready_to_publish");
    const before = await preserved();
    const surface = await getAuthorEditorialSurface(ctx.scope);
    const edited = await applyEditorialEditorEdit({
      actorUserId: ctx.adminId,
      workspaceId: ctx.scope.workspaceId,
      workItemId: ctx.scope.workItemId,
      ...tabEdit(surface, "เนื้อหาที่แอดมินเปิดรอบแก้", "column-guard-admin-revision"),
    });
    expect(edited.replayed).toBe(false);
    expect(edited.draft.id).not.toBe(before.draftId);
    expect(await columnKey(ctx.db, ctx.scope.workItemId)).toBe("editing");
    const episode = await episodeRow(ctx.db, episodeId);
    expect(episode).toEqual(before.episode);
    expect(await stageRows(ctx.db, ctx.scope.workItemId)).toEqual(before.stages);
    expect(episode?.isPublished).toBe(stagedEpisode.isPublished);
  });
});
