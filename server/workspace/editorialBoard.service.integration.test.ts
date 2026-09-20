import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceKanbanCards,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  assignEditorialWorkItem,
  createEditorialEpisodeWorkItem,
  ensureEditorialBoard,
  getEditorialBoard,
  listEditorialAssignees,
} from "./editorialBoard.service";
import { transitionKanbanCard } from "./checkerKanban.service";
import {
  bindPublicationNovel,
  createWorkspace,
  createWorkspacePublicationNovel,
  listPublicationNovelOptions,
} from "./service";

describe.sequential("Workspace Editorial Kanban B1/B2 integration", () => {
  it("idempotently materializes bound novels as NEW STORY cards and preserves later transitions", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial B1");
    let boardId: number | null = null;

    try {
      await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });

      const first = await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      boardId = first?.board.id ?? null;
      const second = await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });

      expect(first?.board.id).toBe(second?.board.id);
      expect(first?.columns.map(column => column.key)).toEqual([
        "new",
        "pending_check",
        "needs_fix",
        "editing",
        "pending_confirm",
        "ready_to_publish",
        "published",
      ]);
      const storyCard = first?.columns.flatMap(column => column.cards)[0];
      expect(storyCard?.workItemType).toBe("NEW_STORY");
      expect(storyCard?.novel?.id).toBe(novel.id);

      await transitionKanbanCard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        cardId: storyCard!.id,
        toColumnKey: "pending_check",
        reason: "integration_move",
        idempotencyKey: "editorial-b1-move",
        expectedVersion: storyCard!.version,
      });

      await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      const afterMove = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(
        afterMove?.columns.find(column => column.key === "pending_check")?.cards
      ).toHaveLength(1);
      expect(afterMove?.transitions).toHaveLength(2);

      const options = await listPublicationNovelOptions(
        owner.id,
        workspace.workspaceId
      );
      expect(options.find(option => option.id === novel.id)?.bound).toBe(true);
    } finally {
      if (boardId) {
        await db
          .delete(workspaceKanbanCards)
          .where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  it("creates hidden novels, durable NEW EPISODE items, admin assignments and combined history", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const assignee = await createTestUser({ role: "admin" });
    const outsider = await createTestUser();
    const workspace = await createWorkspace(owner.id, "Editorial B2");
    let createdNovelId: number | undefined;
    let boardId: number | null = null;

    try {
      const createdNovel = await createWorkspacePublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        title: "เรื่องใหม่ B2",
      });
      createdNovelId = createdNovel.novelId;
      expect(createdNovel.publicationStatus).toBe("archived");

      const board = await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      boardId = board?.board.id ?? null;
      const storyCard = board?.columns.flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_STORY");
      expect(storyCard?.workItemId).toBeTruthy();

      const firstEpisode = await createEditorialEpisodeWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: createdNovel.workspaceNovelId,
        episodeNumber: "  ตอน  10 ",
        episodeTitle: "เริ่มต้น",
        saleMode: "package",
        price: "35.00",
        isFree: false,
        assigneeUserId: null,
      });
      const sameEpisode = await createEditorialEpisodeWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: createdNovel.workspaceNovelId,
        episodeNumber: "ตอน 10",
        episodeTitle: "เริ่มต้น",
        saleMode: "package",
        price: "35.00",
        isFree: false,
        assigneeUserId: null,
      });
      expect(firstEpisode.created).toBe(true);
      expect(sameEpisode.created).toBe(false);

      const episodeCard = firstEpisode.board?.columns.flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_EPISODE");
      expect(episodeCard?.episodeNumber).toBe("ตอน  10");
      expect(episodeCard?.episodeTitle).toBe("เริ่มต้น");

      const assigned = await assignEditorialWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId: episodeCard!.workItemId,
        assigneeUserId: assignee.id,
        expectedVersion: episodeCard!.workItemVersion,
        idempotencyKey: "b2-assign-1",
      });
      expect(assigned.replayed).toBe(false);
      const replay = await assignEditorialWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId: episodeCard!.workItemId,
        assigneeUserId: assignee.id,
        expectedVersion: episodeCard!.workItemVersion,
        idempotencyKey: "b2-assign-1",
      });
      expect(replay.replayed).toBe(true);

      await expect(
        assignEditorialWorkItem({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId: episodeCard!.workItemId,
          assigneeUserId: outsider.id,
          expectedVersion: assigned.workItem.version,
          idempotencyKey: "b2-invalid-assignee",
        })
      ).rejects.toMatchObject({ code: "EDITORIAL_ASSIGNEE_INVALID" });

      const after = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      const assignedCard = after?.columns.flatMap(column => column.cards)
        .find(card => card.workItemId === episodeCard!.workItemId);
      expect(assignedCard?.assigneeUserId).toBe(assignee.id);
      expect(assignedCard?.history.some(entry => entry.eventType === "assignee_changed")).toBe(true);

      const assignees = await listEditorialAssignees({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(assignees.map(row => row.id)).toEqual(
        expect.arrayContaining([owner.id, assignee.id])
      );
      expect(assignees.map(row => row.id)).not.toContain(outsider.id);

      const publicationEpisodes = await db
        .select()
        .from(episodes)
        .where(eq(episodes.novelId, createdNovel.novelId));
      expect(publicationEpisodes).toHaveLength(0);
    } finally {
      if (boardId) {
        await db
          .delete(workspaceKanbanCards)
          .where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      if (createdNovelId) {
        await db.delete(novels).where(eq(novels.id, createdNovelId));
      }
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, assignee.id));
      await db.delete(users).where(eq(users.id, outsider.id));
    }
  });
});
