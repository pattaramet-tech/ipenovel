import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M05-B publish execution boundaries", () => {
  const service = readFileSync(new URL("./publishExecution.service.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../drizzle/schema.ts", import.meta.url), "utf8");
  const journal = readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8");

  it("retains the M05-A execution schema contract across later ownership migrations", () => {
    expect(schema).toContain("workspaceOutbox");
    expect(schema).toContain("workspacePublishItems");
    expect(journal).toContain("0042_workspace_publish_dry_run_foundation");
  });

  it("keeps worker execution internal and requires explicit server/provider opt-in", () => {
    expect(router).toContain("WORKSPACE_PUBLISH_EXECUTION_ENABLED");
    expect(router).not.toContain("claimPublishOutbox");
    expect(router).not.toContain("processClaimedPublishOutbox");
    expect(service).toContain("allowExternalProvider !== true");
    expect(service).toContain("provider.reconcile(request)");
    expect(service).toContain("reconciled ?? await input.provider.execute(request)");
  });

  it("persists receipt before item terminal success and never mutates migration ownership, Docs, or Kanban", () => {
    const receiptIndex = service.indexOf("providerReceipt: receipt");
    const publishedIndex = service.indexOf('status: "published"');
    expect(receiptIndex).toBeGreaterThan(-1);
    expect(publishedIndex).toBeGreaterThan(receiptIndex);
    expect(service).not.toMatch(/update\(workspaceMigrationRegistry\)|insert\(workspaceMigrationRegistry\)/);
    expect(service).not.toMatch(/workspaceKanban|update\(workspaceDocuments\)|insert\(workspaceDocumentSnapshots\)/);
  });

  it("does not contain built-in network/provider SDK or direct novel/episode target writes", () => {
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini/i);
    expect(service).not.toMatch(/insert\(novels\)|update\(novels\)|insert\(episodes\)|update\(episodes\)/i);
  });
});
