import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M05-E final gate boundaries", () => {
  const service = readFileSync(new URL("./publishFinalGate.service.ts", import.meta.url), "utf8");
  const domain = readFileSync(new URL("./publishFinalGate.domain.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

  it("remains read-only and introduces no 0044 migration", () => {
    expect(existsSync(new URL("../../drizzle/0044_workspace_publish_final_gate.sql", import.meta.url))).toBe(false);
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(service).not.toMatch(/provider\.execute|provider\.reconcile|fetch\(|axios|OpenAI|Anthropic|Gemini/i);
    expect(service).not.toMatch(/workspaceKanban|\bnovels\b|\bepisodes\b/);
  });

  it("exposes the package/readiness gate as read-only queries without runtime activation coupling", () => {
    expect(router).toContain("publishFinalGate: router({");
    expect(router).toContain("package: adminProcedure");
    expect(router).toContain("requireReadiness: adminProcedure");
    expect(domain).toContain("gateReady");
    const finalGateSlice = router.slice(router.indexOf("publishFinalGate: router({"), router.indexOf("publishCutover: router({"));
    expect(finalGateSlice).toContain(".query(");
    expect(finalGateSlice).not.toContain(".mutation(");
    expect(finalGateSlice).not.toContain("resolveWorkspacePublishExecutionPolicy");
  });

  it("does not invoke cutover or rollback from the final gate", () => {
    expect(service).not.toMatch(/cutoverPublishOwnership|rollbackPublishOwnership/);
    expect(service).toContain("workspacePublishOwnershipTransitions");
    expect(service).toContain("getPublishCutoverReadiness");
  });
});
