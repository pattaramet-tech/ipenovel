import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import {
  createPublishDestination,
  createPublishDryRun,
  previewPublishReconciliation,
  WorkspacePublishDryRunError,
} from "./publishDryRun.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M05-A publish dry-run source only";

describe.sequential("workspace M05-A publish dry-run foundation", () => {
  it("persists deterministic dry-run metadata, blocks stale/ambiguous ownership, and never creates delivery side effects", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M05-A publish dry-run tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m05a-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m05a_publish",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M05-A fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m05a-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m05a-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m05a_publish", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M05-A fixture" })),
          getNormalizedText: vi.fn(async () => text),
          revoke: vi.fn(async () => undefined),
        },
      });
      const [snapshot] = await db.select().from(workspaceDocumentSnapshots).where(eq(workspaceDocumentSnapshots.id, observation.snapshotId));
      const [novelBefore] = await db.select().from(novels).where(eq(novels.id, novel.id));

      const destinationInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        targetType: "novel" as const,
        targetId: novel.id,
        policyVersion: "publish-policy-v1",
      };
      const destinationResults = await Promise.all([
        createPublishDestination(destinationInput),
        createPublishDestination(destinationInput),
      ]);
      expect(destinationResults.filter(result => result.created)).toHaveLength(1);
      expect(new Set(destinationResults.map(result => result.destination.id)).size).toBe(1);
      const destination = destinationResults[0];

      const items = [
        { itemKey: "chapter-1", sourceSha256: snapshot.normalizedSha256 },
        { itemKey: "chapter-2", sourceSha256: "b".repeat(64) },
      ];
      const planInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items,
      };
      const planResults = await Promise.all([
        createPublishDryRun(planInput),
        createPublishDryRun({ ...planInput, items: [...items].reverse() }),
      ]);
      expect(planResults.filter(result => result.created)).toHaveLength(1);
      expect(new Set(planResults.map(result => result.run.id)).size).toBe(1);
      const first = planResults[0];
      expect(first.run.status).toBe("ready");
      expect(first.items).toHaveLength(2);
      expect(first.outbox).toHaveLength(0);
      expect(first.outboxContract.deliveryEnabled).toBe(false);

      const reconciliation = await previewPublishReconciliation({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: first.run.id,
        observedResults: [
          { itemKey: "chapter-1", status: "published", providerReceipt: "synthetic-receipt-1" },
          { itemKey: "chapter-2", status: "failed", errorClass: "TEMPORARY" },
        ],
      });
      expect(reconciliation.aggregateStatus).toBe("partially_failed");
      expect(reconciliation.succeeded.map(item => item.itemKey)).toEqual(["chapter-1"]);
      expect(reconciliation.retry.map(item => item.itemKey)).toEqual(["chapter-2"]);
      expect(reconciliation.sideEffectsApplied).toBe(false);

      const outboxRows = await db.select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, first.run.id));
      const runRows = await db.select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, first.run.id));
      const itemRows = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, first.run.id));
      expect(outboxRows).toHaveLength(0);
      expect(runRows[0].status).toBe("ready");
      expect(itemRows.every(item => item.status === "pending")).toBe(true);
      const [novelAfter] = await db.select().from(novels).where(eq(novels.id, novel.id));
      expect(novelAfter).toEqual(novelBefore);

      await db.update(workspaceDocumentFingerprints).set({ lastPublishedSha256: "a".repeat(64) }).where(eq(workspaceDocumentFingerprints.bindingId, binding.bindingId));
      await expect(createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [{ itemKey: "stale", sourceSha256: snapshot.normalizedSha256 }],
      })).rejects.toMatchObject({ code: "STALE_PUBLISH_HASH" } satisfies Partial<WorkspacePublishDryRunError>);

      await db.update(workspaceMigrationRegistry).set({ owner: "workspace", cutoverEpoch: 1 }).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      await expect(createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        expectedLastPublishedSha256: "a".repeat(64),
        items: [{ itemKey: "ownership", sourceSha256: snapshot.normalizedSha256 }],
      })).rejects.toMatchObject({ code: "PUBLISH_OWNERSHIP_AMBIGUOUS" } satisfies Partial<WorkspacePublishDryRunError>);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
