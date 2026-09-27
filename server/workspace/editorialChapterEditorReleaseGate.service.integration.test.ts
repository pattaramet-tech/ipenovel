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
  approveEditorialDraft,
  getEditorialApprovalReadModel,
  stageEditorialEpisodeDraft,
} from "./editorialApproval.service";
import {
  createEditorialEpisodeWorkItem,
  ensureEditorialBoard,
} from "./editorialBoard.service";
import {
  getEditorialDraftReadModel,
  importEditorialSource,
} from "./editorialDraft.service";
import { applyEditorialEditorEdit } from "./editorialEditor.service";
import {
  runEditorialForeignChecker,
  setEditorialStructuralConfirmation,
} from "./editorialForeignChecker.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:m29-3-7-release-gate",
    mimeType: "text/plain",
    title: "episode-12-source-note.txt",
    revisionKey: "m29-3-7-r1",
    tabs: [
      {
        sourceTabId: "release-gate-tab-12",
        tabOrder: 0,
        title: "หมายเหตุต้นฉบับ",
        paragraphs: ["หมายเหตุต้นฉบับ テスト", "จบตอน"],
      },
    ],
  };
}

describe.sequential("M29.3.7 Chapter Editor release gate integration", () => {
  it("edits a whole chapter, reruns QC, confirms source-note structure, then requires approval before unpublished staging", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M29.3.7 release gate");
    let boardId: number | null = null;

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const board = await ensureEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      boardId = board?.board.id ?? null;

      const created = await createEditorialEpisodeWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        episodeNumber: "12",
        episodeTitle: "หมายเหตุต้นฉบับ",
        saleMode: "package",
        price: "12.00",
        isFree: false,
      });
      const card = created.board?.columns
        .flatMap(column => column.cards)
        .find(
          item =>
            item.workItemType === "NEW_EPISODE" &&
            item.episodeNumber === "12"
        );
      expect(card?.workItemId).toBeTruthy();
      const workItemId = card!.workItemId!;

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
      expect(firstRun.findings.some((row: any) => row.token === "テスト")).toBe(
        true
      );
      expect(
        firstRun.anomalies.some(
          (row: any) =>
            row.anomalyType === "source_note_only" &&
            row.disposition === "open"
        )
      ).toBe(true);
      expect(firstRun.effectiveStatus).toBe("failed");

      const draftBefore = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const tab = draftBefore.tabs[0]!;
      const expectedText = tab.paragraphs
        .slice()
        .sort((a: any, b: any) => a.paragraphOrder - b.paragraphOrder)
        .map((paragraph: any) => String(paragraph.text ?? "").trim())
        .filter(Boolean)
        .join("\n\n");

      const edited = await applyEditorialEditorEdit({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: draftBefore.latestDraft!.id,
        expectedDraftVersion: draftBefore.latestDraft!.version,
        expectedDraftSha256: draftBefore.latestDraft!.draftSha256,
        command: {
          kind: "replace_tab",
          sourceTabId: tab.sourceTabId,
          expectedTabStructuralSha256: tab.structuralSha256,
          expectedText,
          replacementText: "หมายเหตุต้นฉบับ\n\nจบตอน",
        },
        idempotencyKey: "m29-3-7-replace-tab",
      });
      expect(edited.draft.origin).toBe("manual");

      const secondRun = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: edited.draft.id,
      });
      expect(secondRun.findings.some((row: any) => row.token === "テスト")).toBe(
        false
      );
      const sourceNote = secondRun.anomalies.find(
        (row: any) => row.anomalyType === "source_note_only"
      );
      expect(sourceNote).toBeTruthy();
      expect(sourceNote.disposition).toBe("open");
      expect(secondRun.blockingIssueCount).toBeGreaterThan(0);

      const blocked = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(blocked.qc.ready).toBe(false);
      await expect(
        approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: blocked.latestDraft!.id,
          expectedDraftVersion: blocked.latestDraft!.version,
          expectedDraftSha256: blocked.latestDraft!.draftSha256,
          expectedCheckerRunId: blocked.qc.checkerRunId!,
          expectedQcEvidenceSha256: blocked.qc.qcEvidenceSha256!,
          idempotencyKey: "m29-3-7-approve-blocked",
        })
      ).rejects.toMatchObject({ code: "QC_UNRESOLVED" });

      const confirmed = await setEditorialStructuralConfirmation({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        anomalyId: sourceNote.id,
        confirmed: true,
        expectedVersion: sourceNote.confirmationVersion ?? 0,
      });
      expect(
        confirmed.anomalies.find(
          (row: any) => row.anomalyType === "source_note_only"
        )?.disposition
      ).toBe("confirmed_source_note");
      expect(confirmed.blockingIssueCount).toBe(0);
      expect(confirmed.effectiveStatus).toBe("passed");

      const ready = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(ready.qc.ready).toBe(true);
      const approved = await approveEditorialDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: ready.latestDraft!.id,
        expectedDraftVersion: ready.latestDraft!.version,
        expectedDraftSha256: ready.latestDraft!.draftSha256,
        expectedCheckerRunId: ready.qc.checkerRunId!,
        expectedQcEvidenceSha256: ready.qc.qcEvidenceSha256!,
        idempotencyKey: "m29-3-7-approve-confirmed",
      });
      expect(approved.readModel.approvalStatus.valid).toBe(true);

      const staged = await stageEditorialEpisodeDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        approvalId: approved.approval.id,
        expectedDraftId: ready.latestDraft!.id,
        expectedDraftVersion: ready.latestDraft!.version,
        expectedDraftSha256: ready.latestDraft!.draftSha256,
        idempotencyKey: "m29-3-7-stage",
      });
      expect(staged.episode.isPublished).toBe(false);
      expect(staged.episode.publishedAt).toBeNull();
      expect(staged.readModel.readyToPublish).toBe(true);
    } finally {
      if (boardId) {
        await db
          .delete(workspaceKanbanCards)
          .where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(episodes).where(eq(episodes.novelId, novel.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
