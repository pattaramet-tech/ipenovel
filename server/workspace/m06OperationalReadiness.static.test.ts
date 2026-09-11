import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runM06PreviewBaselineSelfTest,
  validateM06PreviewBaseline,
  type M06BaselineRows,
} from "../../scripts/workspace-m06-preview-baseline.mts";

function validRows(): M06BaselineRows {
  return {
    candidateWorkspace: [{ workspaceId: 2, workspaceNovelId: 2, novelId: 4020002, workspaceStatus: "active", workspaceNovelStatus: "active" }],
    candidateOwnership: [{ capability: "publish", owner: "workspace", cutoverEpoch: 1, version: 2 }],
    candidateTransitions: [{ publishRunId: 2, direction: "cutover", fromOwner: "sheets", toOwner: "workspace", fromEpoch: 0, toEpoch: 1, fromVersion: 1, toVersion: 2 }],
    candidateRun: [{ publishRunId: 2, workspaceNovelId: 2, targetType: "novel", targetId: 4020002, destinationStatus: "active", runStatus: "ready" }],
    candidateItems: [{ status: "published", providerReceipt: "preview-m06-positive-synthetic-receipt" }],
    candidateRunOutbox: [],
    candidateAllOutbox: [],
    candidateFingerprint: [{ lastPublishedSha256: null }],
    controlWorkspace: [{ workspaceNovelId: 1, novelId: 4020003, workspaceNovelStatus: "active" }],
    controlOwnership: [{ capability: "publish", owner: "sheets", cutoverEpoch: 2, version: 3 }],
    controlTransitions: [
      { direction: "cutover", fromOwner: "sheets", toOwner: "workspace", fromEpoch: 0, toEpoch: 1, fromVersion: 1, toVersion: 2 },
      { direction: "rollback", fromOwner: "workspace", toOwner: "sheets", fromEpoch: 1, toEpoch: 2, fromVersion: 2, toVersion: 3 },
    ],
  };
}

describe("M06 Preview read-only baseline verifier", () => {
  it("accepts only the exact synthetic checkpoint and still refuses execution authorization", () => {
    const result = validateM06PreviewBaseline(validRows());
    expect(result.baselinePass).toBe(true);
    expect(result.evidenceClass).toBe("synthetic_checkpoint_only");
    expect(result.executionAuthorizationReady).toBe(false);
    expect(result.executionAuthorizationBlockers).toContain("EXTERNAL_PUBLISH_PROVIDER_NOT_IMPLEMENTED");
    expect(result.executionAuthorizationBlockers).toContain("FRESH_PENDING_OPERATIONAL_RUN_REQUIRED");
  });

  it("fails closed on candidate ownership/version, outbox backlog, or control drift", () => {
    const ownershipDrift = validRows();
    ownershipDrift.candidateOwnership = [{ capability: "publish", owner: "workspace", cutoverEpoch: 1, version: 3 }];
    expect(() => validateM06PreviewBaseline(ownershipDrift)).toThrow(/candidateOwnership\.version/);

    const backlog = validRows();
    backlog.candidateAllOutbox = [{ status: "failed" }];
    expect(() => validateM06PreviewBaseline(backlog)).toThrow(/non-delivered outbox/);

    const controlDrift = validRows();
    controlDrift.controlOwnership = [{ capability: "publish", owner: "workspace", cutoverEpoch: 3, version: 4 }];
    expect(() => validateM06PreviewBaseline(controlDrift)).toThrow(/controlOwnership\.owner/);
  });

  it("has a no-database self-test and contains no SQL mutation or publish-execution calls", () => {
    expect(runM06PreviewBaselineSelfTest()).toEqual({ selfTestPass: true, baselinePass: true, failClosed: true });

    const source = readFileSync(new URL("../../scripts/workspace-m06-preview-baseline.mts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)\b/i);
    expect(source).not.toMatch(/requestPublishExecution|claimPublishOutbox|processClaimedPublishOutbox|cutoverPublishOwnership|rollbackPublishOwnership/);
    expect(source).toContain('if (!/^\\s*SELECT\\b/i.test(sql))');
    expect(source).toContain('WORKSPACE_PUBLISH_EXECUTION_ENABLED !== "false"');
  });
});
