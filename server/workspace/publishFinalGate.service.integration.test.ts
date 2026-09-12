import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
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
import { getPublishFinalGatePackage, requirePublishFinalGate, WorkspacePublishFinalGateError } from "./publishFinalGate.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M05-E final publish gate preview source";

describe.sequential("workspace M05-E final publish gate", () => {
  it("produces deterministic read-only Preview readiness and fails closed on execution/history", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M05-E final gate tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m05e-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m05e_publish",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M05-E fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m05e-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m05e-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m05e_publish", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M05-E fixture" })),
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
        items: [{ itemKey: "chapter-1", sourceSha256: snapshot.normalizedSha256 }],
      });
      const [item] = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, plan.run.id));
      await db.update(workspacePublishItems).set({ status: "published", providerReceipt: "receipt-m05e-1" }).where(eq(workspacePublishItems.id, item.id));

      const first = await getPublishFinalGatePackage({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id, executionEnabled: false });
      const second = await requirePublishFinalGate({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id, executionEnabled: false });
      expect(first.gate.previewReady).toBe(true);
      expect(first.gate.operatorCutoverEligible).toBe(true);
      expect(first.gate.packageDigest).toBe(second.gate.packageDigest);
      expect(first.gate.cutoverCommand).toMatchObject({ expectedOwner: "sheets", expectedCutoverEpoch: 0, automatic: false });
      expect(first.registryMutationApplied).toBe(false);
      expect(first.publishDeliveryApplied).toBe(false);

      const executionBlocked = await getPublishFinalGatePackage({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id, executionEnabled: true });
      expect(executionBlocked.gate.blockers).toContain("PREVIEW_EXECUTION_ENABLED");
      await expect(requirePublishFinalGate({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id, executionEnabled: true }))
        .rejects.toMatchObject({ code: "PREVIEW_GATE_BLOCKED" } satisfies Partial<WorkspacePublishFinalGateError>);

      const [ownership] = await db.select().from(workspaceMigrationRegistry).where(eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId));
      await db.insert(workspacePublishOwnershipTransitions).values({
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        publishRunId: plan.run.id,
        direction: "cutover",
        fromOwner: "sheets",
        toOwner: "workspace",
        fromEpoch: 0,
        toEpoch: 1,
        fromVersion: ownership.version,
        toVersion: ownership.version + 1,
        readinessDigest: first.readiness.readinessDigest,
        idempotencyKey: "f".repeat(64),
        actorUserId: owner.id,
      });
      const historyBlocked = await getPublishFinalGatePackage({ actorUserId: owner.id, workspaceId: workspace.workspaceId, runId: plan.run.id, executionEnabled: false });
      expect(historyBlocked.gate.blockers).toContain("TRANSITION_HISTORY_PRESENT");
      expect(historyBlocked.gate.previewReady).toBe(false);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
