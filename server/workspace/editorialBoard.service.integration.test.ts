import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { novels, users, workspaceWorkspaces } from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  ensureEditorialBoard,
  getEditorialBoard,
} from "./editorialBoard.service";
import { transitionKanbanCard } from "./checkerKanban.service";
import {
  bindPublicationNovel,
  createWorkspace,
  listPublicationNovelOptions,
} from "./service";

describe.sequential("Workspace Editorial Kanban B1 integration", () => {
  it("idempotently materializes bound novels as NEW STORY cards and preserves later transitions", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial B1");

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
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
