import { and, eq } from "drizzle-orm";
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
  getEditorialBoard,
} from "./editorialBoard.service";
import {
  getEditorialDraftReadModel,
  importEditorialSource,
} from "./editorialDraft.service";
import { applyEditorialEditorEdit } from "./editorialEditor.service";
import { runEditorialForeignChecker } from "./editorialForeignChecker.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(revisionKey: string, bodyText: string): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:approval-stage-fixture",
    mimeType: "text/plain",
    title: "episode-12.txt",
    revisionKey,
    tabs: [
      {
        sourceTabId: "file-main",
        tabOrder: 0,
        title: "ตอนที่ 12",
        paragraphs: ["บทที่ 12 ชื่อบท", bodyText, "จบตอน"],
      },
    ],
  };
}

function rangeSource(
  revisionKey: string,
  start: number,
  end: number,
  bodyVersion: string
): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:approval-range-fixture",
    mimeType: "text/plain",
    title: `episodes-${start}-${end}.txt`,
    revisionKey,
    tabs: Array.from({ length: end - start + 1 }, (_, index) => {
      const episode = start + index;
      return {
        sourceTabId: `range-tab-${episode}`,
        tabOrder: index,
        title: `แท็บ ${index + 1}`,
        paragraphs: [
          `บทที่ ${episode} ชื่อบท ${episode}`,
          `เนื้อหาตอน ${episode} ${bodyVersion} ${"ก".repeat(500)}`,
          "จบตอน",
        ],
      };
    }),
  };
}

describe.sequential(
  "Workspace Editorial approval + Episode staging integration",
  () => {
    it("binds approval to exact Draft/QC, stages unpublished Episode, invalidates after edit, then safely restages same Episode", async () => {
      if (!process.env.TEST_DATABASE_URL) return;
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

      const db = getTestDb();
      const owner = await createTestUser({ role: "admin" });
      const outsider = await createTestUser();
      const novel = await createTestNovel();
      const workspace = await createWorkspace(owner.id, "Editorial F");
      let stagedEpisodeId: number | null = null;
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
        const story = board?.columns
          .flatMap(column => column.cards)
          .find(card => card.workItemType === "NEW_STORY");
        expect(story?.workspaceNovelId).toBeTruthy();

        const created = await createEditorialEpisodeWorkItem({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workspaceNovelId: story!.workspaceNovelId!,
          episodeNumber: "12",
          episodeTitle: "ชื่อจาก Intake",
          saleMode: "package",
          price: "12.00",
          isFree: false,
        });
        const episodeCard = created.board?.columns
          .flatMap(column => column.cards)
          .find(
            card =>
              card.workItemType === "NEW_EPISODE" && card.episodeNumber === "12"
          );
        expect(episodeCard?.workItemId).toBeTruthy();
        const workItemId = episodeCard!.workItemId!;

        const imported = await importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: source("approval-r1", "เนื้อหาฉบับแรก"),
        });
        expect(imported.latestDraftId).toBeTruthy();

        const firstRun = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: imported.latestDraftId!,
        });
        expect(firstRun.unresolvedCount).toBe(0);
        expect(firstRun.effectiveStatus).toBe("passed");

        const beforeApproval = await getEditorialApprovalReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        expect(beforeApproval.qc.ready).toBe(true);
        expect(beforeApproval.stagePlan).toMatchObject({
          episodeNumber: "12",
          title: "ชื่อจาก Intake",
        });
        expect(beforeApproval.stagePlan?.contentSha256).toMatch(
          /^[a-f0-9]{64}$/
        );

        const approved = await approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: beforeApproval.latestDraft!.id,
          expectedDraftVersion: beforeApproval.latestDraft!.version,
          expectedDraftSha256: beforeApproval.latestDraft!.draftSha256,
          expectedCheckerRunId: beforeApproval.qc.checkerRunId!,
          expectedQcEvidenceSha256: beforeApproval.qc.qcEvidenceSha256!,
          idempotencyKey: "approval-stage-fixture-approve-v1",
        });
        expect(approved.replayed).toBe(false);
        expect(approved.readModel.approvalStatus.valid).toBe(true);

        const approvalReplay = await approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: beforeApproval.latestDraft!.id,
          expectedDraftVersion: beforeApproval.latestDraft!.version,
          expectedDraftSha256: beforeApproval.latestDraft!.draftSha256,
          expectedCheckerRunId: beforeApproval.qc.checkerRunId!,
          expectedQcEvidenceSha256: beforeApproval.qc.qcEvidenceSha256!,
          idempotencyKey: "approval-stage-fixture-approve-v1",
        });
        expect(approvalReplay.replayed).toBe(true);
        expect(approvalReplay.approval.id).toBe(approved.approval.id);

        const staged = await stageEditorialEpisodeDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          approvalId: approved.approval.id,
          expectedDraftId: beforeApproval.latestDraft!.id,
          expectedDraftVersion: beforeApproval.latestDraft!.version,
          expectedDraftSha256: beforeApproval.latestDraft!.draftSha256,
          idempotencyKey: "approval-stage-fixture-stage-v1",
        });
        expect(staged.replayed).toBe(false);
        expect(staged.episode.isPublished).toBe(false);
        expect(staged.episode.publishedAt).toBeNull();
        expect(staged.episode.title).toBe("ชื่อจาก Intake");
        expect(staged.episode.content).toBe("เนื้อหาฉบับแรก\n\nจบตอน");
        stagedEpisodeId = staged.episode.id;
        expect(staged.readModel.readyToPublish).toBe(true);

        const boardReady = await getEditorialBoard({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
        });
        expect(
          boardReady?.columns.find(column =>
            column.cards.some(card => card.workItemId === workItemId)
          )?.key
        ).toBe("ready_to_publish");

        const draftBeforeEdit = await getEditorialDraftReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        const bodyParagraph = draftBeforeEdit.tabs[0].paragraphs.find(
          (paragraph: any) => paragraph.text === "เนื้อหาฉบับแรก"
        );
        expect(bodyParagraph).toBeTruthy();

        const edited = await applyEditorialEditorEdit({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: draftBeforeEdit.latestDraft!.id,
          expectedDraftVersion: draftBeforeEdit.latestDraft!.version,
          expectedDraftSha256: draftBeforeEdit.latestDraft!.draftSha256,
          command: {
            kind: "replace_paragraph",
            paragraphKey: bodyParagraph.paragraphKey,
            expectedParagraphFingerprint: bodyParagraph.paragraphFingerprint,
            expectedText: bodyParagraph.text,
            replacementText: "เนื้อหาฉบับแก้ไข",
          },
          idempotencyKey: "approval-stage-fixture-edit-v2",
        });
        expect(edited.draft.id).not.toBe(beforeApproval.latestDraft!.id);

        const invalidated = await getEditorialApprovalReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        expect(invalidated.approvalStatus).toMatchObject({
          valid: false,
          reason: "DRAFT_CHANGED",
        });
        expect(invalidated.readyToPublish).toBe(false);

        await expect(
          stageEditorialEpisodeDraft({
            actorUserId: owner.id,
            workspaceId: workspace.workspaceId,
            workItemId,
            approvalId: approved.approval.id,
            expectedDraftId: edited.draft.id,
            expectedDraftVersion: edited.draft.version,
            expectedDraftSha256: edited.draft.draftSha256,
            idempotencyKey: "approval-stage-fixture-stage-stale",
          })
        ).rejects.toMatchObject({ code: "APPROVAL_CONFLICT" });

        const secondRun = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: edited.draft.id,
        });
        expect(secondRun.effectiveStatus).toBe("passed");
        const secondReady = await getEditorialApprovalReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        const approved2 = await approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: secondReady.latestDraft!.id,
          expectedDraftVersion: secondReady.latestDraft!.version,
          expectedDraftSha256: secondReady.latestDraft!.draftSha256,
          expectedCheckerRunId: secondReady.qc.checkerRunId!,
          expectedQcEvidenceSha256: secondReady.qc.qcEvidenceSha256!,
          idempotencyKey: "approval-stage-fixture-approve-v2",
        });
        const staged2 = await stageEditorialEpisodeDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          approvalId: approved2.approval.id,
          expectedDraftId: secondReady.latestDraft!.id,
          expectedDraftVersion: secondReady.latestDraft!.version,
          expectedDraftSha256: secondReady.latestDraft!.draftSha256,
          idempotencyKey: "approval-stage-fixture-stage-v2",
        });
        expect(staged2.episode.id).toBe(stagedEpisodeId);
        expect(staged2.episode.content).toBe("เนื้อหาฉบับแก้ไข\n\nจบตอน");
        expect(staged2.episode.isPublished).toBe(false);
        expect(staged2.readModel.readyToPublish).toBe(true);

        await expect(
          getEditorialApprovalReadModel({
            actorUserId: outsider.id,
            workspaceId: workspace.workspaceId,
            workItemId,
          })
        ).rejects.toBeTruthy();
      } finally {
        if (boardId) {
          await db.delete(workspaceKanbanCards)
            .where(eq(workspaceKanbanCards.boardId, boardId));
        }
        await db
          .delete(workspaceWorkspaces)
          .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
        await db
          .delete(episodes)
          .where(
            and(
              eq(episodes.novelId, novel.id),
              eq(episodes.episodeNumber, "12")
            )
          );
        await db.delete(novels).where(eq(novels.id, novel.id));
        await db.delete(users).where(eq(users.id, owner.id));
        await db.delete(users).where(eq(users.id, outsider.id));
      }
    });

    it("stages 036-085 as 50 unpublished Episodes atomically, replays idempotently, and safely restages the same Episode identities", async () => {
      if (!process.env.TEST_DATABASE_URL) return;
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

      const db = getTestDb();
      const owner = await createTestUser({ role: "admin" });
      const novel = await createTestNovel();
      const workspace = await createWorkspace(owner.id, "Editorial F range");
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
          episodeNumber: "036 - 085",
          episodeTitle: null,
          saleMode: "package",
          price: "99.00",
          isFree: false,
        });
        const card = created.board?.columns
          .flatMap(column => column.cards)
          .find(
            item =>
              item.workItemType === "NEW_EPISODE" &&
              item.episodeNumber === "036 - 085"
          );
        expect(card?.workItemId).toBeTruthy();
        const workItemId = card!.workItemId!;

        const imported = await importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: rangeSource("range-r1", 36, 85, "v1"),
        });
        await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: imported.latestDraftId!,
        });
        const ready = await getEditorialApprovalReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        expect(ready.stagePlan).toMatchObject({
          mode: "range",
          requestedEpisodeNumber: "036 - 085",
          itemCount: 50,
          expectedCount: 50,
          ready: true,
        });
        expect(ready.stagePlan?.items?.[0]?.episodeNumber).toBe("036");
        expect(ready.stagePlan?.items?.[49]?.episodeNumber).toBe("085");

        const approved = await approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: ready.latestDraft!.id,
          expectedDraftVersion: ready.latestDraft!.version,
          expectedDraftSha256: ready.latestDraft!.draftSha256,
          expectedCheckerRunId: ready.qc.checkerRunId!,
          expectedQcEvidenceSha256: ready.qc.qcEvidenceSha256!,
          idempotencyKey: "approval-range-approve-v1",
        });
        const staged = await stageEditorialEpisodeDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          approvalId: approved.approval.id,
          expectedDraftId: ready.latestDraft!.id,
          expectedDraftVersion: ready.latestDraft!.version,
          expectedDraftSha256: ready.latestDraft!.draftSha256,
          idempotencyKey: "approval-range-stage-v1",
        });
        expect(staged.batchCount).toBe(50);
        expect(staged.stages).toHaveLength(50);
        expect(staged.episodes).toHaveLength(50);
        expect(staged.episodes.every((episode: any) => !episode.isPublished)).toBe(true);
        expect(staged.readModel.readyToPublish).toBe(true);
        expect(staged.readModel.stages).toHaveLength(50);

        const originalEpisodeIds = staged.episodes.map((episode: any) => episode.id);
        const replay = await stageEditorialEpisodeDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          approvalId: approved.approval.id,
          expectedDraftId: ready.latestDraft!.id,
          expectedDraftVersion: ready.latestDraft!.version,
          expectedDraftSha256: ready.latestDraft!.draftSha256,
          idempotencyKey: "approval-range-stage-v1",
        });
        expect(replay.replayed).toBe(true);
        expect(replay.episodes.map((episode: any) => episode.id)).toEqual(
          originalEpisodeIds
        );

        const draft = await getEditorialDraftReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        const tab60 = draft.tabs.find(
          (tab: any) => tab.sourceTabId === "range-tab-60"
        )!;
        const body60 = tab60.paragraphs.find((paragraph: any) =>
          String(paragraph.text).startsWith("เนื้อหาตอน 60 ")
        )!;
        const replacement = `เนื้อหาตอน 60 v2 ${"ข".repeat(500)}`;
        const edited = await applyEditorialEditorEdit({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: draft.latestDraft!.id,
          expectedDraftVersion: draft.latestDraft!.version,
          expectedDraftSha256: draft.latestDraft!.draftSha256,
          command: {
            kind: "replace_paragraph",
            paragraphKey: body60.paragraphKey,
            expectedParagraphFingerprint: body60.paragraphFingerprint,
            expectedText: body60.text,
            replacementText: replacement,
          },
          idempotencyKey: "approval-range-edit-v2",
        });
        await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: edited.draft.id,
        });
        const readyV2 = await getEditorialApprovalReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        });
        const approvedV2 = await approveEditorialDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: readyV2.latestDraft!.id,
          expectedDraftVersion: readyV2.latestDraft!.version,
          expectedDraftSha256: readyV2.latestDraft!.draftSha256,
          expectedCheckerRunId: readyV2.qc.checkerRunId!,
          expectedQcEvidenceSha256: readyV2.qc.qcEvidenceSha256!,
          idempotencyKey: "approval-range-approve-v2",
        });
        const restaged = await stageEditorialEpisodeDraft({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          approvalId: approvedV2.approval.id,
          expectedDraftId: readyV2.latestDraft!.id,
          expectedDraftVersion: readyV2.latestDraft!.version,
          expectedDraftSha256: readyV2.latestDraft!.draftSha256,
          idempotencyKey: "approval-range-stage-v2",
        });
        expect(restaged.episodes.map((episode: any) => episode.id)).toEqual(
          originalEpisodeIds
        );
        const episode60 = restaged.episodes.find(
          (episode: any) => episode.episodeNumber === "060"
        );
        expect(episode60?.content).toContain(replacement);
        expect(restaged.readModel.readyToPublish).toBe(true);

        const stored = await db
          .select()
          .from(episodes)
          .where(eq(episodes.novelId, novel.id));
        expect(stored).toHaveLength(50);
        expect(new Set(stored.map(row => row.episodeNumber)).size).toBe(50);
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
  }
);
