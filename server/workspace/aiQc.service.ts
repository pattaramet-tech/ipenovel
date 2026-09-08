import { and, desc, eq } from "drizzle-orm";
import {
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceDocumentBindings,
  workspaceDocumentSnapshots,
  workspaceDocuments,
  workspaceGoogleConnections,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  buildWorkspaceAiQcArtifact,
  serializeWorkspaceAiQcArtifact,
  validateWorkspaceAiQcProviderResult,
  WorkspaceAiQcContractError,
  type WorkspaceAiQcProviderResult,
} from "./aiQc.domain";
import {
  completeAiAttempt,
  recordAiAttemptProviderReceipt,
  startAiAttempt,
} from "./aiQueue.service";
import {
  fingerprintDocsMetadata,
  normalizeDocsText,
  type WorkspaceDocsAdapter,
} from "./googleDocs.domain";

export class WorkspaceAiQcServiceError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "AI_JOB_NOT_FOUND"
      | "SOURCE_NOT_AVAILABLE"
      | "SOURCE_SNAPSHOT_MISMATCH"
      | "PROVIDER_NOT_EXPLICITLY_ENABLED"
      | "PROVIDER_RECEIPT_RECONCILIATION_REQUIRED"
      | "PROVIDER_RECEIPT_UNRESOLVED"
      | "PROVIDER_CONTRACT_INVALID"
      | "ARTIFACT_STORE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcServiceError";
  }
}

export interface WorkspaceAiQcProvider {
  /** External adapters are fail-closed unless the caller explicitly enables them. */
  mode: "mock" | "external";
  execute(input: {
    requestKey: string;
    operation: string;
    promptVersion: string;
    modelPolicyVersion: string;
    snapshotId: number;
    normalizedSha256: string;
    content: string;
  }): Promise<unknown>;
  reconcile?(input: {
    providerRequestId: string;
    requestKey: string;
    operation: string;
    promptVersion: string;
    modelPolicyVersion: string;
    snapshotId: number;
    normalizedSha256: string;
  }): Promise<unknown | null>;
}

export interface WorkspaceAiQcArtifactStore {
  /** Must be idempotent for the same objectKey/contentSha256 pair. */
  putJson(input: {
    objectKey: string;
    content: string;
    contentSha256: string;
  }): Promise<void>;
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspaceAiQcServiceError("DATABASE_UNAVAILABLE", "Workspace AI QC database is unavailable.");
  return db;
}

function receiptIdFromUnknown(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const requestId = (value as { providerRequestId?: unknown }).providerRequestId;
  return typeof requestId === "string" && requestId.trim() ? requestId.trim() : null;
}

async function markAttemptFailedSafely(input: {
  workspaceId: number;
  jobId: number;
  attemptId: number;
  leaseOwner: string;
  errorClass: string;
  providerRequestId?: string;
}) {
  try {
    await completeAiAttempt({ ...input, outcome: "failed" });
  } catch {
    // Preserve the original execution error. Lease/version conflicts are handled by queue recovery.
  }
}

export async function resolveTransientAiQcContent(input: {
  workspaceId: number;
  jobId: number;
  accessToken: string;
  docsAdapter: WorkspaceDocsAdapter;
}) {
  const db = await database();
  const rows = await db.select({
    job: workspaceAiJobs,
    snapshot: workspaceDocumentSnapshots,
    document: workspaceDocuments,
    connection: workspaceGoogleConnections,
    binding: workspaceDocumentBindings,
    novel: workspaceNovels,
  })
    .from(workspaceAiJobs)
    .innerJoin(workspaceDocumentSnapshots, eq(workspaceAiJobs.snapshotId, workspaceDocumentSnapshots.id))
    .innerJoin(workspaceDocuments, eq(workspaceDocumentSnapshots.documentId, workspaceDocuments.id))
    .innerJoin(workspaceGoogleConnections, eq(workspaceDocuments.connectionId, workspaceGoogleConnections.id))
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocuments.id, workspaceDocumentBindings.documentId))
    .innerJoin(workspaceNovels, eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id))
    .where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId),
      eq(workspaceNovels.workspaceId, input.workspaceId),
      eq(workspaceDocumentBindings.status, "active")
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw new WorkspaceAiQcServiceError("AI_JOB_NOT_FOUND", "AI QC job or bound snapshot was not found.");
  if (row.document.status !== "active" || row.connection.status !== "active") {
    throw new WorkspaceAiQcServiceError("SOURCE_NOT_AVAILABLE", "The bound Google document is not currently readable.");
  }

  const metadata = await input.docsAdapter.getMetadata({
    accessToken: input.accessToken,
    providerFileId: row.document.providerFileId,
  });
  if (metadata.providerFileId !== row.document.providerFileId) {
    throw new WorkspaceAiQcServiceError("SOURCE_NOT_AVAILABLE", "The Google provider returned a different document identity.");
  }
  const rawText = await input.docsAdapter.getNormalizedText({
    accessToken: input.accessToken,
    providerFileId: row.document.providerFileId,
  });
  const fingerprint = fingerprintDocsMetadata({ ...metadata, normalizedText: rawText });
  if (
    fingerprint.contentHash !== row.snapshot.normalizedSha256 ||
    fingerprint.normalizationVersion !== row.snapshot.normalizationVersion
  ) {
    throw new WorkspaceAiQcServiceError(
      "SOURCE_SNAPSHOT_MISMATCH",
      "Current Google document content no longer matches the immutable AI job snapshot."
    );
  }

  return {
    job: row.job,
    snapshot: row.snapshot,
    content: normalizeDocsText(rawText),
  };
}

async function findPriorProviderReceipt(jobId: number, currentAttemptId: number) {
  const db = await database();
  const attempts = await db.select().from(workspaceAiJobAttempts)
    .where(eq(workspaceAiJobAttempts.jobId, jobId))
    .orderBy(desc(workspaceAiJobAttempts.attemptNo));
  return attempts.find(attempt => attempt.id !== currentAttemptId && Boolean(attempt.providerRequestId))?.providerRequestId ?? null;
}

function validateProviderResult(value: unknown): WorkspaceAiQcProviderResult {
  try {
    return validateWorkspaceAiQcProviderResult(value);
  } catch (error) {
    if (error instanceof WorkspaceAiQcContractError) {
      throw new WorkspaceAiQcServiceError("PROVIDER_CONTRACT_INVALID", error.message);
    }
    throw error;
  }
}

export async function executeReadOnlyAiQcAttempt(input: {
  workspaceId: number;
  jobId: number;
  attemptId: number;
  leaseOwner: string;
  accessToken: string;
  docsAdapter: WorkspaceDocsAdapter;
  provider: WorkspaceAiQcProvider;
  artifactStore: WorkspaceAiQcArtifactStore;
  allowExternalProvider?: boolean;
}) {
  if (input.provider.mode === "external" && input.allowExternalProvider !== true) {
    throw new WorkspaceAiQcServiceError(
      "PROVIDER_NOT_EXPLICITLY_ENABLED",
      "External AI provider execution is disabled until explicitly configured."
    );
  }

  await startAiAttempt({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    leaseOwner: input.leaseOwner,
  });

  let providerRequestId: string | undefined;
  try {
    const resolved = await resolveTransientAiQcContent({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      accessToken: input.accessToken,
      docsAdapter: input.docsAdapter,
    });
    const providerInput = {
      requestKey: resolved.job.idempotencyKey,
      operation: resolved.job.operation,
      promptVersion: resolved.job.promptVersion,
      modelPolicyVersion: resolved.job.modelPolicyVersion,
      snapshotId: resolved.snapshot.id,
      normalizedSha256: resolved.snapshot.normalizedSha256,
      content: resolved.content,
    };

    const priorReceipt = await findPriorProviderReceipt(input.jobId, input.attemptId);
    let rawResult: unknown;
    if (priorReceipt) {
      if (!input.provider.reconcile) {
        throw new WorkspaceAiQcServiceError(
          "PROVIDER_RECEIPT_RECONCILIATION_REQUIRED",
          "A previous provider receipt exists; retry is blocked until the provider can reconcile it."
        );
      }
      rawResult = await input.provider.reconcile({
        providerRequestId: priorReceipt,
        requestKey: providerInput.requestKey,
        operation: providerInput.operation,
        promptVersion: providerInput.promptVersion,
        modelPolicyVersion: providerInput.modelPolicyVersion,
        snapshotId: providerInput.snapshotId,
        normalizedSha256: providerInput.normalizedSha256,
      });
      if (!rawResult) {
        throw new WorkspaceAiQcServiceError(
          "PROVIDER_RECEIPT_UNRESOLVED",
          "The previous provider receipt could not be reconciled; no duplicate provider request was sent."
        );
      }
    } else {
      rawResult = await input.provider.execute(providerInput);
    }

    providerRequestId = receiptIdFromUnknown(rawResult) ?? undefined;
    if (providerRequestId) {
      await recordAiAttemptProviderReceipt({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        leaseOwner: input.leaseOwner,
        providerRequestId,
      });
    }
    const providerResult = validateProviderResult(rawResult);
    providerRequestId = providerResult.providerRequestId;
    if (priorReceipt && providerResult.providerRequestId !== priorReceipt) {
      throw new WorkspaceAiQcServiceError(
        "PROVIDER_CONTRACT_INVALID",
        "Reconciled provider result returned a different receipt identity."
      );
    }
    if (!receiptIdFromUnknown(rawResult)) {
      await recordAiAttemptProviderReceipt({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        leaseOwner: input.leaseOwner,
        providerRequestId,
      });
    }

    const artifact = buildWorkspaceAiQcArtifact({
      snapshotId: resolved.snapshot.id,
      normalizedSha256: resolved.snapshot.normalizedSha256,
      normalizationVersion: resolved.snapshot.normalizationVersion,
      operation: resolved.job.operation,
      promptVersion: resolved.job.promptVersion,
      modelPolicyVersion: resolved.job.modelPolicyVersion,
      providerResult,
    });
    const serialized = serializeWorkspaceAiQcArtifact(artifact);
    const objectKey = `workspace/ai-qc/${input.workspaceId}/jobs/${input.jobId}/attempts/${input.attemptId}/workspace-ai-qc-v1.json`;
    try {
      await input.artifactStore.putJson({ objectKey, ...serialized });
    } catch {
      throw new WorkspaceAiQcServiceError("ARTIFACT_STORE_FAILED", "AI QC artifact storage failed.");
    }

    await completeAiAttempt({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: input.attemptId,
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
    return { artifact, objectKey, contentSha256: serialized.contentSha256 };
  } catch (error) {
    const errorClass = error instanceof WorkspaceAiQcServiceError ? error.code : "AI_QC_EXECUTION_FAILED";
    await markAttemptFailedSafely({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      leaseOwner: input.leaseOwner,
      errorClass,
      providerRequestId,
    });
    throw error;
  }
}
