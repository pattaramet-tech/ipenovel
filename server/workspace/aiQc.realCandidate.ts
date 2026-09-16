import { ENV } from "../_core/env";
import { getAiJobDetail, queueAiJob } from "./aiQueue.service";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
} from "./googleDocs.service";
import {
  createWorkspaceGoogleDocsRuntimeAdapter,
  fetchWorkspaceGoogleDriveFileMetadata,
  refreshWorkspaceGoogleDocsAccessToken,
} from "./googleDocs.runtime";

const OPERATION = "semantic_qc";
const PROMPT_VERSION = "workspace-ai-qc-v1";
const MODEL_POLICY_VERSION = "gemini-interactions-controlled-v1";

export class WorkspaceAiQcRealCandidateError extends Error {
  constructor(
    readonly code:
      "PREVIEW_DISARM_REQUIRED" | "CANDIDATE_INVALID" | "CANDIDATE_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcRealCandidateError";
  }
}

function assertDisarmedPreview(env: NodeJS.ProcessEnv) {
  if (env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
    throw new WorkspaceAiQcRealCandidateError(
      "PREVIEW_DISARM_REQUIRED",
      "Real candidate preparation is Preview-only."
    );
  }
  const disarmed = [
    env.WORKSPACE_AI_QC_PROVIDER_ENABLED,
    env.WORKSPACE_AI_QC_EXECUTION_ENABLED,
    env.WORKSPACE_PUBLISH_EXECUTION_ENABLED,
  ].every(value => value === "false");
  if (!disarmed) {
    throw new WorkspaceAiQcRealCandidateError(
      "PREVIEW_DISARM_REQUIRED",
      "AI provider, AI execution, and publish execution must all be explicitly false while preparing a real candidate."
    );
  }
}

export type WorkspaceAiQcRealCandidateInput = {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  connectionId: number;
  providerFileId: string;
  sequence?: number;
};

type CandidateDeps = {
  refreshAccessToken: typeof refreshWorkspaceGoogleDocsAccessToken;
  fetchMetadata: typeof fetchWorkspaceGoogleDriveFileMetadata;
  createAdapter: typeof createWorkspaceGoogleDocsRuntimeAdapter;
  bindDocument: typeof bindGoogleDocument;
  observeDocument: typeof observeBoundGoogleDocument;
  queueJob: typeof queueAiJob;
  getJobDetail: typeof getAiJobDetail;
};
const defaultDeps: CandidateDeps = {
  refreshAccessToken: refreshWorkspaceGoogleDocsAccessToken,
  fetchMetadata: fetchWorkspaceGoogleDriveFileMetadata,
  createAdapter: createWorkspaceGoogleDocsRuntimeAdapter,
  bindDocument: bindGoogleDocument,
  observeDocument: observeBoundGoogleDocument,
  queueJob: queueAiJob,
  getJobDetail: getAiJobDetail,
};

export async function prepareWorkspaceAiQcRealCandidate(
  input: WorkspaceAiQcRealCandidateInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    deps?: CandidateDeps;
  } = {}
) {
  const env = options.env ?? process.env;
  assertDisarmedPreview(env);
  if (
    ![
      input.actorUserId,
      input.workspaceId,
      input.workspaceNovelId,
      input.connectionId,
    ].every(value => Number.isSafeInteger(value) && value > 0)
  ) {
    throw new WorkspaceAiQcRealCandidateError(
      "CANDIDATE_INVALID",
      "Candidate identifiers must be integers."
    );
  }
  if (
    input.sequence !== undefined &&
    (!Number.isSafeInteger(input.sequence) || input.sequence <= 0)
  ) {
    throw new WorkspaceAiQcRealCandidateError(
      "CANDIDATE_INVALID",
      "Document sequence must be a positive integer."
    );
  }
  const providerFileId = input.providerFileId.trim();
  if (!providerFileId || providerFileId.length > 255) {
    throw new WorkspaceAiQcRealCandidateError(
      "CANDIDATE_INVALID",
      "Google document ID is invalid."
    );
  }
  const deps = options.deps ?? defaultDeps;
  const accessToken = await deps.refreshAccessToken({
    actorUserId: input.actorUserId,
    connectionId: input.connectionId,
    fetchImpl: options.fetchImpl,
  });
  const metadata = await deps.fetchMetadata({
    accessToken,
    providerFileId,
    fetchImpl: options.fetchImpl,
  });
  const correlationId = `ipe054d2a-${Date.now()}`;
  const binding = await deps.bindDocument({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    connectionId: input.connectionId,
    providerFileId: metadata.id,
    mimeType: metadata.mimeType,
    title: metadata.name,
    role: "source",
    sequence: input.sequence ?? 1,
    correlationId: `${correlationId}-bind`,
  });
  const adapter = deps.createAdapter(options.fetchImpl);
  const observation = await deps.observeDocument({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    bindingId: binding.bindingId,
    accessToken,
    correlationId: `${correlationId}-observe`,
    adapter,
  });
  const queued = await deps.queueJob({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    snapshotId: observation.snapshotId,
    operation: OPERATION,
    promptVersion: PROMPT_VERSION,
    modelPolicyVersion: MODEL_POLICY_VERSION,
    priority: 0,
  });
  const detail = await deps.getJobDetail({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    jobId: queued.job.id,
  });
  if (detail.job.status !== "queued" || detail.attempts.length !== 0) {
    throw new WorkspaceAiQcRealCandidateError(
      "CANDIDATE_CONFLICT",
      "The durable AI QC job is not a fresh queued candidate with zero attempts."
    );
  }
  return {
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    connectionId: input.connectionId,
    documentId: binding.documentId,
    bindingId: binding.bindingId,
    snapshotId: observation.snapshotId,
    jobId: detail.job.id,
    requestKey: detail.job.idempotencyKey,
    operation: detail.job.operation,
    created: queued.created,
    scope: `workspaceId=${input.workspaceId},jobId=${detail.job.id},snapshotId=${observation.snapshotId},requestKey=${detail.job.idempotencyKey}`,
  };
}
