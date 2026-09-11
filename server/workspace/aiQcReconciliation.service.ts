import { and, eq } from "drizzle-orm";
import {
  workspaceAiJobs,
  workspaceDocumentSnapshots,
  workspaceMembers,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  buildWorkspaceAiQcArtifact,
  serializeWorkspaceAiQcArtifact,
  validateWorkspaceAiQcProviderResult,
  WorkspaceAiQcContractError,
} from "./aiQc.domain";
import {
  type WorkspaceAiQcArtifactStore,
  type WorkspaceAiQcProvider,
} from "./aiQc.service";
import { deriveAiQcOperationalState } from "./aiQcReconciliation.domain";
import {
  claimAiJob,
  completeAiAttempt,
  getAiJobDetail,
  recordAiAttemptProviderReceipt,
  retryAiJob,
  startAiAttempt,
} from "./aiQueue.service";

export class WorkspaceAiQcReconciliationError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "AI_JOB_NOT_FOUND"
      | "RECOVERY_NOT_REQUIRED"
      | "RECOVERY_STATE_INCONSISTENT"
      | "PROVIDER_NOT_EXPLICITLY_ENABLED"
      | "PROVIDER_RECEIPT_RECONCILIATION_REQUIRED"
      | "PROVIDER_RECEIPT_UNRESOLVED"
      | "PROVIDER_CONTRACT_INVALID"
      | "ARTIFACT_STORE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcReconciliationError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspaceAiQcReconciliationError("DATABASE_UNAVAILABLE", "Workspace AI QC reconciliation database is unavailable.");
  return db;
}

async function requireMembership(input: { actorUserId: number; workspaceId: number; editor?: boolean }) {
  const db = await database();
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, input.workspaceId),
    eq(workspaceMembers.userId, input.actorUserId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) {
    throw new WorkspaceAiQcReconciliationError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  }
  if (input.editor && membership.role !== "owner" && membership.role !== "editor") {
    throw new WorkspaceAiQcReconciliationError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required for AI QC recovery.");
  }
  return membership;
}

export async function getAiQcOperationalReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  jobId: number;
  now?: Date;
}) {
  await requireMembership(input);
  const detail = await getAiJobDetail(input);
  const derived = deriveAiQcOperationalState({
    jobStatus: detail.job.status,
    attempts: detail.attempts,
    artifacts: detail.artifacts,
    now: input.now,
  });
  return {
    job: {
      id: detail.job.id,
      workspaceId: detail.job.workspaceId,
      snapshotId: detail.job.snapshotId,
      operation: detail.job.operation,
      promptVersion: detail.job.promptVersion,
      modelPolicyVersion: detail.job.modelPolicyVersion,
      status: detail.job.status,
      createdAt: detail.job.createdAt,
    },
    operational: derived,
    attempts: detail.attempts.map(attempt => ({
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      leaseExpiresAt: attempt.leaseExpiresAt,
      providerRequestId: attempt.providerRequestId,
      errorClass: attempt.errorClass,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    })),
    artifacts: detail.artifacts.map(artifact => ({
      id: artifact.id,
      attemptId: artifact.attemptId,
      artifactType: artifact.artifactType,
      contentObjectKey: artifact.contentObjectKey,
      contentSha256: artifact.contentSha256,
      moderationStatus: artifact.moderationStatus,
      createdAt: artifact.createdAt,
    })),
  };
}

function validateReconciledProviderResult(value: unknown, expectedReceipt: string) {
  try {
    const result = validateWorkspaceAiQcProviderResult(value);
    if (result.providerRequestId !== expectedReceipt) {
      throw new WorkspaceAiQcReconciliationError(
        "PROVIDER_CONTRACT_INVALID",
        "Reconciled provider result returned a different receipt identity."
      );
    }
    return result;
  } catch (error) {
    if (error instanceof WorkspaceAiQcReconciliationError) throw error;
    if (error instanceof WorkspaceAiQcContractError) {
      throw new WorkspaceAiQcReconciliationError("PROVIDER_CONTRACT_INVALID", error.message);
    }
    throw error;
  }
}

export async function recoverAiQcFromProviderReceipt(input: {
  actorUserId: number;
  workspaceId: number;
  jobId: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  provider: WorkspaceAiQcProvider;
  artifactStore: WorkspaceAiQcArtifactStore;
  allowExternalProvider?: boolean;
}) {
  await requireMembership({ ...input, editor: true });
  if (input.provider.mode === "external" && input.allowExternalProvider !== true) {
    throw new WorkspaceAiQcReconciliationError(
      "PROVIDER_NOT_EXPLICITLY_ENABLED",
      "External AI provider reconciliation is disabled until explicitly configured."
    );
  }
  if (!input.provider.reconcile) {
    throw new WorkspaceAiQcReconciliationError(
      "PROVIDER_RECEIPT_RECONCILIATION_REQUIRED",
      "Receipt recovery requires a provider reconciliation implementation."
    );
  }

  const before = await getAiQcOperationalReadModel(input);
  if (before.operational.state === "inconsistent" || before.operational.distinctProviderReceiptCount !== 1) {
    throw new WorkspaceAiQcReconciliationError(
      "RECOVERY_STATE_INCONSISTENT",
      "AI QC recovery requires exactly one canonical provider receipt and a consistent job history."
    );
  }
  if (!before.operational.recoveryRequired || !before.operational.canonicalProviderRequestId) {
    throw new WorkspaceAiQcReconciliationError("RECOVERY_NOT_REQUIRED", "AI QC receipt recovery is not required for this job.");
  }
  if (before.job.status === "succeeded" || before.job.status === "cancelled") {
    throw new WorkspaceAiQcReconciliationError("RECOVERY_NOT_REQUIRED", "Terminal AI QC job does not allow receipt recovery.");
  }

  if (before.job.status === "failed") {
    await retryAiJob({ actorUserId: input.actorUserId, workspaceId: input.workspaceId, jobId: input.jobId });
  }

  const claimed = await claimAiJob({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
  });
  await startAiAttempt({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    attemptId: claimed.attempt.id,
    leaseOwner: input.leaseOwner,
  });

  const providerRequestId = before.operational.canonicalProviderRequestId;
  await recordAiAttemptProviderReceipt({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    attemptId: claimed.attempt.id,
    leaseOwner: input.leaseOwner,
    providerRequestId,
  });

  const db = await database();
  const [source] = await db.select({ job: workspaceAiJobs, snapshot: workspaceDocumentSnapshots })
    .from(workspaceAiJobs)
    .innerJoin(workspaceDocumentSnapshots, eq(workspaceAiJobs.snapshotId, workspaceDocumentSnapshots.id))
    .where(and(eq(workspaceAiJobs.id, input.jobId), eq(workspaceAiJobs.workspaceId, input.workspaceId)))
    .limit(1);
  if (!source) {
    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      outcome: "failed",
      providerRequestId,
      errorClass: "AI_JOB_NOT_FOUND",
    });
    throw new WorkspaceAiQcReconciliationError("AI_JOB_NOT_FOUND", "AI QC recovery source snapshot was not found.");
  }

  let rawResult: unknown;
  try {
    rawResult = await input.provider.reconcile({
      providerRequestId,
      requestKey: source.job.idempotencyKey,
      operation: source.job.operation,
      promptVersion: source.job.promptVersion,
      modelPolicyVersion: source.job.modelPolicyVersion,
      snapshotId: source.snapshot.id,
      normalizedSha256: source.snapshot.normalizedSha256,
    });
  } catch (error) {
    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      outcome: "failed",
      providerRequestId,
      errorClass: "PROVIDER_RECEIPT_UNRESOLVED",
    });
    throw error;
  }
  if (!rawResult) {
    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      outcome: "failed",
      providerRequestId,
      errorClass: "PROVIDER_RECEIPT_UNRESOLVED",
    });
    throw new WorkspaceAiQcReconciliationError(
      "PROVIDER_RECEIPT_UNRESOLVED",
      "Provider receipt is still unresolved; no new provider request was sent."
    );
  }

  let providerResult;
  try {
    providerResult = validateReconciledProviderResult(rawResult, providerRequestId);
  } catch (error) {
    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      outcome: "failed",
      providerRequestId,
      errorClass: "PROVIDER_CONTRACT_INVALID",
    });
    throw error;
  }
  const artifact = buildWorkspaceAiQcArtifact({
    snapshotId: source.snapshot.id,
    normalizedSha256: source.snapshot.normalizedSha256,
    normalizationVersion: source.snapshot.normalizationVersion,
    operation: source.job.operation,
    promptVersion: source.job.promptVersion,
    modelPolicyVersion: source.job.modelPolicyVersion,
    providerResult,
  });
  const serialized = serializeWorkspaceAiQcArtifact(artifact);
  const objectKey = `workspace/ai-qc/${input.workspaceId}/jobs/${input.jobId}/receipts/${providerRequestId}/workspace-ai-qc-v1.json`;
  try {
    await input.artifactStore.putJson({ objectKey, ...serialized });
  } catch {
    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      outcome: "failed",
      providerRequestId,
      errorClass: "ARTIFACT_STORE_FAILED",
    });
    throw new WorkspaceAiQcReconciliationError("ARTIFACT_STORE_FAILED", "Recovered AI QC artifact storage failed.");
  }

  await completeAiAttempt({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    attemptId: claimed.attempt.id,
    leaseOwner: input.leaseOwner,
    outcome: "succeeded",
    providerRequestId,
    artifacts: [{
      artifactType: "qc_findings_v1",
      contentObjectKey: objectKey,
      contentSha256: serialized.contentSha256,
      moderationStatus: "pending",
    }],
  });
  return {
    recovered: true as const,
    providerRequestId,
    attemptId: claimed.attempt.id,
    artifact,
    objectKey,
    contentSha256: serialized.contentSha256,
  };
}
