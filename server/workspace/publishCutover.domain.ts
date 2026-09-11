import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_CUTOVER_CONTRACT = "workspace-publish-cutover-readiness-v1" as const;

export type PublishCutoverBlocker =
  | "DESTINATION_INACTIVE"
  | "SNAPSHOT_NOT_BOUND"
  | "STALE_LAST_PUBLISHED_HASH"
  | "CHECKER_NOT_PASSED"
  | "EMPTY_PUBLISH_RUN"
  | "UNRESOLVED_PUBLISH_ITEMS"
  | "PUBLISHED_ITEM_MISSING_RECEIPT"
  | "OUTBOX_BACKLOG_PRESENT";

export interface PublishCutoverItemState {
  itemKey: string;
  status: "pending" | "publishing" | "published" | "failed" | "skipped";
  providerReceipt?: string | null;
  sourceSha256: string;
}

export function derivePublishCutoverItemPlan(items: PublishCutoverItemState[]) {
  const succeeded = items
    .filter(item => item.status === "published" && Boolean(item.providerReceipt?.trim()))
    .map(item => item.itemKey)
    .sort();
  const retry = items
    .filter(item => item.status !== "published" && item.status !== "skipped")
    .map(item => item.itemKey)
    .sort();
  const skipped = items.filter(item => item.status === "skipped").map(item => item.itemKey).sort();
  const publishedMissingReceipt = items
    .filter(item => item.status === "published" && !item.providerReceipt?.trim())
    .map(item => item.itemKey)
    .sort();
  return { succeeded, retry, skipped, publishedMissingReceipt };
}

export function buildPublishCutoverRehearsal(input: {
  workspaceId: number;
  workspaceNovelId: number;
  publishRunId: number;
  currentOwner: "sheets";
  currentEpoch: number;
  readinessDigest: string;
  blockers: PublishCutoverBlocker[];
  items: PublishCutoverItemState[];
}) {
  const itemPlan = derivePublishCutoverItemPlan(input.items);
  const cutoverEpoch = input.currentEpoch + 1;
  const rollbackEpoch = cutoverEpoch + 1;
  const rehearsalKey = createHash("sha256").update(JSON.stringify({
    contract: WORKSPACE_PUBLISH_CUTOVER_CONTRACT,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    publishRunId: input.publishRunId,
    currentOwner: input.currentOwner,
    currentEpoch: input.currentEpoch,
    readinessDigest: input.readinessDigest,
    blockers: [...input.blockers].sort(),
    succeeded: itemPlan.succeeded,
    retry: itemPlan.retry,
    skipped: itemPlan.skipped,
  })).digest("hex");

  return {
    contract: WORKSPACE_PUBLISH_CUTOVER_CONTRACT,
    rehearsalKey,
    eligibleForCutover: input.blockers.length === 0,
    cutover: {
      from: { owner: "sheets" as const, cutoverEpoch: input.currentEpoch },
      to: { owner: "workspace" as const, cutoverEpoch },
      applied: false as const,
    },
    rollback: {
      from: { owner: "workspace" as const, cutoverEpoch },
      to: { owner: "sheets" as const, cutoverEpoch: rollbackEpoch },
      applied: false as const,
      preserveSucceededItemKeys: itemPlan.succeeded,
      retryItemKeys: itemPlan.retry,
      skippedItemKeys: itemPlan.skipped,
      publishedMissingReceiptItemKeys: itemPlan.publishedMissingReceipt,
    },
    sideEffectsApplied: false as const,
  };
}

export function buildPublishReadinessDigest(input: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
