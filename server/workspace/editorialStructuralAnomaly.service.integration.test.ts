import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  novels,
  users,
  workspaceEditorialCheckerAnomalies,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource } from "./editorialDraft.service";
import {
  getEditorialForeignCheckerReadModel,
  runEditorialForeignChecker,
} from "./editorialForeignChecker.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:structural-anomaly-fixture",
    mimeType: "text/plain",
    title: "structural-anomaly-fixture.txt",
    revisionKey: "structural-anomaly-r1",
    tabs: [
      {
        sourceTabId: "tab-46",
        tabOrder: 0,
        title: "บทที่ 46",
        paragraphs: [
          "บทที่ 46",
          "เนื้อเรื่องปกติของบทที่สี่สิบหกซึ่งมีรายละเอียดเพียงพอสำหรับการตรวจโครงสร้าง",
        ],
      },
      {
        sourceTabId: "tab-47",
        tabOrder: 1,
        title: "แท็บ 2",
        paragraphs: ["จบตอน"],
      },
      {
        sourceTabId: "tab-48",
        tabOrder: 2,
        title: "บทที่ 48 หมายเหตุต้นฉบับ",
        paragraphs: ["บทที่ 48 หมายเหตุต้นฉบับ", "จบตอน"],
      },
      {
        sourceTabId: "tab-49",
        tabOrder: 3,
        title: "บทที่ 49",
        paragraphs: ["บทที่ 49", "จบตอน"],
      },
      {
        sourceTabId: "tab-50",
        tabOrder: 4,
        title: "บทที่ 50",
        paragraphs: [
          "บทที่ 50",
          "เนื้อเรื่องปกติของบทที่ห้าสิบซึ่งแตกต่างจากบทอื่นอย่างชัดเจน",
        ],
      },
    ],
  };
}

describe.sequential("Workspace Editorial structural anomaly integration", () => {
  it("persists per-run tab/anomaly evidence and blocks QC on structural errors", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial Structural");
    let boardId: number | null = null;

    try {
      await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const board = await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      boardId = board?.board.id ?? null;
      const storyCard = board?.columns
        .flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_STORY");
      expect(storyCard?.workItemId).toBeTruthy();
      const workItemId = storyCard!.workItemId!;

      await db
        .update(workspaceEditorialWorkItems)
        .set({ episodeNumber: "46-50" })
        .where(eq(workspaceEditorialWorkItems.id, workItemId));

      const imported = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source(),
      });

      const checked = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: imported.latestDraftId!,
      });

      expect(checked.run.engineVersion).toBe(
        "workspace-editorial-foreign-checker-v5"
      );
      expect(checked.structuralSummary).toMatchObject({
        tabCount: 5,
        expectedTabCount: 5,
      });
      expect(checked.anomalies.some(
        (row: any) => row.anomalyType === "end_only_tab"
      )).toBe(true);
      expect(checked.anomalies.some(
        (row: any) =>
          row.anomalyType === "missing_expected_chapter" &&
          row.chapterNumber === "47"
      )).toBe(true);
      expect(checked.anomalies.some(
        (row: any) => row.anomalyType === "source_note_only"
      )).toBe(true);
      expect(checked.anomalies.some(
        (row: any) => row.anomalyType === "heading_only_tab"
      )).toBe(true);
      expect(checked.blockingIssueCount).toBeGreaterThan(0);
      expect(checked.effectiveStatus).toBe("failed");

      const persisted = await db
        .select()
        .from(workspaceEditorialCheckerAnomalies)
        .where(eq(workspaceEditorialCheckerAnomalies.runId, checked.run.id));
      expect(persisted.length).toBe(4);

      const readModel = await getEditorialForeignCheckerReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        runId: checked.run.id,
      });
      expect(readModel.structuralSummary?.tabCount).toBe(5);
      expect(readModel.anomalies).toHaveLength(4);
      expect(readModel.effectiveStatus).toBe("failed");
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
});
