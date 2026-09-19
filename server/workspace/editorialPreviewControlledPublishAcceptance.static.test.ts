import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
describe("IPE-056-P Preview Controlled Publish safety gate", () => {
  const runtime = read("server/workspace/publishExecution.runtime.ts");
  const execution = read("server/workspace/publishExecution.service.ts");
  const worker = read("scripts/workspace-publish-worker-once.mts");
  const router = read("server/workspace/router.ts");
  const provider = read("server/workspace/ipenovelPublish.provider.ts");
  it("requires preview acceptance tier and an exact database-name allowlist", () => {
    expect(runtime).toContain("WORKSPACE_PUBLISH_ACCEPTANCE_TIER");
    expect(runtime).toContain("WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME");
    expect(runtime).toContain("PREVIEW_SAFETY_GATE_BLOCKED");
    expect(worker).toContain("requirePreviewPublishExecutionSafety()");
    expect(router).toContain("if (executionEnabled) requirePreviewPublishExecutionSafety()");
  });
  it("requires an exact execution scope even below the router boundary", () => {
    expect(execution).toContain('throw new WorkspacePublishExecutionError("EXECUTION_SCOPE_REQUIRED"');
    expect(runtime).toContain("workspaceNovelId");
    expect(runtime).toContain("expectedOwnershipVersion");
  });
  it("keeps real reader visibility behind the explicit external provider worker", () => {
    expect(provider).toContain("isPublished: true");
    expect(provider).toContain('mode: "external"');
    expect(worker).toContain('WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true"');
    expect(worker).toContain('WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true"');
  });
});
