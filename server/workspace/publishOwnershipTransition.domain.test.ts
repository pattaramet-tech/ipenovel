import { describe, expect, it } from "vitest";
import { buildPublishOwnershipTransitionIdempotencyKey, transitionTarget } from "./publishOwnershipTransition.domain";

describe("workspace M05-D publish ownership transition domain", () => {
  it("builds deterministic transition identities and monotonic epochs", () => {
    const input = {
      workspaceId: 1,
      workspaceNovelId: 2,
      publishRunId: 3,
      direction: "cutover" as const,
      fromOwner: "sheets" as const,
      toOwner: "workspace" as const,
      fromEpoch: 0,
      toEpoch: 1,
      fromVersion: 1,
      readinessDigest: "a".repeat(64),
    };
    expect(buildPublishOwnershipTransitionIdempotencyKey(input)).toBe(buildPublishOwnershipTransitionIdempotencyKey({ ...input }));
    expect(buildPublishOwnershipTransitionIdempotencyKey(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(transitionTarget("cutover", 0)).toEqual({ fromOwner: "sheets", toOwner: "workspace", toEpoch: 1 });
    expect(transitionTarget("rollback", 7)).toEqual({ fromOwner: "workspace", toOwner: "sheets", toEpoch: 8 });
  });
});
