import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("IPE-054-D0 static safety boundaries", () => {
  it("exposes provider settings only below the existing admin settings router", () => {
    const root = source("server/routers.ts");
    const providerRouter = source("server/workspace/aiProviderSettings.router.ts");
    const workspaceRouter = source("server/workspace/router.ts");
    expect(root).toContain("aiProvider: aiProviderSettingsRouter");
    expect(providerRouter).toContain("authenticatedProcedure.use");
    expect(providerRouter).toContain('ctx.user.role !== "admin"');
    expect(providerRouter).not.toContain("publicProcedure");
    expect(workspaceRouter).not.toContain("aiProviderSettingsRouter");
    expect(workspaceRouter).not.toContain("saveWorkspaceAiProviderProfile");
  });

  it("never exposes plaintext or ciphertext through the safe profile projection", () => {
    const service = source("server/workspace/aiProviderConfig.service.ts");
    const start = service.indexOf("function safeProfile(");
    const end = service.indexOf("function safeAuditMetadata", start);
    const safeProjection = service.slice(start, end);
    expect(safeProjection).toContain("apiKeyMasked");
    expect(safeProjection).not.toContain("apiKeyCiphertext:");
    expect(safeProjection).not.toContain("apiKey:");
    expect(safeProjection).not.toContain("secretContext:");
  });

  it("keeps AI and publish execution kill switches outside admin-managed configuration", () => {
    const env = source("server/_core/env.ts");
    const publishRouter = source("server/workspace/router.ts");
    const settingsRouter = source("server/workspace/aiProviderSettings.router.ts");
    const service = source("server/workspace/aiProviderConfig.service.ts");
    expect(env).toContain("WORKSPACE_AI_QC_EXECUTION_ENABLED");
    expect(publishRouter).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(settingsRouter).not.toContain("workspaceAiQcExecutionEnabled");
    expect(service).not.toContain("workspaceAiQcExecutionEnabled");
    expect(service).not.toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
  });

  it("routes configured execution through the database-aware runtime resolver without public startup wiring", () => {
    const worker = source("server/workspace/aiQc.worker.ts");
    const runtime = source("server/workspace/aiQc.runtime.ts");
    const serverIndex = source("server/_core/index.ts");
    expect(worker).toContain("createRuntimeWorkspaceAiQcProvider");
    expect(runtime).toContain("createRuntimeWorkspaceAiQcProvider");
    expect(serverIndex).not.toContain("aiProviderRuntime");
    expect(serverIndex).not.toContain("runConfiguredPreviewAiQcWorkerOnce");
  });

  it("keeps migration 0045 scoped to provider configuration only", () => {
    const migration = source("drizzle/0045_workspace_ai_provider_config.sql");
    expect(migration).toContain("workspaceAiProviderProfiles");
    expect(migration).toContain("workspaceAiProviderState");
    expect(migration).toContain("workspaceAiProviderAuditLogs");
    expect(migration).not.toContain("accountMerge");
    expect((migration.match(/CREATE TABLE `workspaceAiProvider/g) ?? [])).toHaveLength(3);
  });

  it("keeps the admin page masked and never renders a stored raw API key", () => {
    const ui = source("client/src/components/AdminAiProviderSettings.tsx");
    expect(ui).toContain('type="password"');
    expect(ui).toContain("apiKeyMasked");
    expect(ui).not.toContain("apiKeyCiphertext");
    expect(ui).not.toContain("secretContext");
  });
});


describe("IPE-054-D0 readiness CLI lifecycle", () => {
  it("exits explicitly after the database-aware one-shot readiness check", () => {
    const cli = source("scripts/workspace-ai-qc-preview-readiness.ts");
    expect(cli).toContain("buildConfiguredWorkspaceAiQcPreviewReadiness");
    expect(cli).toContain("process.exit(exitCode)");
  });
});
