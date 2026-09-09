import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("workspace M05-E final gate boundaries", () => {
  const service = readFileSync(new URL("./publishFinalGate.service.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

  it("remains read-only and introduces no 0044 migration", () => {
    expect(existsSync(new URL("../../drizzle/0044_workspace_publish_final_gate.sql", import.meta.url))).toBe(false);
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(service).not.toMatch(/provider\.execute|provider\.reconcile|fetch\(|axios|OpenAI|Anthropic|Gemini/i);
    expect(service).not.toMatch(/workspaceKanban|\bnovels\b|\bepisodes\b/);
  });

  it("exposes Preview package/gate as queries only and derives execution state from server config", () => {
    expect(router).toContain("publishFinalGate: router({");
    expect(router).toContain("package: authenticatedProcedure");
    expect(router).toContain("requirePreviewReadiness: authenticatedProcedure");
    expect(router).toContain('process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true"');
    const finalGateSlice = router.slice(router.indexOf("publishFinalGate: router({"), router.indexOf("publishCutover: router({"));
    expect(finalGateSlice).toContain(".query(");
    expect(finalGateSlice).not.toContain(".mutation(");
  });

  it("does not invoke M05-D cutover or rollback from the final gate", () => {
    expect(service).not.toMatch(/cutoverPublishOwnership|rollbackPublishOwnership/);
    expect(service).toContain("workspacePublishOwnershipTransitions");
    expect(service).toContain("getPublishCutoverReadiness");
  });
});
