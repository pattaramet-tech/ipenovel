import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  novels,
  users,
  workspaceEditorialDrafts,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { ensureEditorialBoard } from "./editorialBoard.service";
import {
  getEditorialDraftReadModel,
  getEditorialSourceSnapshot,
  importEditorialSource,
} from "./editorialDraft.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(
  revisionKey: string,
  paragraphs: string[],
  sourceKey = "uploaded-file:chapter.txt"
): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey,
    mimeType: "text/plain",
    title: "chapter.txt",
    revisionKey,
    tabs: [
      {
        sourceTabId: "file-main",
        tabOrder: 0,
        title: "chapter.txt",
        paragraphs,
      },
    ],
  };
}

describe.sequential("Workspace Editorial source/draft integration", () => {
  it("keeps immutable revisions, idempotent drafts, paragraph provenance and refresh safety", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Editorial C");
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
      const storyCard = board?.columns
        .flatMap(column => column.cards)
        .find(card => card.workItemType === "NEW_STORY");
      expect(storyCard?.workItemId).toBeTruthy();
      const workItemId = storyCard!.workItemId!;

      const original = source("r1", [
        "ตอนที่ ๑ ชื่อบท",
        "",
        "ข้อความซ้ำ",
        "ข้อความซ้ำ",
        "“หนึ่ง” “สอง”",
      ]);
      const concurrentImports = await Promise.all([
        importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: original,
        }),
        importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: original,
        }),
      ]);
      const imported = concurrentImports.find(result => result.draftCreated);
      const concurrentReplay = concurrentImports.find(
        result => !result.draftCreated
      );
      expect(imported).toMatchObject({
        snapshotCreated: true,
        draftCreated: true,
        refreshBlocked: false,
      });
      expect(concurrentReplay).toMatchObject({
        snapshotCreated: false,
        draftCreated: false,
        refreshBlocked: false,
        reason: "SOURCE_UNCHANGED",
      });

      const firstModel = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(firstModel.snapshots).toHaveLength(1);
      expect(firstModel.latestDraft?.version).toBeGreaterThan(1);
      expect(firstModel.refreshPending).toBe(false);
      const duplicateParagraphs = firstModel.tabs[0].paragraphs.filter(
        (paragraph: any) => paragraph.text === "ข้อความซ้ำ"
      );
      expect(duplicateParagraphs).toHaveLength(2);
      expect(duplicateParagraphs.map((p: any) => p.occurrenceOrdinal)).toEqual([
        1, 2,
      ]);
      expect(
        duplicateParagraphs.every((p: any) => p.occurrenceCount === 2)
      ).toBe(true);

      const replay = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: original,
      });
      expect(replay.snapshotCreated).toBe(false);
      expect(replay.draftCreated).toBe(false);
      expect(replay.reason).toBe("SOURCE_UNCHANGED");

      const metadataOnlyRevision = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source("r2", original.tabs[0].paragraphs),
      });
      expect(metadataOnlyRevision.snapshotCreated).toBe(true);
      expect(metadataOnlyRevision.draftCreated).toBe(false);
      expect(metadataOnlyRevision.reason).toBe("SOURCE_CONTENT_UNCHANGED");
      const afterMetadata = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(afterMetadata.snapshots).toHaveLength(2);
      expect(afterMetadata.refreshPending).toBe(false);
      expect(afterMetadata.latestDraft?.id).toBe(firstModel.latestDraft?.id);

      const refreshed = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source("r3", [
          "บทที่ 1 ชื่อบท",
          "ข้อความใหม่",
          "โปรดติดตามตอนต่อไป",
        ]),
      });
      expect(refreshed.snapshotCreated).toBe(true);
      expect(refreshed.draftCreated).toBe(true);
      const afterRefresh = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(afterRefresh.latestDraft!.version).toBeGreaterThan(
        firstModel.latestDraft!.version
      );
      expect(afterRefresh.tabs[0].paragraphs.map((p: any) => p.text)).toEqual([
        "บทที่ 1 ชื่อบท",
        "ข้อความใหม่",
        "จบตอน",
      ]);

      const recovered = await getEditorialSourceSnapshot({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        snapshotId: firstModel.snapshots[0].id,
      });
      expect(recovered.payload).toEqual(original);

      const manualVersion = afterRefresh.latestDraft!.version + 1;
      await db.insert(workspaceEditorialDrafts).values({
        workItemId,
        sourceSnapshotId: afterRefresh.latestDraft!.sourceSnapshotId,
        parentDraftId: afterRefresh.latestDraft!.id,
        version: manualVersion,
        origin: "manual",
        transformCode: "manual_edit",
        draftSha256: afterRefresh.latestDraft!.draftSha256,
        presentationJson: afterRefresh.latestDraft!.presentationJson,
        warningsJson: afterRefresh.latestDraft!.warningsJson,
        createdByUserId: owner.id,
      });

      const blockedRefresh = await importEditorialSource({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
        payload: source("r4", ["บทที่ 1 ชื่อบท", "เนื้อหาใหม่กว่า"]),
      });
      expect(blockedRefresh.snapshotCreated).toBe(true);
      expect(blockedRefresh.draftCreated).toBe(false);
      expect(blockedRefresh.refreshBlocked).toBe(true);
      expect(blockedRefresh.reason).toBe("MANUAL_DRAFT_PRESENT");

      const pending = await getEditorialDraftReadModel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workItemId,
      });
      expect(pending.refreshPending).toBe(true);
      expect(pending.latestDraft?.version).toBe(manualVersion);

      await expect(
        importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: source("r5", ["อีกแหล่ง"], "uploaded-file:other.txt"),
        })
      ).rejects.toMatchObject({ code: "SOURCE_CONFLICT" });

      await expect(
        getEditorialDraftReadModel({
          actorUserId: outsider.id,
          workspaceId: workspace.workspaceId,
          workItemId,
        })
      ).rejects.toBeTruthy();
    } finally {
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, outsider.id));
    }
  });
});
