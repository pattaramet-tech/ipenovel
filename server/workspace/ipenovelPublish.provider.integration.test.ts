import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  episodes,
  novels,
  users,
  workspaceAuditEvents,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import {
  createTestEpisode,
  createTestNovel,
  createTestUser,
} from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import { WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT } from "./publishExecution.domain";
import { createWorkspace } from "./service";

describe.sequential("IpeNovel Workspace external publish adapter", () => {
  it("publishes only the exact destination episode and reconciles the deterministic receipt without duplicate delivery", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, {
      isPublished: false,
      title: "Provider boundary fixture",
    });
    const workspace = await createWorkspace(
      owner.id,
      "Provider boundary tenant"
    );
    await db
      .update(episodes)
      .set({
        content: "preserve-content",
        fileUrl: "legacy://preserve",
        price: "17.00",
      })
      .where(eq(episodes.id, episode.id));

    try {
      const provider = createIpeNovelWorkspacePublishProvider();
      const request = {
        requestKey: "a".repeat(64),
        workspaceId: workspace.workspaceId,
        publishRunId: 77,
        destinationId: 88,
        targetType: "novel",
        targetId: novel.id,
        itemKey: "episode-1",
        episodeId: episode.id,
        sourceSha256: "b".repeat(64),
      };

      expect(await provider.reconcile(request)).toBeUndefined();
      const first = await provider.execute(request);
      expect(first.status).toBe("published");
      expect(first.providerReceipt).toBe(
        `ipenovel:${episode.id}:${request.requestKey}`
      );

      const [after] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.id, episode.id));
      expect(after).toMatchObject({
        novelId: novel.id,
        isPublished: true,
        content: "preserve-content",
        fileUrl: "legacy://preserve",
        price: "17.00",
      });
      expect(after.publishedAt).toBeTruthy();

      const reconciled = await provider.reconcile(request);
      expect(reconciled).toEqual(first);
      expect(await provider.execute(request)).toEqual(first);
      const receipts = await db
        .select()
        .from(workspaceAuditEvents)
        .where(
          and(
            eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
            eq(
              workspaceAuditEvents.eventType,
              WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT
            ),
            eq(workspaceAuditEvents.correlationId, request.requestKey)
          )
        );
      expect(receipts).toHaveLength(1);
    } finally {
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  it("sanitizes translated author-note/promo contamination atomically before making the episode reader-visible", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, {
      isPublished: false,
      title: "NQA hygiene remediation fixture",
    });
    const workspace = await createWorkspace(
      owner.id,
      "NQA hygiene remediation tenant"
    );
    const contaminated =
      "xxx นับจากนี้ผมตั้งใจจะแก้ไขข้อผิดพลาดทุกอย่างที่ทุกคนช่วยชี้ให้เห็น " +
      "หากพบจุดไหนผิดพลาด โปรดบอกผมในช่องความคิดเห็นได้เลย " +
      "นี่คือเป้าหมายประจำสัปดาห์นี้ สโตนมากกว่า 500 ชิ้น สำหรับบทโบนัสแรก " +
      "ขอบคุณมากสำหรับการสนับสนุนจากทุกคน หากต้องการอ่านล่วงหน้ามากกว่า 20 บท " +
      "เข้าไปดู Patreon ของผมได้ที่ Patreon.com/Kamidemond ความคิดเห็น ความคิดเห็น 5 โหวต";
    await db
      .update(episodes)
      .set({
        content: contaminated,
        contentFormat: "plain_text",
        wordCount: 99,
      })
      .where(eq(episodes.id, episode.id));

    try {
      const provider = createIpeNovelWorkspacePublishProvider();
      const request = {
        requestKey: "c".repeat(64),
        workspaceId: workspace.workspaceId,
        publishRunId: 91,
        destinationId: 92,
        targetType: "novel",
        targetId: novel.id,
        itemKey: "episode-hygiene-remediate",
        episodeId: episode.id,
        sourceSha256: "d".repeat(64),
      };

      const result = await provider.execute(request);
      expect(result.status).toBe("published");

      const [after] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.id, episode.id));
      expect(after).toMatchObject({
        isPublished: true,
        content: "xxx",
        wordCount: 1,
      });

      const [receipt] = await db
        .select()
        .from(workspaceAuditEvents)
        .where(
          and(
            eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
            eq(
              workspaceAuditEvents.eventType,
              WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT
            ),
            eq(workspaceAuditEvents.correlationId, request.requestKey)
          )
        )
        .limit(1);
      const metadata = JSON.parse(receipt.metadataJson);
      expect(metadata.nqaPrePublishHygiene).toMatchObject({
        decision: "READY_FOR_PUBLISH",
        remediationApplied: true,
        residualSignals: [],
      });
      expect(metadata.nqaPrePublishHygiene.removalReasons).toEqual(
        expect.arrayContaining([
          "PATREON_PROMO",
          "AUTHOR_NOTE",
          "ADVANCE_CHAPTER_PROMO",
          "WEBNOVEL_UI",
        ])
      );
    } finally {
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });

  it("blocks publish when contamination remains in a format that is unsafe to auto-remediate", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, {
      isPublished: false,
      title: "NQA hygiene blocked fixture",
    });
    const workspace = await createWorkspace(
      owner.id,
      "NQA hygiene block tenant"
    );
    const contaminatedHtml =
      "<p>เนื้อเรื่องจริง</p><p>Patreon.com/Kamidemond</p><p>20 advance chapters</p>";
    await db
      .update(episodes)
      .set({ content: contaminatedHtml, contentFormat: "html" })
      .where(eq(episodes.id, episode.id));

    try {
      const provider = createIpeNovelWorkspacePublishProvider();
      const request = {
        requestKey: "e".repeat(64),
        workspaceId: workspace.workspaceId,
        publishRunId: 93,
        destinationId: 94,
        targetType: "novel",
        targetId: novel.id,
        itemKey: "episode-hygiene-block",
        episodeId: episode.id,
        sourceSha256: "f".repeat(64),
      };

      await expect(provider.execute(request)).rejects.toMatchObject({
        code: "CONTENT_HYGIENE_BLOCKED",
      });

      const [after] = await db
        .select()
        .from(episodes)
        .where(eq(episodes.id, episode.id));
      expect(after).toMatchObject({
        isPublished: false,
        content: contaminatedHtml,
      });
    } finally {
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
