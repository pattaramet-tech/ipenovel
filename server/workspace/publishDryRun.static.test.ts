import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const service = readFileSync(new URL("./publishDryRun.service.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../drizzle/schema.ts", import.meta.url), "utf8");

describe("workspace M05-A publish dry-run boundaries", () => {
  it("defines publish destination/run/item/outbox durability without delivery code", () => {
    expect(schema).toContain("workspacePublishingDestinations");
    expect(schema).toContain("workspacePublishRuns");
    expect(schema).toContain("workspacePublishItems");
    expect(schema).toContain("workspaceOutbox");
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini|provider\.execute/i);
  });

  it("never writes novels, episodes, outbox delivery, Docs, Kanban, or cutover ownership", () => {
    expect(service).not.toMatch(/insert\(novels\)|update\(novels\)|insert\(episodes\)|update\(episodes\)/i);
    expect(service).not.toMatch(/insert\(workspaceOutbox\)|update\(workspaceOutbox\)/i);
    expect(service).not.toMatch(/workspaceKanban|workspaceDocuments\b|workspaceMigrationRegistry\)\.set/i);
    expect(service).not.toMatch(/status:\s*"publishing"|status:\s*"published"/i);
  });

  it("exposes only dry-run/reconciliation publish routes", () => {
    expect(router).toContain("publishDryRun: router");
    expect(router).toContain("previewReconciliation");
    expect(router).not.toMatch(/deliverPublish|executePublish|claimOutbox|publishNow/i);
  });

  it("fails closed on ownership and stale-hash contracts while allowing post-cutover planning", () => {
    expect(service).toContain("PUBLISH_OWNERSHIP_AMBIGUOUS");
    expect(service).toContain("STALE_PUBLISH_HASH");
    expect(service).toContain('row.owner === "sheets"');
    expect(service).toContain('row.owner === "workspace"');
    expect(service).toContain("row.cutoverEpoch >= 1");
  });
});
