import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  episodes,
  novels,
  users,
  workspaceGoogleConnections,
  workspaceKanbanCards,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import {
  approveEditorialDraft,
  getEditorialApprovalReadModel,
  stageEditorialEpisodeDraft,
} from "./editorialApproval.service";
import {
  createEditorialEpisodeWorkItem,
  ensureEditorialBoard,
  getEditorialBoard,
} from "./editorialBoard.service";
import {
  getEditorialDraftReadModel,
  importEditorialSource,
} from "./editorialDraft.service";
import { applyEditorialEditorEdit } from "./editorialEditor.service";
import { runEditorialForeignChecker } from "./editorialForeignChecker.service";
import {
  getEditorialPublishReadModel,
  requestEditorialPublish,
} from "./editorialPublish.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import { runScopedPublishWorkerOnce } from "./publishExecution.runtime";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(revisionKey: string, bodyText: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:ipe055g-fixture",
    mimeType: "text/plain",
    title: "episode-55.txt",
    revisionKey,
    tabs: [{
      sourceTabId: "file-main",
      tabOrder: 0,
      title: "ตอนที่ 55",
      paragraphs: ["ตอนที่ 55 ทดสอบเผยแพร่", bodyText, "จบตอน"],
    }],
  };
}

describe.sequential("IPE-055-G Controlled Publish integration", () => {
  it("blocks stale Editorial state before provider execution, then publishes durably and projects Kanban once", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "IPE-055-G controlled publish");
    let stagedEpisodeId: number | null = null;
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
      const story = board?.columns.flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_STORY");
      expect(story?.workspaceNovelId).toBe(workspaceNovel.workspaceNovelId);

      const created = await createEditorialEpisodeWorkItem({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        episodeNumber: "55",
        episodeTitle: "Controlled Publish",
      });
      const workItem = created.board?.columns.flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_EPISODE" && card.episodeNumber === "55");
      expect(workItem?.workItemId).toBeTruthy();
      const workItemId = workItem!.workItemId!;

      const imported = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source("ipe055g-r1", "เนื้อหาฉบับแรก"),
      });
      await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: imported.latestDraftId!,
      });
      const approvalState = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const approved = await approveEditorialDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: approvalState.latestDraft!.id,
        expectedDraftVersion: approvalState.latestDraft!.version,
        expectedDraftSha256: approvalState.latestDraft!.draftSha256,
        expectedCheckerRunId: approvalState.qc.checkerRunId!,
        expectedQcEvidenceSha256: approvalState.qc.qcEvidenceSha256!,
        idempotencyKey: "ipe055g-approve-v1",
      });
      const staged = await stageEditorialEpisodeDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        approvalId: approved.approval.id,
        expectedDraftId: approvalState.latestDraft!.id,
        expectedDraftVersion: approvalState.latestDraft!.version,
        expectedDraftSha256: approvalState.latestDraft!.draftSha256,
        idempotencyKey: "ipe055g-stage-v1",
      });
      stagedEpisodeId = staged.episode.id;
      expect(staged.episode.isPublished).toBe(false);

      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "ipe055g-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_ipe055g_anchor",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "IPE-055-G publish anchor",
        role: "chapter",
        sequence: 1,
        correlationId: "ipe055g-bind",
      });
      await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "ipe055g-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_ipe055g_anchor",
            revision: "rev-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "IPE-055-G publish anchor",
          })),
          getNormalizedText: vi.fn(async () => "IPE-055-G publish anchor"),
          revoke: vi.fn(async () => undefined),
        },
      });
      await db.update(workspaceMigrationRegistry)
        .set({ owner: "workspace", cutoverEpoch: 1 })
        .where(and(
          eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
          eq(workspaceMigrationRegistry.capability, "publish")
        ));

      const readyV1 = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(readyV1).toMatchObject({
        requestReady: true,
        kanbanColumnKey: "ready_to_publish",
      });
      expect(readyV1.stage?.id).toBe(staged.stage.id);

      await expect(requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageId: staged.stage.id,
        expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
        expectedEpisodeStateSha256: staged.stage.episodeStateSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: false,
      })).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });

      const preparedV1 = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const staleRunId = preparedV1.publishRun!.id;
      await requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageId: staged.stage.id,
        expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
        expectedEpisodeStateSha256: staged.stage.episodeStateSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: true,
        executionScope: {
          workspaceId: workspace.workspaceId,
          workspaceNovelId: workspaceNovel.workspaceNovelId,
          runId: staleRunId,
          expectedCutoverEpoch: 1,
          expectedOwnershipVersion: 1,
        },
      });

      const draftV1 = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const body = draftV1.tabs[0].paragraphs.find(
        (paragraph: any) => paragraph.text === "เนื้อหาฉบับแรก"
      )!;
      const edited = await applyEditorialEditorEdit({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: draftV1.latestDraft!.id,
        expectedDraftVersion: draftV1.latestDraft!.version,
        expectedDraftSha256: draftV1.latestDraft!.draftSha256,
        command: {
          kind: "replace_paragraph",
          paragraphKey: body.paragraphKey,
          expectedParagraphFingerprint: body.paragraphFingerprint,
          expectedText: body.text,
          replacementText: "เนื้อหาฉบับแก้ไข",
        },
        idempotencyKey: "ipe055g-edit-v2",
      });

      const provider = createIpeNovelWorkspacePublishProvider();
      await expect(runScopedPublishWorkerOnce({
        scope: {
          workspaceId: workspace.workspaceId,
          workspaceNovelId: workspaceNovel.workspaceNovelId,
          runId: staleRunId,
          expectedCutoverEpoch: 1,
          expectedOwnershipVersion: 1,
        },
        leaseOwner: "ipe055g-stale-worker",
        provider,
        executionEnabled: true,
        allowExternalProvider: true,
      })).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
      expect((await db.select().from(episodes)
        .where(eq(episodes.id, staged.episode.id)))[0].isPublished).toBe(false);
      expect((await db.select().from(workspaceOutbox)
        .where(eq(workspaceOutbox.publishRunId, staleRunId)))[0].status).toBe("failed");

      const checkerV2 = await runEditorialForeignChecker({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: edited.draft.id,
      });
      expect(checkerV2.effectiveStatus).toBe("passed");
      const approvalV2 = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const approvedV2 = await approveEditorialDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedDraftId: approvalV2.latestDraft!.id,
        expectedDraftVersion: approvalV2.latestDraft!.version,
        expectedDraftSha256: approvalV2.latestDraft!.draftSha256,
        expectedCheckerRunId: approvalV2.qc.checkerRunId!,
        expectedQcEvidenceSha256: approvalV2.qc.qcEvidenceSha256!,
        idempotencyKey: "ipe055g-approve-v2",
      });
      const stagedV2 = await stageEditorialEpisodeDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        approvalId: approvedV2.approval.id,
        expectedDraftId: approvalV2.latestDraft!.id,
        expectedDraftVersion: approvalV2.latestDraft!.version,
        expectedDraftSha256: approvalV2.latestDraft!.draftSha256,
        idempotencyKey: "ipe055g-stage-v2",
      });
      expect(stagedV2.episode.id).toBe(staged.episode.id);
      expect(stagedV2.episode.isPublished).toBe(false);

      await expect(requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageId: stagedV2.stage.id,
        expectedStagedDraftSha256: stagedV2.stage.stagedDraftSha256,
        expectedEpisodeStateSha256: stagedV2.stage.episodeStateSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: false,
      })).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
      const preparedV2 = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      const runId = preparedV2.publishRun!.id;
      expect(runId).not.toBe(staleRunId);

      const enqueued = await requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageId: stagedV2.stage.id,
        expectedStagedDraftSha256: stagedV2.stage.stagedDraftSha256,
        expectedEpisodeStateSha256: stagedV2.stage.episodeStateSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: true,
        executionScope: {
          workspaceId: workspace.workspaceId,
          workspaceNovelId: workspaceNovel.workspaceNovelId,
          runId,
          expectedCutoverEpoch: 1,
          expectedOwnershipVersion: 1,
        },
      });
      expect(enqueued.execution.outbox.status).toBe("pending");

      const published = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "ipe055g-publish-worker",
        provider,
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(published.claimed).toBe(true);
      expect(published.result.status).toBe("published");
      expect(published.editorialProjection).toMatchObject({
        matched: true,
        projected: true,
      });

      const [episode] = await db.select().from(episodes)
        .where(eq(episodes.id, stagedEpisodeId!));
      expect(episode.isPublished).toBe(true);
      expect(episode.publishedAt).toBeTruthy();
      const [publishItem] = await db.select().from(workspacePublishItems)
        .where(eq(workspacePublishItems.runId, runId));
      expect(publishItem.status).toBe("published");
      expect(publishItem.providerReceipt).toMatch(/^ipenovel:/);
      expect((await db.select().from(workspaceOutbox)
        .where(eq(workspaceOutbox.publishRunId, runId)))[0].status).toBe("delivered");

      const publishedBoard = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(publishedBoard?.columns.find(column =>
        column.cards.some(card => card.workItemId === workItemId)
      )?.key).toBe("published");

      const replay = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "ipe055g-replay-worker",
        provider,
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(replay.claimed).toBe(false);
    } finally {
      if (boardId) {
        await db.delete(workspaceKanbanCards)
          .where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db.delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.userId, owner.id));
      if (stagedEpisodeId) {
        await db.delete(episodes).where(eq(episodes.id, stagedEpisodeId));
      }
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
