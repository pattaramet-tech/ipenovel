import { createHash } from "node:crypto";

export const WORKSPACE_PUBLISH_FINAL_GATE_CONTRACT = "workspace-publish-final-gate-v2" as const;

export type PublishFinalGateBlocker =
  | "CUTOVER_READINESS_BLOCKED"
  | "TRANSITION_HISTORY_PRESENT";

export function buildPublishFinalGatePackage(input: {
  workspaceId: number;
  workspaceNovelId: number;
  publishRunId: number;
  readinessDigest: string;
  ownership: { owner: "sheets"; cutoverEpoch: 0; version: number };
  transitionIds: number[];
  inheritedBlockers: string[];
}) {
  const blockers: PublishFinalGateBlocker[] = [];
  if (input.inheritedBlockers.length > 0) blockers.push("CUTOVER_READINESS_BLOCKED");
  if (input.transitionIds.length > 0) blockers.push("TRANSITION_HISTORY_PRESENT");

  const normalized = {
    contract: WORKSPACE_PUBLISH_FINAL_GATE_CONTRACT,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    publishRunId: input.publishRunId,
    readinessDigest: input.readinessDigest,
    ownership: input.ownership,
    transitionIds: [...input.transitionIds].sort((a, b) => a - b),
    inheritedBlockers: [...input.inheritedBlockers].sort(),
    blockers: [...blockers].sort(),
  };
  const packageDigest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

  return {
    ...normalized,
    gateReady: blockers.length === 0,
    operatorCutoverEligible: blockers.length === 0,
    cutoverCommand: {
      expectedOwner: "sheets" as const,
      expectedCutoverEpoch: 0 as const,
      expectedVersion: input.ownership.version,
      automatic: false as const,
    },
    sideEffects: {
      providerDeliveryApplied: false as const,
      registryMutationApplied: false as const,
    },
  };
}
