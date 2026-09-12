import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceAiJobAttempts,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { executeReadOnlyAiQcAttempt } from "./aiQc.service";
import {
  getAiQcOperationalReadModel,
  recoverAiQcFromProviderReceipt,
} from "./aiQcReconciliation.service";
import {
  claimAiJob,
  queueAiJob,
  recordAiAttemptProviderReceipt,
  startAiAttempt,
} from "./aiQueue.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const text = "M04-C transient QC fixture";
const evidenceSha256 = createHash("sha256").update("evidence", "utf8").digest("hex");
const providerResult = (providerRequestId: string) => ({
  providerRequestId,
  providerName: "mock-provider",
  model: "mock-qc-v1",
  findings: [{
    category: "other",
    severity: "warning",
    locationKey: "paragraph:1",
    message: "Advisory finding.",
    evidenceSha256,
    confidence: 0.8,
  }],
});

describe.sequential("workspace M04-C operational reconciliation", () => {
  it("recovers receipt-only jobs without provider re-execution and keeps unresolved receipts recoverable", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M04-C reconciliation tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m04c-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m04c",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M04-C",
        role: "chapter",
        sequence: 1,
        correlationId: "m04c-bind",
      });
      const docsAdapter = {
        getMetadata: vi.fn(async () => ({ providerFileId: "doc_m04c", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M04-C" })),
        getNormalizedText: vi.fn(async () => text),
        revoke: vi.fn(async () => undefined),
      };
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m04c-observe",
        adapter: docsAdapter,
      });

      const queue = async (operation: string) => queueAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation,
        promptVersion: "qc-prompt-v1",
        modelPolicyVersion: "qc-policy-v1",
      });
      const stored = new Map<string, string>();
      const artifactStore = {
        putJson: vi.fn(async (input: { objectKey: string; content: string }) => {
          stored.set(input.objectKey, input.content);
        }),
      };

      const crashed = await queue("receipt_crash_recovery");
      const first = await claimAiJob({ workspaceId: workspace.workspaceId, jobId: crashed.job.id, leaseOwner: "crashed-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await startAiAttempt({ workspaceId: workspace.workspaceId, jobId: crashed.job.id, attemptId: first.attempt.id, leaseOwner: first.attempt.leaseOwner });
      await recordAiAttemptProviderReceipt({ workspaceId: workspace.workspaceId, jobId: crashed.job.id, attemptId: first.attempt.id, leaseOwner: first.attempt.leaseOwner, providerRequestId: "receipt-crash-1" });
      await db.update(workspaceAiJobAttempts).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(workspaceAiJobAttempts.id, first.attempt.id));

      await expect(getAiQcOperationalReadModel({ actorUserId: outsider.id, workspaceId: workspace.workspaceId, jobId: crashed.job.id }))
        .rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
      const before = await getAiQcOperationalReadModel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId: crashed.job.id });
      expect(before.operational.state).toBe("receipt_recovery_needed");

      const recoveryProvider = {
        mode: "mock" as const,
        execute: vi.fn(async () => { throw new Error("must not execute provider during recovery"); }),
        reconcile: vi.fn(async ({ providerRequestId }: { providerRequestId: string }) => providerResult(providerRequestId)),
      };
      const recovered = await recoverAiQcFromProviderReceipt({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        jobId: crashed.job.id,
        leaseOwner: "recovery-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        provider: recoveryProvider,
        artifactStore,
      });
      expect(recovered.providerRequestId).toBe("receipt-crash-1");
      expect(recoveryProvider.execute).not.toHaveBeenCalled();
      expect(recoveryProvider.reconcile).toHaveBeenCalledTimes(1);
      expect((await getAiQcOperationalReadModel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId: crashed.job.id })).operational.state).toBe("succeeded");

      const storeFailure = await queue("artifact_store_failure");
      const failedClaim = await claimAiJob({ workspaceId: workspace.workspaceId, jobId: storeFailure.job.id, leaseOwner: "store-fail-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await expect(executeReadOnlyAiQcAttempt({
        workspaceId: workspace.workspaceId,
        jobId: storeFailure.job.id,
        attemptId: failedClaim.attempt.id,
        leaseOwner: failedClaim.attempt.leaseOwner,
        accessToken: "server-only",
        docsAdapter,
        provider: { mode: "mock", execute: vi.fn(async () => providerResult("receipt-store-fail-1")), reconcile: vi.fn(async () => null) },
        artifactStore: { putJson: vi.fn(async () => { throw new Error("synthetic store failure"); }) },
      })).rejects.toMatchObject({ code: "ARTIFACT_STORE_FAILED" });
      expect((await getAiQcOperationalReadModel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId: storeFailure.job.id })).operational.state).toBe("receipt_recovery_needed");
      await recoverAiQcFromProviderReceipt({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        jobId: storeFailure.job.id,
        leaseOwner: "store-recovery-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        provider: { mode: "mock", execute: vi.fn(async () => { throw new Error("must not execute"); }), reconcile: vi.fn(async ({ providerRequestId }: { providerRequestId: string }) => providerResult(providerRequestId)) },
        artifactStore,
      });

      const unresolved = await queue("unresolved_receipt");
      const unresolvedFirst = await claimAiJob({ workspaceId: workspace.workspaceId, jobId: unresolved.job.id, leaseOwner: "unresolved-worker", leaseExpiresAt: new Date(Date.now() + 60_000) });
      await startAiAttempt({ workspaceId: workspace.workspaceId, jobId: unresolved.job.id, attemptId: unresolvedFirst.attempt.id, leaseOwner: unresolvedFirst.attempt.leaseOwner });
      await recordAiAttemptProviderReceipt({ workspaceId: workspace.workspaceId, jobId: unresolved.job.id, attemptId: unresolvedFirst.attempt.id, leaseOwner: unresolvedFirst.attempt.leaseOwner, providerRequestId: "receipt-unresolved-1" });
      await db.update(workspaceAiJobAttempts).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(workspaceAiJobAttempts.id, unresolvedFirst.attempt.id));
      const unresolvedProvider = { mode: "mock" as const, execute: vi.fn(async () => { throw new Error("must not execute"); }), reconcile: vi.fn(async () => null) };
      await expect(recoverAiQcFromProviderReceipt({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        jobId: unresolved.job.id,
        leaseOwner: "unresolved-recovery-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        provider: unresolvedProvider,
        artifactStore,
      })).rejects.toMatchObject({ code: "PROVIDER_RECEIPT_UNRESOLVED" });
      expect(unresolvedProvider.execute).not.toHaveBeenCalled();
      expect((await getAiQcOperationalReadModel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId: unresolved.job.id })).operational.state).toBe("receipt_recovery_needed");

      const ownership = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "ai_queue")
      ));
      expect(ownership[0]).toMatchObject({ owner: "sheets", cutoverEpoch: 0 });
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, outsider.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
