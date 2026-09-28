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
} from "./editorialBoard.service";
import { importEditorialSource } from "./editorialDraft.service";
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

function replacementSource(): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:replacement-episode-55",
    mimeType: "text/plain",
    title: "episode-55-replacement.txt",
    revisionKey: "replacement-r1",
    tabs: [{
      sourceTabId: "replacement-tab-55",
      tabOrder: 0,
      title: "ตอนที่ 55",
      paragraphs: [
        "ตอนที่ 55 ทดสอบเขียนทับ",
        "เนื้อหาใหม่ที่ผ่านการตรวจและพร้อมเผยแพร่",
        "จบตอน",
      ],
    }],
  };
}

describe.sequential("Editorial published Episode replacement", () => {
  it("stages without touching live content, detects drift, then atomically overwrites the same episode id", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial replacement publish");
    let boardId: number | null = null;

    await db.insert(episodes).values({
      novelId: novel.id,
      episodeNumber: "55",
      title: "ตอนเก่าที่เผยแพร่แล้ว",
      content: "เนื้อหาเก่าที่เผยแพร่อยู่",
      contentFormat: "plain_text",
      saleMode: "package",
      price: "11.00",
      isFree: false,
      isPublished: true,
      publishedAt: new Date("2026-01-02T03:04:05.000Z"),
      wordCount: 3,
      fileUrl: "legacy://old-episode",
      fileSize: 123,
      fileMimeType: "text/plain",
    });
    const [originalEpisode] = await db
      .select()
      .from(episodes)
      .where(and(eq(episodes.novelId, novel.id), eq(episodes.episodeNumber, "55")))
      .limit(1);

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
        episodeNumber: "55",
        episodeTitle: "Replacement",
        saleMode: "package",
        price: "15.00",
        isFree: false,
      });
      const workItem = created.board?.columns
        .flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_EPISODE" && card.episodeNumber === "55");
      const workItemId = workItem!.workItemId!;

      const imported = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: replacementSource(),
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
        idempotencyKey: "replacement-approve",
      });
      const staged = await stageEditorialEpisodeDraft({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        approvalId: approved.approval.id,
        expectedDraftId: approvalState.latestDraft!.id,
        expectedDraftVersion: approvalState.latestDraft!.version,
        expectedDraftSha256: approvalState.latestDraft!.draftSha256,
        idempotencyKey: "replacement-stage",
      });

      expect(staged.episode.id).toBe(originalEpisode.id);
      expect(staged.stage.stageContract).toBe("workspace-editorial-episode-stage-v3");
      expect(staged.readModel.readyToPublish).toBe(true);
      const [stillLive] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.id, originalEpisode.id));
      expect(stillLive).toMatchObject({
        id: originalEpisode.id,
        isPublished: true,
        title: "ตอนเก่าที่เผยแพร่แล้ว",
        content: "เนื้อหาเก่าที่เผยแพร่อยู่",
        fileUrl: "legacy://old-episode",
        price: "11.00",
      });

      await db
        .update(episodes)
        .set({ content: "เนื้อหาถูกแก้จากภายนอกหลัง Stage" })
        .where(eq(episodes.id, originalEpisode.id));
      const drifted = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(drifted.stageStatus).toMatchObject({
        valid: false,
        reason: "EPISODE_DRIFTED",
      });
      await db
        .update(episodes)
        .set({ content: "เนื้อหาเก่าที่เผยแพร่อยู่" })
        .where(eq(episodes.id, originalEpisode.id));
      const restored = await getEditorialApprovalReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(restored.stageStatus.valid).toBe(true);

      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "replacement-google-owner",
        credential: {
          keyVersion: 1,
          encryptedRefreshToken: "v1.redacted.replacement.ciphertext.tag",
        },
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_replacement_anchor",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Replacement publish anchor",
        role: "chapter",
        sequence: 1,
        correlationId: "replacement-bind",
      });
      await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-replacement-token",
        correlationId: "replacement-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_replacement_anchor",
            revision: "replacement-rev-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "Replacement publish anchor",
          })),
          getNormalizedText: vi.fn(async () => "Replacement publish anchor"),
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

      await expect(
        requestEditorialPublish({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedStageSetSha256: (
            await getEditorialPublishReadModel({
              actorUserId: owner.id,
              workspaceId: workspace.workspaceId,
              workItemId,
            })
          ).stageSetSha256!,
          expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
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
      expect(prepared.requestReady).toBe(true);
      const enqueued = await requestEditorialPublish({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        expectedStageSetSha256: prepared.stageSetSha256!,
        expectedStagedDraftSha256: staged.stage.stagedDraftSha256,
        expectedCutoverEpoch: 1,
        expectedOwnershipVersion: 1,
        executionEnabled: true,
      });
      await db
        .update(workspaceOutbox)
        .set({ availableAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaceOutbox.id, enqueued.execution.outbox.id));

      const published = await runScopedPublishWorkerOnce({
        scope: enqueued.scope,
        leaseOwner: "replacement-publish-worker",
        provider: createIpeNovelWorkspacePublishProvider(),
        executionEnabled: true,
        allowExternalProvider: true,
      });
      expect(published.result.status).toBe("published");
      expect(published.editorialProjection).toMatchObject({
        matched: true,
        projected: true,
      });

      const [replaced] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.id, originalEpisode.id));
      expect(replaced.id).toBe(originalEpisode.id);
      expect(replaced.isPublished).toBe(true);
      expect(replaced.content).toContain("เนื้อหาใหม่ที่ผ่านการตรวจ");
      expect(replaced.content).not.toContain("เนื้อหาเก่าที่เผยแพร่อยู่");
      expect(replaced.price).toBe("15.00");
      expect(replaced.saleMode).toBe("package");
      expect(replaced.fileUrl).toBeNull();
      expect(replaced.fileSize).toBeNull();
      expect(replaced.fileMimeType).toBeNull();
      expect(replaced.publishedAt?.getTime()).toBe(
        originalEpisode.publishedAt?.getTime()
      );
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
