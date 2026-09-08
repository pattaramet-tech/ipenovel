import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_EXECUTION_CONTRACT = "workspace-publish-execution-v1" as const;
export const WORKSPACE_PUBLISH_OUTBOX_EVENT = "workspace.publish.execute.v1" as const;

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
