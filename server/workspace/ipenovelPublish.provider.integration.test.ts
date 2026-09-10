import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { episodes, novels, users, workspaceAuditEvents, workspaceWorkspaces } from "../../drizzle/schema";
import { createTestEpisode, createTestNovel, createTestUser } from "../test-helpers/fixtures";
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
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const episode = await createTestEpisode(novel.id, { isPublished: false, title: "Provider boundary fixture" });
    const workspace = await createWorkspace(owner.id, "Provider boundary tenant");
    await db.update(episodes).set({ content: "preserve-content", fileUrl: "legacy://preserve", price: "17.00" }).where(eq(episodes.id, episode.id));

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
      expect(first.providerReceipt).toBe(`ipenovel:${episode.id}:${request.requestKey}`);

      const [after] = await db.select().from(episodes).where(eq(episodes.id, episode.id));
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
      const receipts = await db.select().from(workspaceAuditEvents).where(and(
        eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
        eq(workspaceAuditEvents.eventType, WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT),
        eq(workspaceAuditEvents.correlationId, request.requestKey)
      ));
      expect(receipts).toHaveLength(1);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
