import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  novels,
  users,
  workspaceKanbanCards,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  ensureEditorialBoard,
  getEditorialBoard,
} from "./editorialBoard.service";
import {
  importEditorialSource,
  getEditorialDraftReadModel,
} from "./editorialDraft.service";
import {
  applyEditorialEditorEdit,
  getEditorialEditorReadModel,
  undoEditorialEditorEdit,
} from "./editorialEditor.service";
import {
  getEditorialForeignCheckerReadModel,
  runEditorialForeignChecker,
} from "./editorialForeignChecker.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(paragraphs: string[]): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:editor-fixture",
    mimeType: "text/plain",
    title: "editor-fixture.txt",
    revisionKey: "editor-r1",
    tabs: [
      {
        sourceTabId: "file-main",
        tabOrder: 0,
        title: "editor-fixture.txt",
        paragraphs,
      },
    ],
  };
}

describe.sequential("Workspace Editorial editor integration", () => {
  it("creates CAS-bound manual versions, rechecks findings, supports replay/undo and projects Kanban", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial E");
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
        payload: source([
          "บทที่ 1 เริ่ม",
          "เขาบอกว่า テスト เรื่องนี้ให้เต็มที่",
        ]),
      });
      const initialDraftId = imported.latestDraftId!;
      const firstRun = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: initialDraftId,
      });
      const finding = firstRun.findings.find(
        (row: any) => row.token === "テスト"
      );
      expect(finding).toBeTruthy();

      const draftBefore = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const latestBefore = draftBefore.latestDraft!;
      const replacementSentence = finding.sentenceText.replace(
        "テスト",
        "ทดสอบ"
      );
      const editInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: latestBefore.id,
        expectedDraftVersion: latestBefore.version,
        expectedDraftSha256: latestBefore.draftSha256,
        findingId: finding.id,
        findingKey: finding.findingKey,
        command: {
          kind: "replace_sentence" as const,
          paragraphKey: finding.paragraphKey,
          expectedParagraphFingerprint: finding.paragraphFingerprint,
          startOffset: finding.sentenceStartOffset,
          endOffset: finding.sentenceEndOffset,
          expectedText: finding.sentenceText,
          replacementText: replacementSentence,
        },
        idempotencyKey: "editor-sentence-fixture-1",
      };
      const edited = await applyEditorialEditorEdit(editInput);
      expect(edited.replayed).toBe(false);
      expect(edited.draft.origin).toBe("manual");
      expect(edited.draft.version).toBe(latestBefore.version + 1);
      expect(edited.draft.parentDraftId).toBe(latestBefore.id);

      const replay = await applyEditorialEditorEdit(editInput);
      expect(replay.replayed).toBe(true);
      expect(replay.draft.id).toBe(edited.draft.id);

      const afterEdit = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(
        afterEdit.tabs[0].paragraphs.some((p: any) =>
          p.text.includes("ทดสอบ")
        )
      ).toBe(true);

      const staleChecker = await getEditorialForeignCheckerReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(staleChecker.run.draftId).not.toBe(afterEdit.latestDraft!.id);

      const secondRun = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: afterEdit.latestDraft!.id,
      });
      expect(
        secondRun.findings.some((row: any) => row.token === "テスト")
      ).toBe(false);
      expect(secondRun.effectiveStatus).toBe("passed");

      const afterCheckBoard = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      const cardAfterCheck = afterCheckBoard?.columns
        .flatMap(column => column.cards)
        .find(card => card.workItemId === workItemId);
      const columnAfterCheck = afterCheckBoard?.columns.find(column =>
        column.cards.some(card => card.workItemId === workItemId)
      );
      expect(cardAfterCheck).toBeTruthy();
      expect(columnAfterCheck?.key).toBe("pending_confirm");

      await expect(
        applyEditorialEditorEdit({
          ...editInput,
          idempotencyKey: "editor-stale-fixture",
        })
      ).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

      const editorModel = await getEditorialEditorReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(editorModel.canUndo).toBe(true);
      expect(editorModel.history[0].toDraftId).toBe(afterEdit.latestDraft!.id);

      const undone = await undoEditorialEditorEdit({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: afterEdit.latestDraft!.id,
        expectedDraftVersion: afterEdit.latestDraft!.version,
        expectedDraftSha256: afterEdit.latestDraft!.draftSha256,
        idempotencyKey: "editor-undo-fixture-1",
      });
      expect(undone.draft.version).toBe(afterEdit.latestDraft!.version + 1);

      const afterUndo = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(
        afterUndo.tabs[0].paragraphs.some((p: any) =>
          p.text.includes("テスト")
        )
      ).toBe(true);
      const undoRun = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: afterUndo.latestDraft!.id,
      });
      expect(undoRun.findings.some((row: any) => row.token === "テスト")).toBe(
        true
      );
      const boardAfterUndoCheck = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(
        boardAfterUndoCheck?.columns.find(column =>
          column.cards.some(card => card.workItemId === workItemId)
        )?.key
      ).toBe("needs_fix");

      await expect(
        getEditorialEditorReadModel({
          actorUserId: outsider.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        })
      ).rejects.toBeTruthy();
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
      await db.delete(users).where(eq(users.id, outsider.id));
    }
  });
});
