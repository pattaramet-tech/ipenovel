import { describe, expect, it } from "vitest";
import { buildPublishDryRunIdempotencyKey, derivePublishRetryPlan } from "./publishDryRun.domain";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("workspace M05-A publish dry-run domain", () => {
  it("builds deterministic idempotency independent of item input ordering", () => {
    const base = {
      destinationId: 7,
      snapshotId: 11,
      checkerRunId: 13,
      policyVersion: "publish-policy-v1",
      expectedLastPublishedSha256: hashA,
    };
    const first = buildPublishDryRunIdempotencyKey({ ...base, items: [
      { itemKey: "chapter-2", sourceSha256: hashB },
      { itemKey: "chapter-1", sourceSha256: hashA },
    ] });
    const second = buildPublishDryRunIdempotencyKey({ ...base, items: [
      { itemKey: "chapter-1", sourceSha256: hashA },
      { itemKey: "chapter-2", sourceSha256: hashB },
    ] });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never includes published receipt-backed items in retry remainder", () => {
    const plan = derivePublishRetryPlan({
      plannedItems: [
        { itemKey: "chapter-1", sourceSha256: hashA },
        { itemKey: "chapter-2", sourceSha256: hashB },
        { itemKey: "chapter-3", sourceSha256: "c".repeat(64) },
      ],
      observedResults: [
        { itemKey: "chapter-1", status: "published", providerReceipt: "receipt-1" },
        { itemKey: "chapter-2", status: "failed", errorClass: "TEMPORARY" },
      ],
    });
    expect(plan.aggregateStatus).toBe("partially_failed");
    expect(plan.succeeded.map(item => item.itemKey)).toEqual(["chapter-1"]);
    expect(plan.retry.map(item => item.itemKey)).toEqual(["chapter-2"]);
    expect(plan.unresolved.map(item => item.itemKey)).toEqual(["chapter-3"]);
  });
});
