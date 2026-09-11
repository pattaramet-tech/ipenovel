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
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { bindPublicationNovel, createWorkspace } from "./service";
import {
  cancelAiJob,
  claimAiJob,
  completeAiAttempt,
  getAiJobDetail,
  listAiJobs,
  queueAiJob,
  retryAiJob,
  startAiAttempt,
} from "./aiQueue.service";

describe.sequential("workspace M04-A durable AI Queue foundation", () => {
  it("dedupes logical jobs, leases one worker, retries with new attempts, stores immutable artifact refs, and keeps Sheets ownership", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M04-A AI queue tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m04a-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m04a_ai_queue",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M04-A fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m04a-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m04a-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m04a_ai_queue",
            revision: "rev-m04a-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M04-A fixture",
          })),
          getNormalizedText: vi.fn(async () => "m04a deterministic ai queue fixture"),
          revoke: vi.fn(async () => undefined),
        },
      });

      const queueInput = {
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        operation: "rewrite_chapter",
        promptVersion: "prompt-v1",
        modelPolicyVersion: "policy-v1",
        priority: 10,
      } as const;
      const queued = await Promise.all([queueAiJob(queueInput), queueAiJob(queueInput)]);
      expect(new Set(queued.map(result => result.job.id)).size).toBe(1);
      expect(queued.filter(result => result.created)).toHaveLength(1);
      const jobId = queued[0].job.id;
      expect((await db.select().from(workspaceAiJobs).where(eq(workspaceAiJobs.id, jobId)))).toHaveLength(1);

      await expect(listAiJobs({ actorUserId: outsider.id, workspaceId: workspace.workspaceId }))
        .rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });

      const claims = await Promise.allSettled([
        claimAiJob({
          workspaceId: workspace.workspaceId,
          jobId,
          leaseOwner: "worker-a",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
        claimAiJob({
          workspaceId: workspace.workspaceId,
          jobId,
          leaseOwner: "worker-b",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ]);
      const fulfilledClaims = claims.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimAiJob>>> => result.status === "fulfilled");
      expect(fulfilledClaims).toHaveLength(1);
      const firstClaim = fulfilledClaims[0].value;
      expect(firstClaim.attempt.attemptNo).toBe(1);

      await startAiAttempt({
        workspaceId: workspace.workspaceId,
        jobId,
        attemptId: firstClaim.attempt.id,
        leaseOwner: firstClaim.attempt.leaseOwner,
      });
      await completeAiAttempt({
        workspaceId: workspace.workspaceId,
        jobId,
        attemptId: firstClaim.attempt.id,
        leaseOwner: firstClaim.attempt.leaseOwner,
        outcome: "failed",
        errorClass: "SYNTHETIC_FAILURE",
      });

      await retryAiJob({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId });
      const secondClaim = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId,
        leaseOwner: "worker-retry",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(secondClaim.attempt.attemptNo).toBe(2);
      expect(secondClaim.attempt.id).not.toBe(firstClaim.attempt.id);
      await startAiAttempt({
        workspaceId: workspace.workspaceId,
        jobId,
        attemptId: secondClaim.attempt.id,
        leaseOwner: secondClaim.attempt.leaseOwner,
      });
      const artifactHash = "a".repeat(64);
      await completeAiAttempt({
        workspaceId: workspace.workspaceId,
        jobId,
        attemptId: secondClaim.attempt.id,
        leaseOwner: secondClaim.attempt.leaseOwner,
        outcome: "succeeded",
        providerRequestId: "synthetic-receipt-001",
        artifacts: [{
          artifactType: "chapter_draft",
          contentObjectKey: "workspace/test/m04a/artifact-001.txt",
          contentSha256: artifactHash,
          moderationStatus: "pending",
        }],
      });

      const detail = await getAiJobDetail({ actorUserId: owner.id, workspaceId: workspace.workspaceId, jobId });
      expect(detail.job.status).toBe("succeeded");
      expect(detail.attempts.map(attempt => ({ no: attempt.attemptNo, status: attempt.status, error: attempt.errorClass }))).toEqual([
        { no: 1, status: "failed", error: "SYNTHETIC_FAILURE" },
        { no: 2, status: "succeeded", error: null },
      ]);
      expect(detail.artifacts).toHaveLength(1);
      expect(detail.artifacts[0]).toMatchObject({
        attemptId: secondClaim.attempt.id,
        artifactType: "chapter_draft",
        contentObjectKey: "workspace/test/m04a/artifact-001.txt",
        contentSha256: artifactHash,
        moderationStatus: "pending",
      });

      const expiredQueued = await queueAiJob({ ...queueInput, operation: "expired_lease_fixture" });
      const expiredFirst = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: expiredQueued.job.id,
        leaseOwner: "worker-expired",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await db.update(workspaceAiJobAttempts).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(workspaceAiJobAttempts.id, expiredFirst.attempt.id));
      const reclaimed = await claimAiJob({
        workspaceId: workspace.workspaceId,
        jobId: expiredQueued.job.id,
        leaseOwner: "worker-reclaim",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(reclaimed.attempt.attemptNo).toBe(2);
      const [abandoned] = await db.select().from(workspaceAiJobAttempts).where(eq(workspaceAiJobAttempts.id, expiredFirst.attempt.id));
      expect(abandoned).toMatchObject({ status: "abandoned", errorClass: "LEASE_EXPIRED" });

      const cancelQueued = await queueAiJob({ ...queueInput, operation: "cancel_fixture" });
      const cancelled = await cancelAiJob({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        jobId: cancelQueued.job.id,
      });
      expect(cancelled.status).toBe("cancelled");

      const ownership = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "ai_queue"),
      ));
      expect(ownership).toHaveLength(1);
      expect(ownership[0]).toMatchObject({ owner: "sheets", cutoverEpoch: 0 });

      expect(await db.select().from(workspaceAiArtifacts).where(eq(workspaceAiArtifacts.attemptId, secondClaim.attempt.id))).toHaveLength(1);
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, outsider.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
