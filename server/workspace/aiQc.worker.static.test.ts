import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-054-B scoped AI QC worker boundaries", () => {
  it("requires a separate execution opt-in and exact scope ENV", () => {
    const env = source("server/_core/env.ts");
    const worker = source("server/workspace/aiQc.worker.ts");
    expect(env).toContain("process.env.WORKSPACE_AI_QC_EXECUTION_ENABLED");
    expect(env).toContain("process.env.WORKSPACE_AI_QC_EXECUTION_SCOPE");
    expect(worker).toContain('raw.enabled !== "true"');
    expect(worker).toContain("parseWorkspaceAiQcExecutionScope");
    expect(worker).toContain("scopeMatches");
  });

  it("requires receipt reconciliation before external execution", () => {
    const worker = source("server/workspace/aiQc.worker.ts");
    expect(worker).toContain('input.provider.mode === "external" && !input.provider.reconcile');
    expect(worker).toContain("PROVIDER_RECONCILIATION_REQUIRED");
    expect(worker).toContain("operational.recoveryRequired");
    expect(worker).toContain("recoverReceipt");
  });

  it("does not auto-start or expose worker execution through the public router", () => {
    const worker = source("server/workspace/aiQc.worker.ts");
    const router = source("server/workspace/router.ts");
    const serverIndex = source("server/_core/index.ts");
    expect(worker).not.toMatch(/\bsetInterval\s*\(|\bapp\.listen\s*\(|\bcron\b/i);
    expect(router).not.toContain("runScopedAiQcWorkerOnce");
    expect(router).not.toContain("runConfiguredScopedAiQcWorkerOnce");
    expect(serverIndex).not.toContain("aiQc.worker");
  });

  it("keeps publish, ownership, and Kanban side effects outside the worker", () => {
    const worker = source("server/workspace/aiQc.worker.ts");
    expect(worker).not.toContain("workspacePublish");
    expect(worker).not.toContain("workspaceMigrationRegistry");
    expect(worker).not.toContain("workspaceKanbanTransitions");
    expect(worker).not.toContain("../../drizzle/schema");
  });
});
