import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceAuditEvents,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishOwnershipTransitions,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { createPublishDestination, createPublishDryRun } from "./publishDryRun.service";
import { requestPublishExecution, WorkspacePublishExecutionError } from "./publishExecution.service";
import {
  cutoverPublishOwnership,
  rollbackPublishOwnership,
  WorkspacePublishOwnershipTransitionError,
} from "./publishOwnershipTransition.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M05-D controlled ownership transition source";

describe.sequential("workspace M05-D controlled publish ownership", () => {
  it("cuts over and rolls back atomically/idempotently, blocks backlog, preserves receipts, and disables execution after rollback", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M05-D transition tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m05d-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m05d_publish",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M05-D fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m05d-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m05d-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m05d_publish", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M05-D fixture" })),
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
      const plan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: snapshot.id,
        items: [
          { itemKey: "chapter-1", sourceSha256: snapshot.normalizedSha256 },
          { itemKey: "chapter-2", sourceSha256: "b".repeat(64) },
        ],
      });
      const items = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, plan.run.id));
      await db.update(workspacePublishItems).set({ status: "published", providerReceipt: "receipt-1" }).where(eq(workspacePublishItems.id, items[0].id));
      await db.update(workspacePublishItems).set({ status: "published", providerReceipt: "receipt-2" }).where(eq(workspacePublishItems.id, items[1].id));
      const beforeItems = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, plan.run.id));
      const [initialOwnership] = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      expect(initialOwnership).toMatchObject({ owner: "sheets", cutoverEpoch: 0, version: 1 });

      const cutoverInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedOwner: "sheets" as const,
        expectedCutoverEpoch: 0 as const,
        expectedVersion: initialOwnership.version,
      };
      const cutovers = await Promise.all([cutoverPublishOwnership(cutoverInput), cutoverPublishOwnership(cutoverInput)]);
      expect(cutovers.filter(result => result.created)).toHaveLength(1);
      expect(new Set(cutovers.map(result => result.transition.id)).size).toBe(1);
      const [workspaceOwnership] = await db.select().from(workspaceMigrationRegistry).where(eq(workspaceMigrationRegistry.id, initialOwnership.id));
      expect(workspaceOwnership).toMatchObject({ owner: "workspace", cutoverEpoch: 1, version: 2, changedBy: owner.id });
      expect(await db.select().from(workspacePublishOwnershipTransitions).where(eq(workspacePublishOwnershipTransitions.workspaceNovelId, workspaceNovel.workspaceNovelId))).toHaveLength(1);
      expect(await db.select().from(workspaceAuditEvents).where(and(
        eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
        eq(workspaceAuditEvents.eventType, "publish.ownership.cutover")
      ))).toHaveLength(1);

      await db.insert(workspaceOutbox).values({
        workspaceId: workspace.workspaceId,
        publishRunId: plan.run.id,
        eventType: "m05d.synthetic.backlog",
        payloadObjectKey: "workspace/publish/m05d/backlog.json",
        idempotencyKey: "m05d-backlog",
        ownershipEpoch: 1,
        status: "pending",
      });
      await expect(rollbackPublishOwnership({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedOwner: "workspace",
        expectedCutoverEpoch: 1,
        expectedVersion: 2,
      })).rejects.toMatchObject({ code: "PUBLISH_READINESS_BLOCKED" } satisfies Partial<WorkspacePublishOwnershipTransitionError>);

      await db.update(workspaceOutbox).set({ status: "delivered", deliveredAt: new Date() }).where(and(
        eq(workspaceOutbox.publishRunId, plan.run.id),
        eq(workspaceOutbox.eventType, "m05d.synthetic.backlog")
      ));
      const rollbackInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedOwner: "workspace" as const,
        expectedCutoverEpoch: 1,
        expectedVersion: 2,
      };
      const rollbacks = await Promise.all([rollbackPublishOwnership(rollbackInput), rollbackPublishOwnership(rollbackInput)]);
      expect(rollbacks.filter(result => result.created)).toHaveLength(1);
      expect(new Set(rollbacks.map(result => result.transition.id)).size).toBe(1);
      const [rolledBackOwnership] = await db.select().from(workspaceMigrationRegistry).where(eq(workspaceMigrationRegistry.id, initialOwnership.id));
      expect(rolledBackOwnership).toMatchObject({ owner: "sheets", cutoverEpoch: 2, version: 3, changedBy: owner.id });
      expect(await db.select().from(workspacePublishOwnershipTransitions).where(eq(workspacePublishOwnershipTransitions.workspaceNovelId, workspaceNovel.workspaceNovelId))).toHaveLength(2);
      expect(await db.select().from(workspaceAuditEvents).where(and(
        eq(workspaceAuditEvents.workspaceId, workspace.workspaceId),
        eq(workspaceAuditEvents.eventType, "publish.ownership.rollback")
      ))).toHaveLength(1);
      const afterItems = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, plan.run.id));
      expect(afterItems.map(item => ({ itemKey: item.itemKey, status: item.status, providerReceipt: item.providerReceipt })))
        .toEqual(beforeItems.map(item => ({ itemKey: item.itemKey, status: item.status, providerReceipt: item.providerReceipt })));

      await expect(requestPublishExecution({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedCutoverEpoch: 1,
        executionEnabled: true,
      })).rejects.toMatchObject({ code: "PUBLISH_OWNERSHIP_AMBIGUOUS" } satisfies Partial<WorkspacePublishExecutionError>);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
