import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_DRY_RUN_CONTRACT = "workspace-publish-dry-run-v1" as const;
export const WORKSPACE_PUBLISH_OUTBOX_CONTRACT = "workspace-publish-outbox-v1" as const;

export interface PublishDryRunItemInput {
  itemKey: string;
  episodeId?: number;
  sourceSha256: string;
}

export interface PublishObservedItemResult {
  itemKey: string;
  status: "published" | "failed" | "pending";
  providerReceipt?: string;
  errorClass?: string;
}

export function buildPublishDryRunIdempotencyKey(input: {
  destinationId: number;
  snapshotId: number;
  checkerRunId?: number;
  policyVersion: string;
  expectedLastPublishedSha256?: string;
  items: PublishDryRunItemInput[];
}) {
  const items = [...input.items]
    .map(item => ({
      itemKey: item.itemKey,
      episodeId: item.episodeId ?? null,
      sourceSha256: item.sourceSha256.toLowerCase(),
    }))
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey) || (a.episodeId ?? 0) - (b.episodeId ?? 0));
  return createHash("sha256").update(JSON.stringify({
    contract: WORKSPACE_PUBLISH_DRY_RUN_CONTRACT,
    destinationId: input.destinationId,
    snapshotId: input.snapshotId,
    checkerRunId: input.checkerRunId ?? null,
    policyVersion: input.policyVersion,
    expectedLastPublishedSha256: input.expectedLastPublishedSha256?.toLowerCase() ?? null,
    items,
  })).digest("hex");
}

export function derivePublishRetryPlan(input: {
  plannedItems: PublishDryRunItemInput[];
  observedResults: PublishObservedItemResult[];
}) {
  const observedByKey = new Map(input.observedResults.map(result => [result.itemKey, result]));
  const succeeded: PublishObservedItemResult[] = [];
  const retry: PublishDryRunItemInput[] = [];
  const unresolved: PublishDryRunItemInput[] = [];

  for (const item of input.plannedItems) {
    const observed = observedByKey.get(item.itemKey);
    if (observed?.status === "published" && observed.providerReceipt) {
      succeeded.push(observed);
      continue;
    }
    if (observed?.status === "failed") {
      retry.push(item);
      continue;
    }
    unresolved.push(item);
  }

  const aggregateStatus =
    succeeded.length === input.plannedItems.length && input.plannedItems.length > 0
      ? "published"
      : succeeded.length > 0
        ? "partially_failed"
        : retry.length > 0
          ? "failed"
          : "ready";

  return { aggregateStatus, succeeded, retry, unresolved } as const;
}

export function buildPublishOutboxEnvelopeContract(input: {
  workspaceId: number;
  publishRunId: number;
  destinationId: number;
  idempotencyKey: string;
}) {
  return {
    contract: WORKSPACE_PUBLISH_OUTBOX_CONTRACT,
    workspaceId: input.workspaceId,
    publishRunId: input.publishRunId,
    destinationId: input.destinationId,
    idempotencyKey: input.idempotencyKey,
    deliveryEnabled: false as const,
  };
}
