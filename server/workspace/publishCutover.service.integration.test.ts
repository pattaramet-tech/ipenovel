import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspacePublishItems,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { createPublishDestination, createPublishDryRun } from "./publishDryRun.service";
import { getPublishCutoverReadiness, rehearsePublishCutoverRollback, WorkspacePublishCutoverError } from "./publishCutover.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M05-C cutover readiness source";

describe.sequential("workspace M05-C publish cutover readiness", () => {
  it("reads deterministic readiness, rehearses rollback dedupe, and fails closed on ownership ambiguity without mutating registry", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M05-C readiness tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m05c-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m05c_publish",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M05-C fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m05c-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m05c-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m05c_publish", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M05-C fixture" })),
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

      const registryBefore = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      const ready = await getPublishCutoverReadiness({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id });
      expect(ready.readyForSyntheticCutover).toBe(true);
      expect(ready.blockers).toEqual([]);
      expect(ready.aiAdvisory.blocking).toBe(false);
      expect(ready.itemSummary.succeededWithReceipt).toBe(2);
      const firstRehearsal = await rehearsePublishCutoverRollback({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id });
      const secondRehearsal = await rehearsePublishCutoverRollback({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id });
      expect(firstRehearsal.rehearsal.rehearsalKey).toBe(secondRehearsal.rehearsal.rehearsalKey);
      expect(firstRehearsal.rehearsal.rollback.preserveSucceededItemKeys).toEqual(["chapter-1", "chapter-2"]);
      expect(firstRehearsal.rehearsal.rollback.retryItemKeys).toEqual([]);
      expect(firstRehearsal.registryMutationApplied).toBe(false);
      expect(firstRehearsal.publishDeliveryApplied).toBe(false);
      expect(await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ))).toEqual(registryBefore);

      await db.update(workspacePublishItems).set({ status: "failed", providerReceipt: null, errorClass: "TEMPORARY" }).where(eq(workspacePublishItems.id, items[1].id));
      const blocked = await rehearsePublishCutoverRollback({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id });
      expect(blocked.readiness.readyForSyntheticCutover).toBe(false);
      expect(blocked.readiness.blockers).toContain("UNRESOLVED_PUBLISH_ITEMS");
      expect(blocked.rehearsal.rollback.preserveSucceededItemKeys).toEqual(["chapter-1"]);
      expect(blocked.rehearsal.rollback.retryItemKeys).toEqual(["chapter-2"]);

      await db.update(workspaceMigrationRegistry).set({ owner: "workspace", cutoverEpoch: 1 }).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      await expect(getPublishCutoverReadiness({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id }))
        .rejects.toMatchObject({ code: "PUBLISH_OWNERSHIP_AMBIGUOUS" } satisfies Partial<WorkspacePublishCutoverError>);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
