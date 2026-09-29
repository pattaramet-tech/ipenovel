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
            "เขาเจอ Привет แล้วเดินต่อ",
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
        const cyrillic = first.findings.find(
          (finding: any) => finding.token === "Привет"
        );
        const japanese = first.findings.find(
          (finding: any) => finding.token === "テスト"
        );
        expect(cyrillic).toMatchObject({
          ruleKey: "foreign_script",
          offsetEncoding: "utf16",
          disposition: "open",
          resolutionVersion: 0,
        });
        expect(cyrillic.sentenceText).toContain("Привет");
        expect(cyrillic.contextText).toContain("Привет");
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
          findingId: cyrillic.id,
          disposition: "ignored",
          note: "manual fixture decision",
          expectedVersion: 0,
          idempotencyKey: "checker-ignore-cyrillic-v1",
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

        const staleAfterAllow = await getEditorialForeignCheckerReadModel({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          runId: first.run.id,
        });
        expect(staleAfterAllow.isCurrent).toBe(false);
        expect(staleAfterAllow.staleReason).toBe("ALLOW_LIST_CHANGED");
        expect(staleAfterAllow.currentAllowListSha256).not.toBe(
          first.run.allowListSha256
        );

        const afterAllow = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: initialDraftId,
        });
        expect(afterAllow.created).toBe(true);
        expect(
          afterAllow.findings.map((finding: any) => finding.token)
        ).toEqual(["Привет"]);
        expect(afterAllow.findings[0].disposition).toBe("ignored");
        expect(afterAllow.unresolvedCount).toBe(0);
        expect(afterAllow.effectiveStatus).toBe("passed");
        expect(afterAllow.isCurrent).toBe(true);
        expect(afterAllow.staleReason).toBeNull();
        expect(afterAllow.currentAllowListSha256).toBe(afterAllow.run.allowListSha256);

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
            findingId: cyrillic.id,
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

    it("detects Devanagari, long control payloads and source-junk tails", async () => {
      if (!process.env.TEST_DATABASE_URL) return;
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

      const db = getTestDb();
      const owner = await createTestUser({ role: "admin" });
      const novel = await createTestNovel();
      const workspace = await createWorkspace(owner.id, "Editorial QC v4");
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
          payload: source("checker-v6-junk", [
            "บทที่ 74",
            "มันคือโปเกมอนโอมา\u093E\u0907\u091Fกับคาบูโตะ",
            '”}}],"write_control":{"requiredRevisionId":"ANLCKQltefh534_M0rfjVhNAJM9PmNmBCaSHz22Skd9a2MV0Jf447IJ3Z1T4V00Z3st_fX5D-rKYWSSVPYw-PYFxw1m6xDr9uZ60TpCMm3M',
            "ขอบคุณสำหรับพาวเวอร์สโตนทั้งหมด",
            "1.Unown",
            "2. Oboro21",
            "ความคิดของผู้สร้าง",
            "alex02373 alex02373",
            "จบตอน",
          ]),
        });

        const checked = await runEditorialForeignChecker({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workItemId,
          expectedDraftId: imported.latestDraftId!,
        });

        expect(checked.run.engineVersion).toBe(
          "workspace-editorial-foreign-checker-v7"
        );
        const devanagari = checked.findings.find(
          (finding: any) => finding.token === "\u093E\u0907\u091F"
        );
        expect(devanagari).toMatchObject({
          ruleKey: "foreign_script",
          disposition: "open",
        });
        const leakedControl = checked.findings.find(
          (finding: any) => finding.ruleKey === "long_english"
        );
        expect(leakedControl).toMatchObject({
          disposition: "open",
        });
        expect(leakedControl?.token).toContain('"write_control"');
        expect(leakedControl?.message).toContain("พบประโยคภาษาอังกฤษยาว");
        const junk = checked.findings.filter(
          (finding: any) => finding.ruleKey === "source_junk"
        );
        expect(junk.map((finding: any) => finding.token)).toEqual([
          "ขอบคุณสำหรับพาวเวอร์สโตนทั้งหมด",
          "1.Unown",
          "2. Oboro21",
          "ความคิดของผู้สร้าง",
          "alex02373 alex02373",
          "จบตอน",
        ]);
        expect(checked.effectiveStatus).toBe("failed");

        await expect(
          allowEditorialFindingWord({
            actorUserId: owner.id,
            workspaceId: workspace.workspaceId,
            workItemId,
            findingId: junk[0].id,
            expectedVersion: junk[0].resolutionVersion ?? 0,
            idempotencyKey: "checker-v4-no-allow-source-junk",
          })
        ).rejects.toMatchObject({ code: "ALLOW_WORD_INVALID" });
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
  }
);
