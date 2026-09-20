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

function rangePublishSource(revisionKey: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:ipe055g-range-publish",
    mimeType: "text/plain",
    title: "episodes-036-038.txt",
    revisionKey,
    tabs: [36, 37, 38].map((episode, index) => ({
      sourceTabId: `publish-tab-${episode}`,
      tabOrder: index,
      title: `แท็บ ${index + 1}`,
      paragraphs: [
        `บทที่ ${episode} ชื่อบท ${episode}`,
        `เนื้อหาตอน ${episode} ${"ก".repeat(500)}`,
        "จบตอน",
      ],
    })),
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
        saleMode: "chapter",
        price: "15.00",
        isFree: false,
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
        expectedStageSetSha256: readyV1.stageSetSha256!,
        expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
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
        expectedStageSetSha256: preparedV1.stageSetSha256!,
        expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
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
      const readyV2 = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });

      await expect(requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageSetSha256: readyV2.stageSetSha256!,
        expectedStagedDraftSha256: stagedV2.stage.stagedDraftSha256,
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
        expectedStageSetSha256: preparedV2.stageSetSha256!,
        expectedStagedDraftSha256: stagedV2.stage.stagedDraftSha256,
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

  it("publishes a staged Episode range as multiple items, retries only the failed item, and projects Published after the whole batch is durable", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "IPE-055-G range publish");
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
        episodeNumber: "036 - 038",
        episodeTitle: null,
        saleMode: "package",
        price: "49.00",
        isFree: false,
      });
      const card = created.board?.columns
        .flatMap(column => column.cards)
        .find(
          item =>
            item.workItemType === "NEW_EPISODE" &&
            item.episodeNumber === "036 - 038"
        );
      const workItemId = card!.workItemId!;

      const imported = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: rangePublishSource("ipe055g-range-r1"),
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
        idempotencyKey: "ipe055g-range-approve",
      });
      const staged = await stageEditorialEpisodeDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        approvalId: approved.approval.id,
        expectedDraftId: approvalState.latestDraft!.id,
        expectedDraftVersion: approvalState.latestDraft!.version,
        expectedDraftSha256: approvalState.latestDraft!.draftSha256,
        idempotencyKey: "ipe055g-range-stage",
      });
      expect(staged.episodes).toHaveLength(3);

      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "ipe055g-range-google-owner",
        credential: {
          keyVersion: 1,
          encryptedRefreshToken: "v1.redacted.range.ciphertext.tag",
        },
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_ipe055g_range_anchor",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "IPE-055-G range publish anchor",
        role: "chapter",
        sequence: 1,
        correlationId: "ipe055g-range-bind",
      });
      await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-range-token",
        correlationId: "ipe055g-range-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_ipe055g_range_anchor",
            revision: "rev-range-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "IPE-055-G range publish anchor",
          })),
          getNormalizedText: vi.fn(
            async () => "IPE-055-G range publish anchor"
          ),
          revoke: vi.fn(async () => undefined),
        },
      });
      await db
        .update(workspaceMigrationRegistry)
        .set({ owner: "workspace", cutoverEpoch: 1 })
        .where(
          and(
            eq(
              workspaceMigrationRegistry.workspaceNovelId,
              workspaceNovel.workspaceNovelId
            ),
            eq(workspaceMigrationRegistry.capability, "publish")
          )
        );

      const ready = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(ready.stages).toHaveLength(3);
      expect(ready.stageSetSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(ready.requestReady).toBe(true);

      await expect(
        requestEditorialPublish({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedStageSetSha256: ready.stageSetSha256!,
          expectedStagedDraftSha256: ready.stage!.stagedDraftSha256,
          expectedCutoverEpoch: 1,
          expectedOwnershipVersion: 1,
          executionEnabled: false,
        })
      ).rejects.toMatchObject({ code: "EXECUTION_DISABLED" });

      const prepared = await getEditorialPublishReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(prepared.publishItems).toHaveLength(3);
      const runId = prepared.publishRun!.id;
      const enqueued = await requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageSetSha256: prepared.stageSetSha256!,
        expectedStagedDraftSha256: prepared.stage!.stagedDraftSha256,
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

      const baseProvider = createIpeNovelWorkspacePublishProvider();
      const failEpisodeId = staged.episodes[1].id;
      const firstExecute = vi.fn(async (request: any) => {
        if (request.episodeId === failEpisodeId) {
          return {
            status: "failed" as const,
            errorClass: "SYNTHETIC_RANGE_FAILURE",
          };
        }
        return baseProvider.execute(request);
      });
      const firstPass = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "ipe055g-range-worker-1",
        provider: {
          mode: "external",
          reconcile: request => baseProvider.reconcile(request),
          execute: firstExecute,
        },
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(firstPass.result.status).toBe("partially_failed");
      expect(firstPass.editorialProjection).toMatchObject({
        matched: true,
        projected: false,
      });

      const firstItems = await db
        .select()
        .from(workspacePublishItems)
        .where(eq(workspacePublishItems.runId, runId));
      expect(firstItems.filter(item => item.status === "published")).toHaveLength(
        2
      );
      expect(firstItems.filter(item => item.status === "failed")).toHaveLength(1);

      await new Promise(resolve => setTimeout(resolve, 1_050));
      const retryExecute = vi.fn((request: any) => baseProvider.execute(request));
      const retry = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "ipe055g-range-worker-2",
        provider: {
          mode: "external",
          reconcile: request => baseProvider.reconcile(request),
          execute: retryExecute,
        },
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(retry.result.status).toBe("published");
      expect(retryExecute).toHaveBeenCalledTimes(1);
      expect(retryExecute.mock.calls[0][0].episodeId).toBe(failEpisodeId);
      expect(retry.editorialProjection).toMatchObject({
        matched: true,
        projected: true,
        itemCount: 3,
      });

      const finalItems = await db
        .select()
        .from(workspacePublishItems)
        .where(eq(workspacePublishItems.runId, runId));
      expect(finalItems).toHaveLength(3);
      expect(
        finalItems.every(
          item => item.status === "published" && Boolean(item.providerReceipt)
        )
      ).toBe(true);
      const finalEpisodes = await db
        .select()
        .from(episodes)
        .where(eq(episodes.novelId, novel.id));
      expect(finalEpisodes).toHaveLength(3);
      expect(finalEpisodes.every(episode => episode.isPublished)).toBe(true);

      const publishedBoard = await getEditorialBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(
        publishedBoard?.columns.find(column =>
          column.cards.some(item => item.workItemId === workItemId)
        )?.key
      ).toBe("published");

      const replayExecute = vi.fn((request: any) => baseProvider.execute(request));
      const replay = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "ipe055g-range-worker-replay",
        provider: {
          mode: "external",
          reconcile: request => baseProvider.reconcile(request),
          execute: replayExecute,
        },
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(replay.claimed).toBe(false);
      expect(replayExecute).not.toHaveBeenCalled();
    } finally {
      if (boardId) {
        await db
          .delete(workspaceKanbanCards)
          .where(eq(workspaceKanbanCards.boardId, boardId));
      }
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db
        .delete(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(episodes).where(eq(episodes.novelId, novel.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
