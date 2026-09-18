import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { novels, users, workspaceKanbanCards, workspaceWorkspaces } from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { ensureEditorialBoard } from "./editorialBoard.service";
import {
  allowEditorialFindingWord,
  getEditorialForeignCheckerReadModel,
  removeEditorialAllowedWord,
  runEditorialForeignChecker,
  setEditorialFindingDisposition,
} from "./editorialForeignChecker.service";
import { importEditorialSource } from "./editorialDraft.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import type { EditorialSourcePayload } from "./editorialDraft.domain";

function source(
  revisionKey: string,
  paragraphs: string[]
): EditorialSourcePayload {
  return {
    sourceKind: "uploaded_file",
    sourceKey: "uploaded-file:work-item-fixture",
    mimeType: "text/plain",
    title: "checker-fixture.txt",
    revisionKey,
    tabs: [
      {
        sourceTabId: "file-main",
        tabOrder: 0,
        title: "checker-fixture.txt",
        paragraphs,
      },
    ],
  };
}

describe.sequential(
  "Workspace Editorial deterministic foreign checker integration",
  () => {
    it("persists deterministic sentence findings, resolutions, allowlist rechecks, and stale-draft guards", async () => {
      if (!process.env.TEST_DATABASE_URL) return;
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

      const db = getTestDb();
      const owner = await createTestUser({ role: "admin" });
      const outsider = await createTestUser();
      const novel = await createTestNovel();
      const workspace = await createWorkspace(owner.id, "Editorial D");
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
          payload: source("checker-r1", [
            "บทที่ 1 เริ่มตรวจ",
            "เขาบอกว่าจะ support เรื่องนี้ให้เต็มที่",
            "เขาเจอ テスト แล้วเดินต่อไป",
          ]),
        });
        expect(imported.latestDraftId).toBeTruthy();
        const initialDraftId = imported.latestDraftId!;

        const first = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: initialDraftId,
        });
        expect(first.created).toBe(true);
        expect(first.run.status).toBe("failed");
        expect(first.unresolvedCount).toBe(2);
        const support = first.findings.find(
          (finding: any) => finding.token === "support"
        );
        const japanese = first.findings.find(
          (finding: any) => finding.token === "テスト"
        );
        expect(support).toMatchObject({
          ruleKey: "latin_word",
          offsetEncoding: "utf16",
          disposition: "open",
          resolutionVersion: 0,
        });
        expect(support.sentenceText).toContain("support");
        expect(support.contextText).toContain("support");
        expect(japanese).toMatchObject({
          ruleKey: "foreign_script",
          offsetEncoding: "utf16",
          disposition: "open",
          resolutionVersion: 0,
        });

        const replay = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: initialDraftId,
        });
        expect(replay.created).toBe(false);
        expect(replay.run.id).toBe(first.run.id);

        await setEditorialFindingDisposition({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          findingId: support.id,
          disposition: "ignored",
          note: "manual fixture decision",
          expectedVersion: 0,
          idempotencyKey: "checker-ignore-support-v1",
        });
        const allowed = await allowEditorialFindingWord({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          findingId: japanese.id,
          expectedVersion: 0,
          idempotencyKey: "checker-allow-japanese-v1",
        });
        expect(allowed.normalizedWord).toBe("テスト");

        const afterAllow = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: initialDraftId,
        });
        expect(afterAllow.created).toBe(true);
        expect(
          afterAllow.findings.map((finding: any) => finding.token)
        ).toEqual(["support"]);
        expect(afterAllow.findings[0].disposition).toBe("ignored");
        expect(afterAllow.unresolvedCount).toBe(0);
        expect(afterAllow.effectiveStatus).toBe("passed");

        await removeEditorialAllowedWord({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          normalizedWord: "テスト",
        });

        const replayedAllow = await allowEditorialFindingWord({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          findingId: japanese.id,
          expectedVersion: 0,
          idempotencyKey: "checker-allow-japanese-v1",
        });
        expect(replayedAllow.replayed).toBe(true);

        const afterUnallow = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: initialDraftId,
        });
        expect(afterUnallow.created).toBe(false);
        expect(afterUnallow.run.id).toBe(first.run.id);
        const reopenedJapanese = afterUnallow.findings.find(
          (finding: any) => finding.token === "テスト"
        );
        expect(reopenedJapanese.disposition).toBe("open");
        expect(reopenedJapanese.resolutionVersion).toBe(1);
        expect(afterUnallow.unresolvedCount).toBe(1);

        await setEditorialFindingDisposition({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          findingId: reopenedJapanese.id,
          disposition: "fixed",
          note: "manual resolution",
          expectedVersion: 1,
          idempotencyKey: "checker-fixed-japanese-v2",
        });
        const resolved = await getEditorialForeignCheckerReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          runId: first.run.id,
        });
        expect(resolved.unresolvedCount).toBe(0);
        expect(resolved.effectiveStatus).toBe("passed");

        const refreshed = await importEditorialSource({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          payload: source("checker-r2", [
            "บทที่ 1 เริ่มตรวจ",
            "ข้อความใหม่ไม่มีคำเดิม",
          ]),
        });
        expect(refreshed.latestDraftId).not.toBe(initialDraftId);

        await expect(
          runEditorialForeignChecker({
            actorUserId: owner.id,
            workspaceId: workspace.workspaceId,
            workItemId,
            expectedDraftId: initialDraftId,
          })
        ).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

        await expect(
          setEditorialFindingDisposition({
            actorUserId: owner.id,
            workspaceId: workspace.workspaceId,
            workItemId,
            findingId: support.id,
            disposition: "open",
            expectedVersion: 1,
            idempotencyKey: "stale-draft-resolution",
          })
        ).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });

        await expect(
          getEditorialForeignCheckerReadModel({
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
  }
);
