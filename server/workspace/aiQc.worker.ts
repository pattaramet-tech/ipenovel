import { ENV } from "../_core/env";
import { deriveAiQcOperationalState } from "./aiQcReconciliation.domain";
import { recoverAiQcFromProviderReceipt } from "./aiQcReconciliation.service";
import { claimAiJob, getAiJobDetail } from "./aiQueue.service";
import { createRuntimeWorkspaceAiQcProvider } from "./aiProviderRuntime";
import {
  executeReadOnlyAiQcAttempt,
  type WorkspaceAiQcArtifactStore,
  type WorkspaceAiQcProvider,
} from "./aiQc.service";
import type { WorkspaceDocsAdapter } from "./googleDocs.domain";

const DEFAULT_LEASE_SECONDS = 60;
const MAX_LEASE_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;

export interface WorkspaceAiQcExecutionScope {
  workspaceId: number;
  jobId: number;
  snapshotId: number;
  requestKey: string;
}

export class WorkspaceAiQcWorkerError extends Error {
  constructor(
    readonly code:
      | "EXECUTION_DISABLED"
      | "EXECUTION_SCOPE_REQUIRED"
      | "EXECUTION_SCOPE_INVALID"
      | "EXECUTION_SCOPE_MISMATCH"
      | "PROVIDER_RECONCILIATION_REQUIRED"
      | "ATTEMPT_LIMIT_REACHED"
      | "JOB_ACTIVE"
      | "JOB_INCONSISTENT"
      | "JOB_RETRY_REQUIRED"
      | "JOB_NOT_RUNNABLE",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcWorkerError";
  }
}

function positiveInt(raw: string, field: string) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkspaceAiQcWorkerError("EXECUTION_SCOPE_INVALID", `${field} must be a positive integer.`);
  }
  return value;
}

function boundedPositiveInt(raw: string, fallback: number, field: string, max: number) {
  if (!raw.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new WorkspaceAiQcWorkerError(
      "EXECUTION_SCOPE_INVALID",
      `${field} must be a positive integer no greater than ${max}.`
    );
  }
  return value;
}

export function parseWorkspaceAiQcExecutionScope(raw: string | undefined): WorkspaceAiQcExecutionScope {
  if (!raw?.trim()) {
    throw new WorkspaceAiQcWorkerError(
      "EXECUTION_SCOPE_REQUIRED",
      "WORKSPACE_AI_QC_EXECUTION_SCOPE is required when AI QC execution is enabled."
    );
  }
  const entries = raw.split(",").map(part => part.trim().split("="));
  if (entries.some(parts => parts.length !== 2 || !parts[0] || !parts[1])) {
    throw new WorkspaceAiQcWorkerError(
      "EXECUTION_SCOPE_INVALID",
      "AI QC execution scope must use non-empty key=value comma-separated fields."
    );
  }
  const expected = ["workspaceId", "jobId", "snapshotId", "requestKey"];
  const keys = entries.map(parts => parts[0]);
  if (entries.length !== expected.length || new Set(keys).size !== entries.length || expected.some(key => !keys.includes(key))) {
    throw new WorkspaceAiQcWorkerError(
      "EXECUTION_SCOPE_INVALID",
      "AI QC execution scope must contain exactly workspaceId,jobId,snapshotId,requestKey."
    );
  }
  const fields = Object.fromEntries(entries) as Record<string, string>;
  const requestKey = fields.requestKey.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestKey)) {
    throw new WorkspaceAiQcWorkerError("EXECUTION_SCOPE_INVALID", "AI QC requestKey must be a SHA-256 hex digest.");
  }
  return {
    workspaceId: positiveInt(fields.workspaceId, "workspaceId"),
    jobId: positiveInt(fields.jobId, "jobId"),
    snapshotId: positiveInt(fields.snapshotId, "snapshotId"),
    requestKey,
  };
}

export type WorkspaceAiQcWorkerRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      scope: WorkspaceAiQcExecutionScope;
      leaseSeconds: number;
      maxAttempts: number;
    };

export function resolveWorkspaceAiQcWorkerConfig(raw: {
  enabled?: string;
  scope?: string;
  leaseSeconds?: string;
  maxAttempts?: string;
} = {
  enabled: ENV.workspaceAiQcExecutionEnabled,
  scope: ENV.workspaceAiQcExecutionScope,
  leaseSeconds: ENV.workspaceAiQcLeaseSeconds,
  maxAttempts: ENV.workspaceAiQcMaxAttempts,
}): WorkspaceAiQcWorkerRuntimeConfig {
  if (raw.enabled !== "true") return { enabled: false };
  return {
    enabled: true,
    scope: parseWorkspaceAiQcExecutionScope(raw.scope),
    leaseSeconds: boundedPositiveInt(raw.leaseSeconds ?? "", DEFAULT_LEASE_SECONDS, "WORKSPACE_AI_QC_LEASE_SECONDS", MAX_LEASE_SECONDS),
    maxAttempts: boundedPositiveInt(raw.maxAttempts ?? "", DEFAULT_MAX_ATTEMPTS, "WORKSPACE_AI_QC_MAX_ATTEMPTS", MAX_ATTEMPTS),
  };
}

export type WorkspaceAiQcWorkerEvent = {
  type: "scope_verified" | "claim_acquired" | "provider_execution_started" | "receipt_recovery_started" | "completed" | "failed";
  at: string;
  workspaceId: number;
  jobId: number;
  attemptId?: number;
  attemptCount?: number;
  action?: "execute" | "recover" | "noop";
  durationMs?: number;
  errorCode?: string;
};

export type WorkspaceAiQcWorkerObserver = (event: WorkspaceAiQcWorkerEvent) => void;

export interface WorkspaceAiQcWorkerServices {
  getJobDetail: typeof getAiJobDetail;
  claimJob: typeof claimAiJob;
  executeAttempt: typeof executeReadOnlyAiQcAttempt;
  recoverReceipt: typeof recoverAiQcFromProviderReceipt;
}

const defaultServices: WorkspaceAiQcWorkerServices = {
  getJobDetail: getAiJobDetail,
  claimJob: claimAiJob,
  executeAttempt: executeReadOnlyAiQcAttempt,
  recoverReceipt: recoverAiQcFromProviderReceipt,
};

function scopeMatches(scope: WorkspaceAiQcExecutionScope, job: {
  id: number;
  workspaceId: number;
  snapshotId: number;
  idempotencyKey: string;
}) {
  return scope.workspaceId === job.workspaceId
    && scope.jobId === job.id
    && scope.snapshotId === job.snapshotId
    && scope.requestKey === job.idempotencyKey.toLowerCase();
}

function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "AI_QC_WORKER_FAILED";
}

export async function runScopedAiQcWorkerOnce(input: {
  actorUserId: number;
  scope: WorkspaceAiQcExecutionScope;
  leaseOwner: string;
  accessToken: string;
  docsAdapter: WorkspaceDocsAdapter;
  artifactStore: WorkspaceAiQcArtifactStore;
  provider: WorkspaceAiQcProvider;
  executionEnabled: boolean;
  leaseSeconds: number;
  maxAttempts: number;
  observer?: WorkspaceAiQcWorkerObserver;
  now?: Date;
  services?: WorkspaceAiQcWorkerServices;
}) {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const services = input.services ?? defaultServices;
  const emit = (event: Omit<WorkspaceAiQcWorkerEvent, "at" | "workspaceId" | "jobId">) => input.observer?.({
    ...event,
    at: new Date().toISOString(),
    workspaceId: input.scope.workspaceId,
    jobId: input.scope.jobId,
  });

  try {
    if (!input.executionEnabled) {
      throw new WorkspaceAiQcWorkerError("EXECUTION_DISABLED", "Workspace AI QC worker execution is disabled.");
    }
    if (!input.leaseOwner.trim() || input.leaseOwner.length > 255) {
      throw new WorkspaceAiQcWorkerError("EXECUTION_SCOPE_INVALID", "AI QC leaseOwner must be non-empty and at most 255 characters.");
    }
    if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds <= 0 || input.leaseSeconds > MAX_LEASE_SECONDS) {
      throw new WorkspaceAiQcWorkerError("EXECUTION_SCOPE_INVALID", "AI QC leaseSeconds is outside the allowed bound.");
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0 || input.maxAttempts > MAX_ATTEMPTS) {
      throw new WorkspaceAiQcWorkerError("EXECUTION_SCOPE_INVALID", "AI QC maxAttempts is outside the allowed bound.");
    }
    if (input.provider.mode === "external" && !input.provider.reconcile) {
      throw new WorkspaceAiQcWorkerError(
        "PROVIDER_RECONCILIATION_REQUIRED",
        "External AI QC worker execution requires receipt reconciliation before any provider request is allowed."
      );
    }

    const detail = await services.getJobDetail({
      actorUserId: input.actorUserId,
      workspaceId: input.scope.workspaceId,
      jobId: input.scope.jobId,
    });
    if (!scopeMatches(input.scope, detail.job)) {
      throw new WorkspaceAiQcWorkerError(
        "EXECUTION_SCOPE_MISMATCH",
        "AI QC execution scope does not match the durable job identity."
      );
    }

    const operational = deriveAiQcOperationalState({
      jobStatus: detail.job.status,
      attempts: detail.attempts,
      artifacts: detail.artifacts,
      now,
    });
    emit({ type: "scope_verified", attemptCount: operational.attemptCount });

    if (operational.state === "succeeded" || operational.state === "cancelled") {
      emit({ type: "completed", action: "noop", attemptCount: operational.attemptCount, durationMs: Date.now() - startedAt });
      return { action: "noop" as const, state: operational.state, attemptCount: operational.attemptCount };
    }
    if (operational.state === "active") {
      throw new WorkspaceAiQcWorkerError("JOB_ACTIVE", "AI QC job already has an active attempt lease.");
    }
    if (operational.state === "inconsistent") {
      throw new WorkspaceAiQcWorkerError("JOB_INCONSISTENT", "AI QC job history is inconsistent and requires operator review.");
    }
    if (operational.attemptCount >= input.maxAttempts) {
      throw new WorkspaceAiQcWorkerError("ATTEMPT_LIMIT_REACHED", "AI QC job reached the configured attempt ceiling.");
    }

    const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000);
    if (operational.recoveryRequired) {
      emit({ type: "receipt_recovery_started", action: "recover", attemptCount: operational.attemptCount });
      const recovered = await services.recoverReceipt({
        actorUserId: input.actorUserId,
        workspaceId: input.scope.workspaceId,
        jobId: input.scope.jobId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        provider: input.provider,
        artifactStore: input.artifactStore,
        allowExternalProvider: true,
      });
      emit({ type: "completed", action: "recover", attemptId: recovered.attemptId, durationMs: Date.now() - startedAt });
      return { action: "recover" as const, ...recovered };
    }

    if (operational.state === "failed") {
      throw new WorkspaceAiQcWorkerError(
        "JOB_RETRY_REQUIRED",
        "Failed AI QC jobs without a provider receipt require the explicit admin retry action before worker execution."
      );
    }
    if (operational.state !== "queued" && operational.state !== "abandoned") {
      throw new WorkspaceAiQcWorkerError("JOB_NOT_RUNNABLE", `AI QC job cannot run from operational state ${operational.state}.`);
    }

    const claimed = await services.claimJob({
      workspaceId: input.scope.workspaceId,
      jobId: input.scope.jobId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
    });
    emit({ type: "claim_acquired", action: "execute", attemptId: claimed.attempt.id, attemptCount: operational.attemptCount + 1 });
    emit({ type: "provider_execution_started", action: "execute", attemptId: claimed.attempt.id });
    const executed = await services.executeAttempt({
      workspaceId: input.scope.workspaceId,
      jobId: input.scope.jobId,
      attemptId: claimed.attempt.id,
      leaseOwner: input.leaseOwner,
      accessToken: input.accessToken,
      docsAdapter: input.docsAdapter,
      provider: input.provider,
      artifactStore: input.artifactStore,
      allowExternalProvider: true,
    });
    emit({ type: "completed", action: "execute", attemptId: claimed.attempt.id, durationMs: Date.now() - startedAt });
    return { action: "execute" as const, attemptId: claimed.attempt.id, ...executed };
  } catch (error) {
    emit({ type: "failed", errorCode: safeErrorCode(error), durationMs: Date.now() - startedAt });
    throw error;
  }
}

export type WorkspaceAiQcConfiguredWorkerInput = Omit<
  Parameters<typeof runScopedAiQcWorkerOnce>[0],
  "scope" | "provider" | "executionEnabled" | "leaseSeconds" | "maxAttempts" | "services"
> & {
  fetchImpl?: typeof fetch;
  services?: WorkspaceAiQcWorkerServices;
};

export async function runConfiguredScopedAiQcWorkerOnce(input: WorkspaceAiQcConfiguredWorkerInput) {
  const config = resolveWorkspaceAiQcWorkerConfig();
  if (!config.enabled) {
    throw new WorkspaceAiQcWorkerError("EXECUTION_DISABLED", "Workspace AI QC worker execution is disabled.");
  }
  const { fetchImpl, ...workerInput } = input;
  const provider = await createRuntimeWorkspaceAiQcProvider(fetchImpl);
  return runScopedAiQcWorkerOnce({
    ...workerInput,
    scope: config.scope,
    provider,
    executionEnabled: true,
    leaseSeconds: config.leaseSeconds,
    maxAttempts: config.maxAttempts,
  });
}