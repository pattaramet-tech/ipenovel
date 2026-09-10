import {
  WORKSPACE_PUBLISH_MAX_ATTEMPTS,
  type WorkspacePublishExecutionScope,
  type WorkspacePublishObserver,
  type WorkspacePublishProvider,
} from "./publishExecution.domain";
import { claimPublishOutbox, processClaimedPublishOutbox } from "./publishExecution.service";

export class WorkspacePublishRuntimeError extends Error {
  constructor(readonly code: "EXECUTION_SCOPE_REQUIRED" | "EXECUTION_SCOPE_INVALID", message: string) {
    super(message);
    this.name = "WorkspacePublishRuntimeError";
  }
}

function positiveInt(value: string | undefined, key: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", `Publish execution scope ${key} must be a positive integer.`);
  }
  return number;
}

/** Strict single-run scope. Example: workspaceId=2,workspaceNovelId=2,runId=7,epoch=1,version=2 */
export function parseWorkspacePublishExecutionScope(raw: string | undefined): WorkspacePublishExecutionScope {
  if (!raw?.trim()) throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "WORKSPACE_PUBLISH_EXECUTION_SCOPE is required.");
  const entries = raw.split(",").map(part => part.trim().split("="));
  if (entries.some(parts => parts.length !== 2)) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must use key=value comma-separated fields.");
  }
  const expectedKeys = ["workspaceId", "workspaceNovelId", "runId", "epoch", "version"];
  const entryKeys = entries.map(parts => parts[0]);
  if (entries.length !== expectedKeys.length || new Set(entryKeys).size !== entries.length) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must contain each required field exactly once.");
  }
  const fields = Object.fromEntries(entries) as Record<string, string>;
  if (Object.keys(fields).length !== expectedKeys.length || expectedKeys.some(key => !(key in fields))) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_INVALID", "Publish execution scope must contain exactly workspaceId,workspaceNovelId,runId,epoch,version.");
  }
  return {
    workspaceId: positiveInt(fields.workspaceId, "workspaceId"),
    workspaceNovelId: positiveInt(fields.workspaceNovelId, "workspaceNovelId"),
    runId: positiveInt(fields.runId, "runId"),
    expectedCutoverEpoch: positiveInt(fields.epoch, "epoch"),
    expectedOwnershipVersion: positiveInt(fields.version, "version"),
  };
}

export function scopeMatches(input: WorkspacePublishExecutionScope, expected: WorkspacePublishExecutionScope) {
  return input.workspaceId === expected.workspaceId
    && input.workspaceNovelId === expected.workspaceNovelId
    && input.runId === expected.runId
    && input.expectedCutoverEpoch === expected.expectedCutoverEpoch
    && input.expectedOwnershipVersion === expected.expectedOwnershipVersion;
}

/** One exact run, one claim, bounded retry count; deliberately no loop/scheduler. */
export async function runScopedPublishWorkerOnce(input: {
  scope: WorkspacePublishExecutionScope;
  leaseOwner: string;
  provider: WorkspacePublishProvider;
  executionEnabled: boolean;
  allowExternalProvider: boolean;
  maxAttempts?: number;
  observer?: WorkspacePublishObserver;
}) {
  if (!input.executionEnabled) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "Publish worker refused because execution is disabled.");
  }
  if (input.provider.mode === "external" && !input.allowExternalProvider) {
    throw new WorkspacePublishRuntimeError("EXECUTION_SCOPE_REQUIRED", "Publish worker refused because the external provider is disabled.");
  }
  const startedAt = Date.now();
  const maxAttempts = input.maxAttempts ?? WORKSPACE_PUBLISH_MAX_ATTEMPTS;
  const claimed = await claimPublishOutbox({
    workspaceId: input.scope.workspaceId,
    publishRunId: input.scope.runId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    expectedCutoverEpoch: input.scope.expectedCutoverEpoch,
    expectedOwnershipVersion: input.scope.expectedOwnershipVersion,
    maxAttempts,
  });
  if (!claimed) {
    input.observer?.({ type: "claim_miss", at: new Date().toISOString(), workspaceId: input.scope.workspaceId, publishRunId: input.scope.runId, durationMs: Date.now() - startedAt });
    return { claimed: false as const, durationMs: Date.now() - startedAt };
  }
  input.observer?.({ type: "claim_acquired", at: new Date().toISOString(), workspaceId: input.scope.workspaceId, publishRunId: input.scope.runId, outboxId: claimed.id, attempt: claimed.attempts });
  const result = await processClaimedPublishOutbox({
    workspaceId: input.scope.workspaceId,
    outboxId: claimed.id,
    leaseOwner: input.leaseOwner,
    provider: input.provider,
    expectedCutoverEpoch: input.scope.expectedCutoverEpoch,
    expectedOwnershipVersion: input.scope.expectedOwnershipVersion,
    executionEnabled: input.executionEnabled,
    allowExternalProvider: input.allowExternalProvider,
    maxAttempts,
    observer: input.observer,
  });
  return { claimed: true as const, outboxId: claimed.id, attempt: claimed.attempts, result, durationMs: Date.now() - startedAt };
}
