import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-054-A AI QC provider security boundaries", () => {
  it("sources the AI QC credential from its dedicated ENV only", () => {
    const env = source("server/_core/env.ts");
    const provider = source("server/workspace/aiQc.provider.ts");
    expect(env).toContain("process.env.WORKSPACE_AI_QC_PROVIDER_API_KEY");
    expect(provider).toContain('Authorization: `Bearer ${config.apiKey}`');
    expect(provider).not.toContain("LLM_API_KEY");
    expect(provider).not.toContain("BUILT_IN_FORGE_API_KEY");
    expect(provider).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
  });

  it("keeps network calls out of the provider-neutral orchestration service", () => {
    const service = source("server/workspace/aiQc.service.ts");
    const provider = source("server/workspace/aiQc.provider.ts");
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini/i);
    expect(provider).toContain("input.fetchImpl(input.url");
  });

  it("wires ENV-backed execution explicitly without adding a scheduler or startup side effect", () => {
    const runtime = source("server/workspace/aiQc.runtime.ts");
    expect(runtime).toContain("createConfiguredWorkspaceAiQcProvider");
    expect(runtime).toContain("executeReadOnlyAiQcAttempt");
    expect(runtime).toContain("allowExternalProvider: true");
    expect(runtime).not.toMatch(/\bsetInterval\s*\(|\bsetTimeout\s*\(|\bapp\.listen\s*\(/i);
  });
  it("does not expose configured execution through the public Workspace router", () => {
    const router = source("server/workspace/router.ts");
    expect(router).not.toContain("executeConfiguredWorkspaceAiQcAttempt");
    expect(router).not.toContain("createConfiguredWorkspaceAiQcProvider");
  });
});
