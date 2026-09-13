import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-054-C Preview AI QC readiness boundaries", () => {
  it("requires the exact Preview runtime target before controlled execution", () => {
    const env = source("server/_core/env.ts");
    const readiness = source("server/workspace/aiQc.previewReadiness.ts");
    expect(env).toContain("process.env.WORKSPACE_AI_QC_RUNTIME_TARGET");
    expect(readiness).toContain('targetValue === "preview"');
    expect(readiness).toContain("readyForControlledExecution");
    expect(readiness).toContain("WorkspaceAiQcPreviewReadinessError");
  });

  it("uses private R2 for AI QC artifacts without exposing public or signed URLs", () => {
    const store = source("server/workspace/aiQc.artifactStore.ts");
    const privateR2 = source("server/services/r2PrivateStorage.ts");
    expect(store).toContain('"workspaceAiQcArtifact"');
    expect(privateR2).toContain('workspaceAiQcArtifact: "workspace/ai-qc/"');
    expect(store).not.toContain("getPrivateObjectSignedUrl");
    expect(store).not.toContain("R2_PUBLIC_BASE_URL");
  });

  it("does not auto-start or expose the Preview worker through public routing", () => {
    const readiness = source("server/workspace/aiQc.previewReadiness.ts");
    const router = source("server/workspace/router.ts");
    const index = source("server/_core/index.ts");
    expect(readiness).not.toMatch(/\bsetInterval\s*\(|\bapp\.listen\s*\(|\bcron\b/i);
    expect(router).not.toContain("runConfiguredPreviewAiQcWorkerOnce");
    expect(index).not.toContain("aiQc.previewReadiness");
  });

  it("keeps Preview readiness free of publish, ownership, Kanban, and direct content writes", () => {
    const readiness = source("server/workspace/aiQc.previewReadiness.ts");
    expect(readiness).not.toContain("workspacePublish");
    expect(readiness).not.toContain("workspaceMigrationRegistry");
    expect(readiness).not.toContain("workspaceKanbanTransitions");
    expect(readiness).not.toContain("novels");
    expect(readiness).not.toContain("episodes");
  });
});
