import { describe, expect, it } from "vitest";
import {
  buildPublishItemRequestKey,
  buildPublishOutboxIdempotencyKey,
  buildPublishOutboxObjectKey,
} from "./publishExecution.domain";

describe("workspace M05-B publish execution domain", () => {
  it("builds deterministic item request and outbox identities", () => {
    const input = {
      publishRunId: 7,
      destinationId: 3,
      policyVersion: "policy-v1",
      itemKey: "chapter-1",
      episodeId: 9,
      sourceSha256: "A".repeat(64),
    };
    expect(buildPublishItemRequestKey(input)).toBe(buildPublishItemRequestKey({ ...input, sourceSha256: "a".repeat(64) }));
    expect(buildPublishItemRequestKey(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(buildPublishOutboxIdempotencyKey(7, "run-key")).toBe(buildPublishOutboxIdempotencyKey(7, "run-key"));
    expect(buildPublishOutboxObjectKey(2, 7)).toContain("workspace/publish/2/runs/7/");
  });
});
