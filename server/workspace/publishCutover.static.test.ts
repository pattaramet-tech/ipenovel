import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M05-C publish cutover boundaries", () => {
  const service = readFileSync(new URL("./publishCutover.service.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  const journal = readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8");

  it("keeps the M05-C read model intact while M05-D owns the 0044 transition migration", () => {
    expect(journal).toContain("0043_workspace_publish_dry_run_foundation");
    expect(journal).toContain("0044_workspace_publish_ownership_transition");
  });

  it("retains membership-gated read queries for readiness and rehearsal", () => {
    expect(router).toContain("publishCutover: router");
    expect(router).toContain("getPublishCutoverReadiness");
    expect(router).toContain("rehearsePublishCutoverRollback");
    expect(service).toContain("readOnly: true");
  });

  it("never mutates ownership, publication targets, Docs, Kanban, or outbox/run/item state", () => {
    expect(service).not.toMatch(/update\(workspaceMigrationRegistry\)|insert\(workspaceMigrationRegistry\)|delete\(workspaceMigrationRegistry\)/);
    expect(service).not.toMatch(/update\(workspacePublish|insert\(workspacePublish|delete\(workspacePublish/);
    expect(service).not.toMatch(/update\(workspaceOutbox\)|insert\(workspaceOutbox\)|delete\(workspaceOutbox\)/);
    expect(service).not.toMatch(/workspaceKanban|update\(novels\)|insert\(novels\)|update\(episodes\)|insert\(episodes\)/i);
  });

  it("contains no provider/network delivery path", () => {
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini|provider\.execute|provider\.reconcile/i);
    expect(service).toContain("registryMutationApplied: false");
    expect(service).toContain("publishDeliveryApplied: false");
  });
});
