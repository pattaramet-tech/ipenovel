import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_OWNERSHIP_TRANSITION_CONTRACT = "workspace-publish-ownership-transition-v1" as const;

export type PublishOwnershipDirection = "cutover" | "rollback";
export type PublishOwnershipOwner = "sheets" | "workspace";

export function buildPublishOwnershipTransitionIdempotencyKey(input: {
  workspaceId: number;
  workspaceNovelId: number;
  publishRunId: number;
  direction: PublishOwnershipDirection;
  fromOwner: PublishOwnershipOwner;
  toOwner: PublishOwnershipOwner;
  fromEpoch: number;
  toEpoch: number;
  fromVersion: number;
  readinessDigest: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    contract: WORKSPACE_PUBLISH_OWNERSHIP_TRANSITION_CONTRACT,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    publishRunId: input.publishRunId,
    direction: input.direction,
    fromOwner: input.fromOwner,
    toOwner: input.toOwner,
    fromEpoch: input.fromEpoch,
    toEpoch: input.toEpoch,
    fromVersion: input.fromVersion,
    readinessDigest: input.readinessDigest,
  })).digest("hex");
}

export function transitionTarget(direction: PublishOwnershipDirection, currentEpoch: number) {
  return direction === "cutover"
    ? { fromOwner: "sheets" as const, toOwner: "workspace" as const, toEpoch: currentEpoch + 1 }
    : { fromOwner: "workspace" as const, toOwner: "sheets" as const, toEpoch: currentEpoch + 1 };
}
