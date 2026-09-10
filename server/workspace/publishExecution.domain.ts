import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_EXECUTION_CONTRACT = "workspace-publish-execution-v1" as const;
export const WORKSPACE_PUBLISH_OUTBOX_EVENT = "workspace.publish.execute.v1" as const;
export const WORKSPACE_PUBLISH_PROVIDER_RECEIPT_EVENT = "workspace.publish.provider_receipt.v1" as const;
export const WORKSPACE_PUBLISH_MAX_ATTEMPTS = 3 as const;

export interface WorkspacePublishProviderResult {
  status: "published" | "failed";
  providerReceipt?: string;
  errorClass?: string;
}

export interface WorkspacePublishProviderRequest {
  requestKey: string;
  workspaceId: number;
  publishRunId: number;
  destinationId: number;
  targetType: string;
  targetId: number;
  itemKey: string;
  episodeId?: number;
  sourceSha256: string;
}

export interface WorkspacePublishProvider {
  mode: "mock" | "external";
  reconcile(request: WorkspacePublishProviderRequest): Promise<WorkspacePublishProviderResult | undefined>;
  execute(request: WorkspacePublishProviderRequest): Promise<WorkspacePublishProviderResult>;
}

export interface WorkspacePublishExecutionScope {
  workspaceId: number;
  workspaceNovelId: number;
  runId: number;
  expectedCutoverEpoch: number;
  expectedOwnershipVersion: number;
}

export const WORKSPACE_PUBLISH_OBSERVATION_TYPES = [
  "claim_miss", "claim_acquired", "reconcile_start", "reconcile_hit", "reconcile_miss",
  "execute_start", "execute_result", "receipt_persisted", "item_recovered",
  "outbox_failed", "outbox_dead_letter", "finalized",
] as const;
export type WorkspacePublishObservationType = typeof WORKSPACE_PUBLISH_OBSERVATION_TYPES[number];
export interface WorkspacePublishObservation {
  type: WorkspacePublishObservationType;
  at: string;
  workspaceId: number;
  publishRunId: number;
  outboxId?: number;
  itemId?: number;
  itemKey?: string;
  requestKey?: string;
  attempt?: number;
  status?: string;
  durationMs?: number;
  errorClass?: string;
}
export type WorkspacePublishObserver = (event: WorkspacePublishObservation) => void;

export function buildPublishItemRequestKey(input: {
  publishRunId: number;
  destinationId: number;
  policyVersion: string;
  itemKey: string;
  episodeId?: number;
  sourceSha256: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    contract: WORKSPACE_PUBLISH_EXECUTION_CONTRACT,
    publishRunId: input.publishRunId,
    destinationId: input.destinationId,
    policyVersion: input.policyVersion,
    itemKey: input.itemKey,
    episodeId: input.episodeId ?? null,
    sourceSha256: input.sourceSha256.toLowerCase(),
  })).digest("hex");
}

export function buildPublishOutboxIdempotencyKey(runId: number, runKey: string) {
  return createHash("sha256").update(JSON.stringify({
    contract: WORKSPACE_PUBLISH_EXECUTION_CONTRACT,
    runId,
    runKey,
  })).digest("hex");
}

export function buildPublishOutboxObjectKey(workspaceId: number, runId: number) {
  return `workspace/publish/${workspaceId}/runs/${runId}/${WORKSPACE_PUBLISH_EXECUTION_CONTRACT}.json`;
}
