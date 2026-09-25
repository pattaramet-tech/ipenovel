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

  it("uses one environment/DB identity policy plus the external-provider gate", () => {
    const router = read("server/workspace/router.ts");
    const worker = read("scripts/workspace-publish-worker-once.mts");
    const runtime = read("server/workspace/publishExecution.runtime.ts");
    expect(router).toContain("requireWorkspacePublishRequestPolicy");
    expect(worker).toContain("requireWorkspacePublishRequestPolicy");
    expect(runtime).toContain("DEPLOYMENT_ENVIRONMENT");
    expect(runtime).toContain("PRODUCTION_DB_FINGERPRINT");
    expect(runtime).toContain("PRODUCTION_STAGING_DB_FINGERPRINT");
    expect(runtime).toContain("requireWorkspacePublishEnvironmentSafety");
    expect(runtime).toContain("WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED");
  });
});
