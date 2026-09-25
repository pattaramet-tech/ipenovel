import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("M12D.13 Controlled Publish environment safety", () => {
  const runtime = read("server/workspace/publishExecution.runtime.ts");
  const execution = read("server/workspace/publishExecution.service.ts");
  const worker = read("scripts/workspace-publish-worker-once.mts");
  const router = read("server/workspace/router.ts");
  const provider = read("server/workspace/ipenovelPublish.provider.ts");

  it("binds real publish to Production or production-staging DB identity", () => {
    expect(runtime).toContain('"production-staging"');
    expect(runtime).toContain("PRODUCTION_DB_FINGERPRINT");
    expect(runtime).toContain("PRODUCTION_STAGING_DB_FINGERPRINT");
    expect(runtime).toContain("Production and production-staging database fingerprints must differ.");
    expect(worker).toContain("requireWorkspacePublishRequestPolicy()");
    expect(router).toContain("requireWorkspacePublishRequestPolicy()");
  });

  it("derives worker scope from queued durable state rather than environment-scoped run input", () => {
    expect(execution).toContain("resolvePendingPublishExecutionScope");
    expect(worker).toContain("resolvePendingPublishExecutionScope()");
    expect(worker).not.toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
    expect(router).not.toContain("WORKSPACE_PUBLISH_EXECUTION_SCOPE");
  });

  it("keeps reader visibility behind the explicit external provider adapter", () => {
    expect(provider).toContain("isPublished: true");
    expect(provider).toContain('publicationStatus: "published"');
    expect(provider).toContain("same transaction as the episode + provider receipt");
    expect(provider).toContain('mode: "external"');
    expect(runtime).toContain('WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true"');
  });
});
