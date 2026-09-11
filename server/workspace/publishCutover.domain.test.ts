import { describe, expect, it } from "vitest";
import { buildPublishCutoverRehearsal, derivePublishCutoverItemPlan } from "./publishCutover.domain";

describe("workspace M05-C publish cutover rehearsal domain", () => {
  it("preserves receipt-backed successes and retries only unresolved items deterministically", () => {
    const items = [
      { itemKey: "done", status: "published" as const, providerReceipt: "receipt-1", sourceSha256: "a".repeat(64) },
      { itemKey: "failed", status: "failed" as const, providerReceipt: null, sourceSha256: "b".repeat(64) },
      { itemKey: "skipped", status: "skipped" as const, providerReceipt: null, sourceSha256: "c".repeat(64) },
    ];
    expect(derivePublishCutoverItemPlan(items)).toEqual({
      succeeded: ["done"],
      retry: ["failed"],
      skipped: ["skipped"],
      publishedMissingReceipt: [],
    });
    const a = buildPublishCutoverRehearsal({
      workspaceId: 1,
      workspaceNovelId: 2,
      publishRunId: 3,
      currentOwner: "sheets",
      currentEpoch: 0,
      readinessDigest: "d".repeat(64),
      blockers: ["UNRESOLVED_PUBLISH_ITEMS"],
      items,
    });
    const b = buildPublishCutoverRehearsal({
      workspaceId: 1,
      workspaceNovelId: 2,
      publishRunId: 3,
      currentOwner: "sheets",
      currentEpoch: 0,
      readinessDigest: "d".repeat(64),
      blockers: ["UNRESOLVED_PUBLISH_ITEMS"],
      items: [...items].reverse(),
    });
    expect(a.rehearsalKey).toBe(b.rehearsalKey);
    expect(a.rollback.preserveSucceededItemKeys).toEqual(["done"]);
    expect(a.rollback.retryItemKeys).toEqual(["failed"]);
    expect(a.cutover.applied).toBe(false);
    expect(a.rollback.applied).toBe(false);
    expect(a.sideEffectsApplied).toBe(false);
  });
});
