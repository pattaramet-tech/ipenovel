import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M04-B read-only AI QC boundaries", () => {
  it("keeps execution provider-neutral and free of built-in network/provider SDKs", () => {
    const service = source("server/workspace/aiQc.service.ts");
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini|api\.openai|generativelanguage/i);
    expect(service).toContain('mode: "mock" | "external"');
    expect(service).toContain("PROVIDER_NOT_EXPLICITLY_ENABLED");
  });

  it("does not expose worker execution through the public Workspace router", () => {
    const router = source("server/workspace/router.ts");
    expect(router).not.toContain("executeReadOnlyAiQcAttempt");
    expect(router).not.toContain("recordAiAttemptProviderReceipt");
  });

  it("keeps Docs content transient and avoids schema/migration changes", () => {
    const service = source("server/workspace/aiQc.service.ts");
    const schema = source("drizzle/schema.ts");
    const journal = source("drizzle/meta/_journal.json");
    expect(service).toContain("normalizeDocsText(rawText)");
    expect(service).not.toMatch(/insert\(workspaceDocumentSnapshots\)|contentObjectKey.*resolved\.content|metadataJson.*content/i);
    expect(schema).not.toContain("workspaceAiQcFindings");
    expect(journal).not.toContain("workspace_ai_qc");
  });

  it("preserves advisory/sheets ownership and forbids workflow side effects", () => {
    const service = source("server/workspace/aiQc.service.ts");
    const domain = source("server/workspace/aiQc.domain.ts");
    expect(domain).toContain("advisory: true");
    expect(service).not.toMatch(/workspaceMigrationRegistry|workspaceKanban|workspacePublish|workspaceOutbox|update.*Document/i);
  });
});
