import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M04-C reconciliation boundaries", () => {
  it("derives operational state without adding schema or migration state", () => {
    const schema = source("drizzle/schema.ts");
    const journal = source("drizzle/meta/_journal.json");
    expect(schema).not.toContain("workspaceAiQcOperational");
    expect(journal).not.toContain("workspace_ai_qc_reconciliation");
  });

  it("exposes membership-gated operational reads but keeps recovery internal", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("getAiQcOperationalReadModel");
    expect(router).toContain("operational: authenticatedProcedure");
    expect(router).not.toContain("recoverAiQcFromProviderReceipt");
  });

  it("never falls back to a new provider execution during receipt recovery", () => {
    const service = source("server/workspace/aiQcReconciliation.service.ts");
    expect(service).toContain("input.provider.reconcile");
    expect(service).not.toMatch(/provider\.execute|fetch\(|axios|OpenAI|Anthropic|Gemini/i);
  });

  it("does not mutate Docs, Kanban, publish, cutover, or migration ownership", () => {
    const service = source("server/workspace/aiQcReconciliation.service.ts");
    expect(service).not.toMatch(/workspaceMigrationRegistry|cutoverEpoch|workspaceKanban|workspacePublish|workspaceOutbox|update\(workspaceDocuments\)|insert\(workspaceDocumentSnapshots\)/i);
  });
});
