import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceAiJobAttempts,
  workspaceGoogleConnections,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { queueAiJob, claimAiJob, startAiAttempt, recordAiAttemptProviderReceipt } from "./aiQueue.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import { runScopedAiQcWorkerOnce } from "./aiQc.worker";

const qcText = "บททดสอบ IPE-054-C แบบ synthetic เท่านั้น";

function providerResult(providerRequestId: string) {
  return { providerRequestId, providerName: "synthetic-provider", model: "synthetic-qc-v1", findings: [] } as const;
}
describe.sequential("IPE-054-C Preview AI QC synthetic runtime", () => {
  it("executes one scoped queued job and recovers a crash receipt without duplicate provider execution", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "IPE-054-C synthetic tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "ipe054c-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.synthetic.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_ipe054c_ai_qc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "IPE-054-C synthetic fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "ipe054c-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "synthetic-observe-token",
        correlationId: "ipe054c-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_ipe054c_ai_qc", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "IPE-054-C synthetic fixture" })),
          getNormalizedText: vi.fn(async () => qcText),
          revoke: vi.fn(async () => undefined),
        },
      });
      const docsAdapter = {
        getMetadata: vi.fn(async () => ({ providerFileId: "doc_ipe054c_ai_qc", revision: "rev-2", mimeType: GOOGLE_DOC_MIME_TYPE, title: "IPE-054-C synthetic fixture" })),
        getNormalizedText: vi.fn(async () => qcText),
        revoke: vi.fn(async () => undefined),
      };
      const stored = new Map<string, string>();
      const artifactStore = {
        putJson: vi.fn(async (input: { objectKey: string; content: string; contentSha256: string }) => {
          expect(input.objectKey).toMatch(/^workspace\/ai-qc\/\d+\/jobs\/\d+\/(?:attempts\/\d+|receipts\/[a-f0-9]{64})\/workspace-ai-qc-v1\.json$/);
          expect(createHash("sha256").update(input.content, "utf8").digest("hex")).toBe(input.contentSha256);
          const prior = stored.get(input.objectKey);
          if (prior && prior !== input.content) throw new Error("synthetic artifact overwrite mismatch");
          stored.set(input.objectKey, input.content);
        }),
      };

      const executeProvider = {
        mode: "mock" as const,
        execute: vi.fn(async () => providerResult("synthetic-receipt-execute")),
        reconcile: vi.fn(async () => null),
      };
      const executeJob = await queueAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation: "semantic_qc_preview_synthetic",
        promptVersion: "qc-prompt-v1",
        modelPolicyVersion: "qc-policy-v1",
      });
      const executeResult = await runScopedAiQcWorkerOnce({
        actorUserId: owner.id,
        scope: {
          workspaceId: workspace.workspaceId,
          jobId: executeJob.job.id,
          snapshotId: observation.snapshotId,
          requestKey: executeJob.job.idempotencyKey,
        },
        leaseOwner: "ipe054c-worker-execute",
        accessToken: "synthetic-runtime-token",
        docsAdapter,
        artifactStore,
        provider: executeProvider,
        executionEnabled: true,
        leaseSeconds: 60,
        maxAttempts: 3,
      });
      expect(executeResult.action).toBe("execute");
      expect(executeProvider.execute).toHaveBeenCalledTimes(1);
      expect(executeProvider.reconcile).not.toHaveBeenCalled();
      expect(stored.size).toBe(1);

      const recoveryJob = await queueAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation: "semantic_qc_preview_recovery_synthetic",
        promptVersion: "qc-prompt-v1",
        modelPolicyVersion: "qc-policy-v1",
      });
      const crashed = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: recoveryJob.job.id,
        leaseOwner: "ipe054c-worker-crashed",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await startAiAttempt({ workspaceId: workspace.workspaceId, jobId: recoveryJob.job.id, attemptId: crashed.attempt.id, leaseOwner: crashed.attempt.leaseOwner });
      await recordAiAttemptProviderReceipt({
        workspaceId: workspace.workspaceId,
        jobId: recoveryJob.job.id,
        attemptId: crashed.attempt.id,
        leaseOwner: crashed.attempt.leaseOwner,
        providerRequestId: "synthetic-receipt-recover",
      });
      await db.update(workspaceAiJobAttempts)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaceAiJobAttempts.id, crashed.attempt.id));
      const recoveryProvider = {
        mode: "mock" as const,
        execute: vi.fn(async () => {
          throw new Error("duplicate provider execution must not happen");
        }),
        reconcile: vi.fn(async ({ providerRequestId }: { providerRequestId: string }) => providerResult(providerRequestId)),
      };
      const recoverResult = await runScopedAiQcWorkerOnce({
        actorUserId: owner.id,
        scope: {
          workspaceId: workspace.workspaceId,
          jobId: recoveryJob.job.id,
          snapshotId: observation.snapshotId,
          requestKey: recoveryJob.job.idempotencyKey,
        },
        leaseOwner: "ipe054c-worker-recover",
        accessToken: "synthetic-recovery-token",
        docsAdapter,
        artifactStore,
        provider: recoveryProvider,
        executionEnabled: true,
        leaseSeconds: 60,
        maxAttempts: 3,
      });
      expect(recoverResult.action).toBe("recover");
      expect(recoveryProvider.execute).not.toHaveBeenCalled();
      expect(recoveryProvider.reconcile).toHaveBeenCalledTimes(1);
      expect(stored.size).toBe(2);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
