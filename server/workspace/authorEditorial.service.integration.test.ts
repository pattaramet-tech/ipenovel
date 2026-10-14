import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { novels, users, workspaceKanbanCards, workspaceMembers, workspaceWorkspaces } from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { getTestDb } from "../test-helpers/testDb";
import {
  approveAuthorEditorialDraft,
  editAuthorEditorialDraft,
  getAuthorEditorialSurface,
  runAuthorEditorialChecker,
  stageAuthorEditorialDraft,
} from "./authorEditorial.service";
import { createEditorialEpisodeWorkItem, ensureEditorialBoard } from "./editorialBoard.service";
import { importEditorialSource, type EditorialSourcePayload } from "./editorialDraft.service";
import { requestEditorialPublish } from "./editorialPublish.service";
import { bindPublicationNovel, createWorkspace } from "./service";

function source(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:author-r4b-fixture",
    mimeType: "text/plain",
    title: "episode-12.txt",
    revisionKey: "author-r4b",
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 12",
      paragraphs: ["บทที่ 12 ชื่อบท", "เนื้อหาสะอาดไม่มี finding", "จบตอน"],
    }],
  };
}

describe("IPE-070R4B author edit QC approve stage", () => {
  it("lets the owning author edit, check, approve, and stage, and rejects everyone else", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const admin = await createTestUser({ role: "admin" });
    const author = await createTestUser({ role: "author" });
    const otherAuthor = await createTestUser({ role: "author" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(admin.id, "Author R4B");
    let boardId: number | null = null;
    try {
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
      boardId = board?.board.id ?? null;
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
      await expect(getAuthorEditorialSurface({
        actorUserId: otherAuthor.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });

      const before = await getAuthorEditorialSurface(scope);
      const tab = before.tabs[0];
      const expectedText = tab.paragraphs.map(paragraph => paragraph.text).join("\n\n");
      const replacementText = expectedText.replace("เนื้อหาสะอาดไม่มี finding", "เนื้อหาที่ผู้เขียนแก้");
      const edited = await editAuthorEditorialDraft({
        ...scope,
        expectedDraftId: before.draft!.id,
        expectedDraftVersion: before.draft!.version,
        expectedDraftSha256: before.draft!.draftSha256,
        command: {
          kind: "replace_tab",
          sourceTabId: tab.sourceTabId,
          expectedTabStructuralSha256: tab.structuralSha256,
          expectedText,
          replacementText,
          replacementParagraphKeys: tab.paragraphs.map(paragraph => paragraph.paragraphKey),
        },
        idempotencyKey: `author-r4b-edit-${before.draft!.id}`,
      });
      expect(edited.replayed).toBe(false);
      expect(edited.draft.draftSha256).not.toBe(before.draft!.draftSha256);
      const replayedEdit = await editAuthorEditorialDraft({
        ...scope,
        expectedDraftId: before.draft!.id,
        expectedDraftVersion: before.draft!.version,
        expectedDraftSha256: before.draft!.draftSha256,
        command: {
          kind: "replace_tab",
          sourceTabId: tab.sourceTabId,
          expectedTabStructuralSha256: tab.structuralSha256,
          expectedText,
          replacementText,
          replacementParagraphKeys: tab.paragraphs.map(paragraph => paragraph.paragraphKey),
        },
        idempotencyKey: `author-r4b-edit-${before.draft!.id}`,
      });
      expect(replayedEdit.replayed).toBe(true);
      expect(replayedEdit.draft.id).toBe(edited.draft.id);

      const checked = await runAuthorEditorialChecker({
        ...scope,
        expectedDraftId: edited.draft.id,
      });
      expect(checked.created).toBe(true);
      const ready = await getAuthorEditorialSurface(scope);
      expect(ready.approval.qcReady).toBe(true);
      expect(ready.publishAvailable).toBe(false);
      const approved = await approveAuthorEditorialDraft({
        ...scope,
        expectedDraftId: ready.draft!.id,
        expectedDraftVersion: ready.draft!.version,
        expectedDraftSha256: ready.draft!.draftSha256,
        expectedCheckerRunId: ready.approval.checkerRunId!,
        expectedQcEvidenceSha256: ready.approval.qcEvidenceSha256!,
        idempotencyKey: `author-r4b-approve-${ready.draft!.id}`,
      });
      expect(approved.replayed).toBe(false);
      const approvedSurface = await getAuthorEditorialSurface(scope);
      expect(approvedSurface.approval.stageReady).toBe(false);
      expect(approvedSurface.approval.stageActionReady).toBe(true);
      expect(approvedSurface.approval.stageActionReason).toBeNull();
      const staged = await stageAuthorEditorialDraft({
        ...scope,
        approvalId: approved.approval.id,
        expectedDraftId: ready.draft!.id,
        expectedDraftVersion: ready.draft!.version,
        expectedDraftSha256: ready.draft!.draftSha256,
        idempotencyKey: `author-r4b-stage-${approved.approval.id}`,
      });
      expect(staged.replayed).toBe(false);
      expect(staged.readModel.stageStatus.valid).toBe(true);
      const stagedAgain = await stageAuthorEditorialDraft({
        ...scope,
        approvalId: approved.approval.id,
        expectedDraftId: ready.draft!.id,
        expectedDraftVersion: ready.draft!.version,
        expectedDraftSha256: ready.draft!.draftSha256,
        idempotencyKey: `author-r4b-stage-${approved.approval.id}`,
      });
      expect(stagedAgain.replayed).toBe(true);
      const stagedSurface = await getAuthorEditorialSurface(scope);
      expect(stagedSurface.approval.stageReady).toBe(true);
      expect(stagedSurface.approval.stageActionReady).toBe(true);
      const staleTab = stagedSurface.tabs[0]!;
      const staleBaseline = staleTab.paragraphs.map(paragraph => paragraph.text).join("\n\n");
      await editAuthorEditorialDraft({
        ...scope,
        expectedDraftId: stagedSurface.draft!.id,
        expectedDraftVersion: stagedSurface.draft!.version,
        expectedDraftSha256: stagedSurface.draft!.draftSha256,
        command: {
          kind: "replace_tab",
          sourceTabId: staleTab.sourceTabId,
          expectedTabStructuralSha256: staleTab.structuralSha256,
          expectedText: staleBaseline,
          replacementText: staleBaseline.replace("เนื้อหาที่ผู้เขียนแก้", "เนื้อหาหลังอนุมัติ"),
          replacementParagraphKeys: staleTab.paragraphs.map(paragraph => paragraph.paragraphKey),
        },
        idempotencyKey: `author-r4b-stale-${stagedSurface.draft!.id}`,
      });
      const stale = await getAuthorEditorialSurface(scope);
      expect(stale.approval.stageReady).toBe(false);
      expect(stale.approval.stageActionReady).toBe(false);
      expect(stale.approval.stageActionReason).toContain("draft changed");

      await expect(requestEditorialPublish({
        actorUserId: author.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageSetSha256: "a".repeat(64),
        expectedStagedDraftSha256: "b".repeat(64),
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: false,
      })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });

      await db.update(users).set({ role: "user" }).where(eq(users.id, author.id));
      await expect(getAuthorEditorialSurface(scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await db.update(users).set({ role: "author" }).where(eq(users.id, author.id));
      await db.update(novels).set({ authorUserId: otherAuthor.id }).where(eq(novels.id, novel.id));
      await expect(editAuthorEditorialDraft({
        ...scope,
        expectedDraftId: ready.draft!.id,
        expectedDraftVersion: ready.draft!.version,
        expectedDraftSha256: ready.draft!.draftSha256,
        command: {
          kind: "replace_tab",
          sourceTabId: tab.sourceTabId,
          expectedTabStructuralSha256: tab.structuralSha256,
          expectedText,
          replacementText,
          replacementParagraphKeys: tab.paragraphs.map(paragraph => paragraph.paragraphKey),
        },
        idempotencyKey: `author-r4b-edit-after-transfer-${ready.draft!.id}`,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      if (boardId) {
        await db.delete(workspaceKanbanCards).where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, admin.id));
      await db.delete(users).where(eq(users.id, author.id));
      await db.delete(users).where(eq(users.id, otherAuthor.id));
    }
  }, 60000);
});
