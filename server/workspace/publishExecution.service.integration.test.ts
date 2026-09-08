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
import { createPublishDestination, createPublishDryRun } from "./publishDryRun.service";
import {
  claimPublishOutbox,
  processClaimedPublishOutbox,
  requestPublishExecution,
  WorkspacePublishExecutionError,
} from "./publishExecution.service";
import type { WorkspacePublishProvider, WorkspacePublishProviderResult } from "./publishExecution.domain";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M05-B opt-in publish execution source";

function makeProvider(options?: { crashOnce?: boolean; failItemKey?: string }) {
  const receipts = new Map<string, WorkspacePublishProviderResult>();
  let crashed = false;
  const execute = vi.fn(async (request: any) => {
    if (options?.failItemKey === request.itemKey) {
      return { status: "failed", errorClass: "TEMPORARY" } as const;
    }
    const result = { status: "published", providerReceipt: `receipt:${request.requestKey}` } as const;
    receipts.set(request.requestKey, result);
    if (options?.crashOnce && !crashed) {
      crashed = true;
      throw new Error("synthetic worker crash after provider success");
    }
    return result;
  });
  const reconcile = vi.fn(async (request: any) => receipts.get(request.requestKey));
  return { provider: { mode: "mock", execute, reconcile } satisfies WorkspacePublishProvider, execute, reconcile, receipts };
}

describe.sequential("workspace M05-B publish execution foundation", () => {
  it("gates execution, enqueues transactionally, retries only unfinished items, reconciles crash receipts, and rechecks stale hash", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M05-B publish execution tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m05b-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m05b_publish",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M05-B fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m05b-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m05b-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m05b_publish", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M05-B fixture" })),
          getNormalizedText: vi.fn(async () => text),
          revoke: vi.fn(async () => undefined),
        },
      });
      const [snapshot] = await db.select().from(workspaceDocumentSnapshots).where(eq(workspaceDocumentSnapshots.id, observation.snapshotId));
      const destination = await createPublishDestination({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        targetType: "novel",
        targetId: novel.id,
        policyVersion: "publish-policy-v1",
      });

      const partialPlan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [
          { itemKey: "chapter-1", sourceSha256: snapshot.normalizedSha256 },
          { itemKey: "chapter-2", sourceSha256: "b".repeat(64) },
        ],
      });
      await db.update(workspaceMigrationRegistry).set({ owner: "workspace", cutoverEpoch: 1 }).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      await expect(requestPublishExecution({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: partialPlan.run.id,
        expectedCutoverEpoch: 1,
        executionEnabled: false,
      })).rejects.toMatchObject({ code: "EXECUTION_DISABLED" } satisfies Partial<WorkspacePublishExecutionError>);

      const enqueued = await requestPublishExecution({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: partialPlan.run.id,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      expect(enqueued.created).toBe(true);
      expect(enqueued.run.status).toBe("publishing");
      expect(enqueued.outbox.status).toBe("pending");

      const firstClaim = await claimPublishOutbox({
        workspaceId: workspace.workspaceId,
        leaseOwner: "m05b-worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(firstClaim?.id).toBe(enqueued.outbox.id);
      const partialProvider = makeProvider({ failItemKey: "chapter-2" });
      const partialResult = await processClaimedPublishOutbox({
        workspaceId: workspace.workspaceId,
        outboxId: firstClaim!.id,
        leaseOwner: "m05b-worker-1",
        provider: partialProvider.provider,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      expect(partialResult.status).toBe("partially_failed");
      expect(partialResult.published).toBe(1);
      expect(partialResult.failed).toBe(1);
      const firstItems = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, partialPlan.run.id));
      const publishedItem = firstItems.find(item => item.itemKey === "chapter-1")!;
      expect(publishedItem.status).toBe("published");
      expect(publishedItem.providerReceipt).toBeTruthy();

      await requestPublishExecution({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: partialPlan.run.id,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      await new Promise(resolve => setTimeout(resolve, 1_050));
      const retryClaim = await claimPublishOutbox({
        workspaceId: workspace.workspaceId,
        leaseOwner: "m05b-worker-2",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const retryProvider = makeProvider();
      const retryResult = await processClaimedPublishOutbox({
        workspaceId: workspace.workspaceId,
        outboxId: retryClaim!.id,
        leaseOwner: "m05b-worker-2",
        provider: retryProvider.provider,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      expect(retryResult.status).toBe("published");
      expect(retryProvider.execute).toHaveBeenCalledTimes(1);
      expect(retryProvider.execute.mock.calls[0][0].itemKey).toBe("chapter-2");

      const crashPlan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [{ itemKey: "crash-item", sourceSha256: "c".repeat(64) }],
      });
      const crashEnqueue = await requestPublishExecution({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: crashPlan.run.id, expectedCutoverEpoch: 1, executionEnabled: true });
      const crashClaim = await claimPublishOutbox({ workspaceId: workspace.workspaceId, leaseOwner: "crash-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      const crashProvider = makeProvider({ crashOnce: true });
      await expect(processClaimedPublishOutbox({
        workspaceId: workspace.workspaceId,
        outboxId: crashClaim!.id,
        leaseOwner: "crash-worker",
        provider: crashProvider.provider,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      })).rejects.toThrow("synthetic worker crash");
      await new Promise(resolve => setTimeout(resolve, 1_050));
      const recoveryClaim = await claimPublishOutbox({ workspaceId: workspace.workspaceId, leaseOwner: "recovery-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      expect(recoveryClaim?.id).toBe(crashEnqueue.outbox.id);
      const recovered = await processClaimedPublishOutbox({
        workspaceId: workspace.workspaceId,
        outboxId: recoveryClaim!.id,
        leaseOwner: "recovery-worker",
        provider: crashProvider.provider,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      expect(recovered.status).toBe("published");
      expect(crashProvider.execute).toHaveBeenCalledTimes(1);
      expect(crashProvider.reconcile).toHaveBeenCalledTimes(2);

      const persistedReceiptPlan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [{ itemKey: "persisted-receipt-item", sourceSha256: "e".repeat(64) }],
      });
      const persistedReceiptEnqueue = await requestPublishExecution({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: persistedReceiptPlan.run.id, expectedCutoverEpoch: 1, executionEnabled: true });
      const persistedReceiptClaim = await claimPublishOutbox({ workspaceId: workspace.workspaceId, leaseOwner: "persisted-receipt-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      const [persistedReceiptItem] = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, persistedReceiptPlan.run.id));
      await db.update(workspacePublishItems).set({
        status: "publishing",
        providerReceipt: "persisted-before-terminal-success",
        version: persistedReceiptItem.version + 1,
      }).where(eq(workspacePublishItems.id, persistedReceiptItem.id));
      const persistedReceiptProvider = makeProvider();
      const persistedReceiptRecovered = await processClaimedPublishOutbox({
        workspaceId: workspace.workspaceId,
        outboxId: persistedReceiptClaim!.id,
        leaseOwner: "persisted-receipt-worker",
        provider: persistedReceiptProvider.provider,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      });
      expect(persistedReceiptClaim?.id).toBe(persistedReceiptEnqueue.outbox.id);
      expect(persistedReceiptRecovered.status).toBe("published");
      expect(persistedReceiptProvider.reconcile).not.toHaveBeenCalled();
      expect(persistedReceiptProvider.execute).not.toHaveBeenCalled();

      const stalePlan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [{ itemKey: "stale-execution", sourceSha256: "d".repeat(64) }],
      });
      await db.update(workspaceDocumentFingerprints).set({ lastPublishedSha256: "a".repeat(64) }).where(eq(workspaceDocumentFingerprints.bindingId, binding.bindingId));
      await expect(requestPublishExecution({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: stalePlan.run.id,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      })).rejects.toMatchObject({ code: "STALE_PUBLISH_HASH" } satisfies Partial<WorkspacePublishExecutionError>);

      const ownership = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      expect(ownership).toHaveLength(1);
      expect(ownership[0]).toMatchObject({ owner: "workspace", cutoverEpoch: 1 });
      expect(await db.select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, partialPlan.run.id))).toHaveLength(1);
      expect((await db.select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, partialPlan.run.id)))[0].status).toBe("published");
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
