import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("IPE-054-D1 Gemini Interactions security boundaries", () => {
  it("uses the native Gemini auth and stored Interaction contract", () => {
    const adapter = source("server/workspace/aiQc.geminiInteractions.ts");
    expect(adapter).toContain('"x-goog-api-key": config.apiKey');
    expect(adapter).not.toContain("Authorization:");
    expect(adapter).toContain("store: true");
    expect(adapter).toContain("background: false");
    expect(adapter).toContain('mime_type: "application/json"');
  });

  it("pins Gemini secrets to the official Google Interactions host", () => {
    const adapter = source("server/workspace/aiQc.geminiInteractions.ts");
    expect(adapter).toContain(
      'GEMINI_API_HOST = "generativelanguage.googleapis.com"'
    );
    expect(adapter).toContain("INTERACTIONS_PATH");
    expect(adapter).toContain("url.search");
    expect(adapter).toContain("url.hash");
  });

  it("reconciles by GET of the durable Interaction id and never by a custom Gemini receipt URL", () => {
    const adapter = source("server/workspace/aiQc.geminiInteractions.ts");
    const config = source("server/workspace/aiProviderConfig.service.ts");
    expect(adapter).toContain('method: "GET"');
    expect(adapter).toContain("encodeURIComponent(providerRequestId)");
    expect(config).toContain(
      "Gemini Interactions reconciliation URL is derived automatically"
    );
    expect(config).toContain("reconcileUrlTemplate = null");
  });
  it("keeps Gemini execution internal with no startup, scheduler, or public Workspace route", () => {
    const adapter = source("server/workspace/aiQc.geminiInteractions.ts");
    const runtime = source("server/workspace/aiProviderRuntime.ts");
    const serverIndex = source("server/_core/index.ts");
    const workspaceRouter = source("server/workspace/router.ts");
    expect(runtime).toContain("createWorkspaceAiQcGeminiInteractionsProvider");
    expect(serverIndex).not.toContain("aiQc.geminiInteractions");
    expect(workspaceRouter).not.toContain(
      "createWorkspaceAiQcGeminiInteractionsProvider"
    );
    expect(workspaceRouter).not.toContain("gemini_interactions");
    expect(adapter).not.toMatch(/setInterval\(|cron\(|scheduler\(/i);
  });

  it("keeps provider/execution/publish kill switches outside the managed Gemini profile", () => {
    const config = source("server/workspace/aiProviderConfig.service.ts");
    const env = source("server/_core/env.ts");
    const publishRouter = source("server/workspace/router.ts");
    expect(env).toContain("WORKSPACE_AI_QC_PROVIDER_ENABLED");
    expect(env).toContain("WORKSPACE_AI_QC_EXECUTION_ENABLED");
    expect(publishRouter).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(config).not.toContain("workspaceAiQcExecutionEnabled");
    expect(config).not.toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
  });
});
