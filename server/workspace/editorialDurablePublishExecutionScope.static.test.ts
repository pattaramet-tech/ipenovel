import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
describe("IPE-056-T durable publish execution scope", () => {
  it("removes per-run execution scope env from request and worker paths", () => {
    const router = read("server/workspace/router.ts");
    const worker = read("scripts/workspace-publish-worker-once.mts");
    expect(router).not.toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
    expect(worker).not.toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
  });
  it("derives the next exact scope from durable outbox, destination and ownership", () => {
    const service = read("server/workspace/publishExecution.service.ts");
    expect(service).toContain("resolvePendingPublishExecutionScope");
    expect(service).toContain("candidate.outbox.publishRunId");
    expect(service).toContain("candidate.workspaceNovel.id");
    expect(service).toContain("candidate.ownership.cutoverEpoch");
    expect(service).toContain("candidate.ownership.version");
    expect(service).toContain("candidate.outbox.ownershipEpoch !== candidate.ownership.cutoverEpoch");
  });
  it("retains master execution, external-provider and Preview DB safety gates", () => {
    const router = read("server/workspace/router.ts");
    const worker = read("scripts/workspace-publish-worker-once.mts");
    expect(router).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(worker).toContain("WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED");
    expect(worker).toContain("requirePreviewPublishExecutionSafety()");
  });
});
