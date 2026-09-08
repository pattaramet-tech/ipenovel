import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M05-D publish ownership transition boundaries", () => {
  const service = readFileSync(new URL("./publishOwnershipTransition.service.ts", import.meta.url), "utf8");
  const execution = readFileSync(new URL("./publishExecution.service.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../../drizzle/schema.ts", import.meta.url), "utf8");

  it("defines durable transition receipts and epoch-bound outbox state", () => {
    expect(schema).toContain("workspacePublishOwnershipTransitions");
    expect(schema).toContain('ownershipEpoch: int("ownershipEpoch")');
    expect(schema).toContain("wpot_idempotency_unique");
  });

  it("uses explicit CAS plus transition receipt and audit evidence", () => {
    expect(service).toContain("workspaceMigrationRegistry.version");
    expect(service).toContain("workspacePublishOwnershipTransitions");
    expect(service).toContain("workspaceAuditEvents");
    expect(service).toContain("PUBLISH_OWNERSHIP_CONFLICT");
    expect(service).toContain("PUBLISH_READINESS_BLOCKED");
  });

  it("exposes explicit cutover/rollback mutations but no automatic transition", () => {
    expect(router).toContain("cutoverPublishOwnership");
    expect(router).toContain("rollbackPublishOwnership");
    expect(router).toContain('expectedOwner: z.literal("sheets")');
    expect(router).toContain('expectedOwner: z.literal("workspace")');
    expect(service).not.toMatch(/setInterval|setTimeout|cron|scheduler/i);
  });

  it("keeps transition code free of publication/provider/Docs/Kanban target side effects and hardens execution ownership", () => {
    expect(service).not.toMatch(/fetch\(|axios|OpenAI|Anthropic|Gemini|provider\.execute|provider\.reconcile/i);
    expect(service).not.toMatch(/insert\(novels\)|update\(novels\)|insert\(episodes\)|update\(episodes\)/i);
    expect(service).not.toMatch(/workspaceKanban|workspaceDocuments\b/);
    expect(execution).toContain('rows[0].owner !== "workspace"');
    expect(execution).toContain("expectedCutoverEpoch");
    expect(execution).toContain("ownershipEpoch");
  });
});
