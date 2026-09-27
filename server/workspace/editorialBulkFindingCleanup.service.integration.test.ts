import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  novels,
  users,
  workspaceAuditEvents,
  workspaceEditorialDraftEditEvents,
  workspaceKanbanCards,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  applyEditorialBulkFindingCleanup,
  previewEditorialBulkFindingCleanup,
} from "./editorialBulkFindingCleanup.service";
import { ensureEditorialBoard } from "./editorialBoard.service";
import {
  getEditorialDraftReadModel,
  importEditorialSource,
} from "./editorialDraft.service";
import {
  getEditorialEditorReadModel,
  undoEditorialEditorEdit,
} from "./editorialEditor.service";
import { runEditorialForeignChecker } from "./editorialForeignChecker.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:bulk-cleanup-fixture",
    mimeType: "text/plain",
    title: "bulk-cleanup-fixture.txt",
    revisionKey: "bulk-cleanup-r1",
    tabs: [
      {
        sourceTabId: "tab-74",
        tabOrder: 0,
        title: "บทที่ 74",
        paragraphs: [
          "บทที่ 74",
          "เนื้อหาปกติของตอน",
          "ความคิดของผู้สร้าง",
          "alex02373",
          "alex02373",
          "จบตอน",
        ],
      },
    ],
  };
}

describe.sequential("Workspace Editorial Bulk Finding Cleanup integration", () => {
  it("groups, bulk-deletes into one Draft, reruns once, guards stale preview, and supports undo", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial M29.1");
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

      const imported = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source(),
      });
      const firstRun = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: imported.latestDraftId!,
      });
      expect(firstRun.unresolvedCount).toBe(4);

      const preview = await previewEditorialBulkFindingCleanup({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemIds: [workItemId],
      });
      expect(preview.summary.openFindingCount).toBe(4);
      expect(preview.sourceJunk.occurrenceCount).toBe(4);
      const alexGroup = preview.groups.find(
        group => group.displayToken === "alex02373"
      );
      expect(alexGroup).toMatchObject({
        ruleKey: "source_junk",
        occurrenceCount: 2,
        paragraphCount: 2,
        workItemCount: 1,
      });

      const before = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const exact = await applyEditorialBulkFindingCleanup({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemIds: [workItemId],
        expectedPreviewFingerprint: preview.previewFingerprint,
        action: { kind: "group", groupKey: alexGroup!.groupKey },
      });
      expect(exact.summary).toMatchObject({
        changed: 1,
        failed: 0,
        removedFindings: 2,
        removedParagraphs: 2,
      });

      const afterExact = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(afterExact.latestDraft!.version).toBe(
        before.latestDraft!.version + 1
      );
      expect(
        afterExact.tabs[0].paragraphs.some(
          (paragraph: any) => paragraph.text === "alex02373"
        )
      ).toBe(false);

      const editEventsAfterExact = await db
        .select()
        .from(workspaceEditorialDraftEditEvents)
        .where(
          and(
            eq(workspaceEditorialDraftEditEvents.workItemId, workItemId),
            eq(workspaceEditorialDraftEditEvents.editKind, "bulk_cleanup")
          )
        );
      expect(editEventsAfterExact).toHaveLength(1);

      await expect(
        applyEditorialBulkFindingCleanup({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemIds: [workItemId],
          expectedPreviewFingerprint: preview.previewFingerprint,
          action: { kind: "group", groupKey: alexGroup!.groupKey },
        })
      ).rejects.toMatchObject({ code: "PREVIEW_STALE" });

      const preview2 = await previewEditorialBulkFindingCleanup({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemIds: [workItemId],
      });
      expect(preview2.sourceJunk.occurrenceCount).toBe(2);

      const junk = await applyEditorialBulkFindingCleanup({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemIds: [workItemId],
        expectedPreviewFingerprint: preview2.previewFingerprint,
        action: { kind: "source_junk" },
      });
      expect(junk.summary).toMatchObject({
        changed: 1,
        failed: 0,
        removedFindings: 2,
        removedParagraphs: 2,
        remainingOpenFindings: 0,
      });

      const afterJunk = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(afterJunk.tabs[0].paragraphs.map((row: any) => row.text)).toEqual([
        "บทที่ 74",
        "เนื้อหาปกติของตอน",
      ]);
      expect(afterJunk.latestDraft!.version).toBe(
        afterExact.latestDraft!.version + 1
      );

      const editEvents = await db
        .select()
        .from(workspaceEditorialDraftEditEvents)
        .where(
          and(
            eq(workspaceEditorialDraftEditEvents.workItemId, workItemId),
            eq(workspaceEditorialDraftEditEvents.editKind, "bulk_cleanup")
          )
        );
      expect(editEvents).toHaveLength(2);

      const audits = await db
        .select()
        .from(workspaceAuditEvents)
        .where(
          and(
            eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
            eq(
              workspaceAuditEvents.eventType,
              "workspace_editorial_bulk_cleanup_v1"
            )
          )
        );
      expect(audits).toHaveLength(2);
      expect(audits.every(row => !row.metadataJson.includes("alex02373"))).toBe(
        true
      );

      const editor = await getEditorialEditorReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(editor.canUndo).toBe(true);
      expect(editor.lastEdit?.editKind).toBe("bulk_cleanup");

      const undone = await undoEditorialEditorEdit({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: afterJunk.latestDraft!.id,
        expectedDraftVersion: afterJunk.latestDraft!.version,
        expectedDraftSha256: afterJunk.latestDraft!.draftSha256,
        idempotencyKey: "bulk-cleanup-undo-fixture",
      });
      expect(undone.draft.version).toBe(afterJunk.latestDraft!.version + 1);

      const afterUndo = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(afterUndo.tabs[0].paragraphs.map((row: any) => row.text)).toEqual([
        "บทที่ 74",
        "เนื้อหาปกติของตอน",
        "ความคิดของผู้สร้าง",
        "จบตอน",
      ]);
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
