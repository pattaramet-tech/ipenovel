import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceAiArtifacts,
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { executeReadOnlyAiQcAttempt } from "./aiQc.service";
import {
  claimAiJob,
  queueAiJob,
  recordAiAttemptProviderReceipt,
  startAiAttempt,
} from "./aiQueue.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const qcText = "บททดสอบ M04-B ที่ถูกส่งให้ provider แบบ transient เท่านั้น";
const evidenceSha256 = createHash("sha256").update("foreign-token", "utf8").digest("hex");

function providerResult(providerRequestId: string) {
  return {
    providerRequestId,
    providerName: "mock-provider",
    model: "mock-qc-v1",
    findings: [{
      category: "foreign_word",
      severity: "warning",
      locationKey: "paragraph:1",
      message: "Possible foreign-language token requires human review.",
      evidenceSha256,
      confidence: 0.91,
    }],
  } as const;
}

describe.sequential("workspace M04-B read-only AI QC execution", () => {
  it("uses transient Docs content, stores receipt before immutable artifact completion, and reconciles prior receipts without duplicate provider execution", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M04-B AI QC tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m04b-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m04b_ai_qc",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M04-B fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m04b-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m04b-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m04b_ai_qc",
            revision: "rev-m04b-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M04-B fixture",
          })),
          getNormalizedText: vi.fn(async () => qcText),
          revoke: vi.fn(async () => undefined),
        },
      });

      const docsAdapter = {
        getMetadata: vi.fn(async () => ({
          providerFileId: "doc_m04b_ai_qc",
          revision: "rev-m04b-2",
          mimeType: GOOGLE_DOC_MIME_TYPE,
          title: "M04-B fixture renamed without content change",
        })),
        getNormalizedText: vi.fn(async () => qcText),
        revoke: vi.fn(async () => undefined),
      };
      const stored = new Map<string, string>();
      const artifactStore = {
        putJson: vi.fn(async (input: { objectKey: string; content: string; contentSha256: string }) => {
          expect(createHash("sha256").update(input.content, "utf8").digest("hex")).toBe(input.contentSha256);
          const existing = stored.get(input.objectKey);
          if (existing && existing !== input.content) throw new Error("non-idempotent artifact overwrite");
          stored.set(input.objectKey, input.content);
        }),
      };
      const provider = {
        mode: "mock" as const,
        execute: vi.fn(async (input: { content: string; requestKey: string }) => {
          expect(input.content).toBe(qcText);
          expect(input.requestKey).toMatch(/^[a-f0-9]{64}$/);
          return providerResult("mock-receipt-001");
        }),
        reconcile: vi.fn(async () => null),
      };

      const queued = await queueAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation: "semantic_qc",
        promptVersion: "qc-prompt-v1",
        modelPolicyVersion: "qc-policy-v1",
      });
      const claimed = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: queued.job.id,
        leaseOwner: "m04b-worker-1",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const executed = await executeReadOnlyAiQcAttempt({
        workspaceId: workspace.workspaceId,
        jobId: queued.job.id,
        attemptId: claimed.attempt.id,
        leaseOwner: claimed.attempt.leaseOwner,
        accessToken: "server-only-execution-token",
        docsAdapter,
        provider,
        artifactStore,
      });
      expect(executed.artifact.advisory).toBe(true);
      expect(executed.artifact.summary.warningCount).toBe(1);
      expect(provider.execute).toHaveBeenCalledTimes(1);
      const storedJson = stored.get(executed.objectKey);
      expect(storedJson).toBeTruthy();
      expect(storedJson).not.toContain(qcText);

      const [completedJob] = await db.select().from(workspaceAiJobs).where(eq(workspaceAiJobs.id, queued.job.id));
      const [completedAttempt] = await db.select().from(workspaceAiJobAttempts).where(eq(workspaceAiJobAttempts.id, claimed.attempt.id));
      const artifacts = await db.select().from(workspaceAiArtifacts).where(eq(workspaceAiArtifacts.attemptId, claimed.attempt.id));
      expect(completedJob.status).toBe("succeeded");
      expect(completedAttempt).toMatchObject({ status: "succeeded", providerRequestId: "mock-receipt-001" });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ artifactType: "qc_findings_v1", moderationStatus: "pending" });

      const recoverJob = await queueAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation: "semantic_qc_receipt_recovery",
        promptVersion: "qc-prompt-v1",
        modelPolicyVersion: "qc-policy-v1",
      });
      const firstClaim = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: recoverJob.job.id,
        leaseOwner: "m04b-worker-crashed",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await startAiAttempt({
        workspaceId: workspace.workspaceId,
        jobId: recoverJob.job.id,
        attemptId: firstClaim.attempt.id,
        leaseOwner: firstClaim.attempt.leaseOwner,
      });
      await recordAiAttemptProviderReceipt({
        workspaceId: workspace.workspaceId,
        jobId: recoverJob.job.id,
        attemptId: firstClaim.attempt.id,
        leaseOwner: firstClaim.attempt.leaseOwner,
        providerRequestId: "mock-receipt-recovery-001",
      });
      await db.update(workspaceAiJobAttempts)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaceAiJobAttempts.id, firstClaim.attempt.id));
      const retryClaim = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: recoverJob.job.id,
        leaseOwner: "m04b-worker-recover",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const recoveryProvider = {
        mode: "mock" as const,
        execute: vi.fn(async () => {
          throw new Error("duplicate provider execution must not happen");
        }),
        reconcile: vi.fn(async ({ providerRequestId }: { providerRequestId: string }) => providerResult(providerRequestId)),
      };
      await executeReadOnlyAiQcAttempt({
        workspaceId: workspace.workspaceId,
        jobId: recoverJob.job.id,
        attemptId: retryClaim.attempt.id,
        leaseOwner: retryClaim.attempt.leaseOwner,
        accessToken: "server-only-recovery-token",
        docsAdapter,
        provider: recoveryProvider,
        artifactStore,
      });
      expect(recoveryProvider.execute).not.toHaveBeenCalled();
      expect(recoveryProvider.reconcile).toHaveBeenCalledWith(expect.objectContaining({
        providerRequestId: "mock-receipt-recovery-001",
      }));
      const [abandoned] = await db.select().from(workspaceAiJobAttempts).where(eq(workspaceAiJobAttempts.id, firstClaim.attempt.id));
      expect(abandoned).toMatchObject({ status: "abandoned", providerRequestId: "mock-receipt-recovery-001", errorClass: "LEASE_EXPIRED" });

      const ownership = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "ai_queue"),
      ));
      expect(ownership).toHaveLength(1);
      expect(ownership[0]).toMatchObject({ owner: "sheets", cutoverEpoch: 0 });
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
