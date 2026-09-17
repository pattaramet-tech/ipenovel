import { describe, expect, it, vi } from "vitest";
import { WorkspaceAiQcExternalProviderError } from "./aiQc.provider";
import {
  GEMINI_STAGE_PROBE_ORDER,
  runWorkspaceAiQcGeminiStageProbe,
} from "./aiQc.geminiStageProbe";

const env = {
  WORKSPACE_AI_QC_RUNTIME_TARGET: "preview",
  WORKSPACE_AI_QC_GEMINI_DIAGNOSTIC_ENABLED: "true",
  WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
  WORKSPACE_AI_QC_EXECUTION_ENABLED: "false",
  WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false",
} as NodeJS.ProcessEnv;

const managed = {
  source: "database" as const,
  profileId: 1,
  providerType: "gemini_interactions" as const,
  config: {
    enabled: true as const,
    apiUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
    apiKey: "diagnostic-secret-never-print",
    model: "gemini-3.8-flash",
    providerName: "gemini",
    timeoutMs: 30000,
    maxInputChars: 400000,
    reconcileUrlTemplate: null,
  },
};

function deps(
  probeStage = vi.fn(async ({ stage }: any) => ({
    stage,
    accepted: true as const,
    interactionStatus: "completed",
    interactionIdPresent: true,
  }))
) {
  return {
    resolveProvider: vi.fn(async () => managed),
    probeStage,
  } as any;
}

describe("Workspace Gemini Interactions stage probe", () => {
  it("fails closed unless Preview diagnostic guards are explicitly armed", async () => {
    for (const badEnv of [
      { ...env, WORKSPACE_AI_QC_RUNTIME_TARGET: "production" },
      { ...env, WORKSPACE_AI_QC_GEMINI_DIAGNOSTIC_ENABLED: "false" },
      { ...env, WORKSPACE_AI_QC_EXECUTION_ENABLED: "true" },
      { ...env, WORKSPACE_PUBLISH_EXECUTION_ENABLED: "true" },
    ]) {
      await expect(
        runWorkspaceAiQcGeminiStageProbe({
          through: "minimal",
          env: badEnv as NodeJS.ProcessEnv,
          deps: deps(),
        })
      ).rejects.toMatchObject({ code: "DIAGNOSTIC_GUARD_REQUIRED" });
    }
  });

  it("runs stages in order through the requested boundary using synthetic content only", async () => {
    const probeStage = vi.fn(async ({ stage, request }: any) => {
      expect(request.content).toBe(
        "Workspace AI QC Gemini Interactions diagnostic probe."
      );
      return {
        stage,
        accepted: true as const,
        interactionStatus: "completed",
        interactionIdPresent: true,
      };
    });
    const mocked = deps(probeStage);
    const report = await runWorkspaceAiQcGeminiStageProbe({
      through: "stored_sync",
      env,
      deps: mocked,
    });
    expect(report.ok).toBe(true);
    expect(probeStage.mock.calls.map(call => call[0].stage)).toEqual(
      GEMINI_STAGE_PROBE_ORDER
    );
    expect(JSON.stringify(report)).not.toContain(managed.config.apiKey);
    expect(mocked.resolveProvider).toHaveBeenCalledTimes(1);
  });

  it("stops immediately at the first sanitized provider failure", async () => {
    const probeStage = vi.fn(async ({ stage }: any) => {
      if (stage === "system_instruction") {
        throw new WorkspaceAiQcExternalProviderError(
          "PROVIDER_REQUEST_FAILED",
          "Gemini Interactions request failed with HTTP 400 (status=INVALID_ARGUMENT)."
        );
      }
      return {
        stage,
        accepted: true as const,
        interactionStatus: "completed",
        interactionIdPresent: true,
      };
    });
    const report = await runWorkspaceAiQcGeminiStageProbe({
      through: "stored_sync",
      env,
      deps: deps(probeStage),
    });
    expect(report).toMatchObject({
      ok: false,
      failedStage: "system_instruction",
      error: { code: "PROVIDER_REQUEST_FAILED" },
    });
    expect(probeStage.mock.calls.map(call => call[0].stage)).toEqual([
      "minimal",
      "system_instruction",
    ]);
  });

  it("rejects a non-Gemini active provider before any probe request", async () => {
    const probeStage = vi.fn();
    const mocked = {
      resolveProvider: vi.fn(async () => ({
        ...managed,
        providerType: "openai_compatible" as const,
      })),
      probeStage,
    } as any;
    await expect(
      runWorkspaceAiQcGeminiStageProbe({
        through: "minimal",
        env,
        deps: mocked,
      })
    ).rejects.toMatchObject({ code: "DIAGNOSTIC_PROVIDER_INVALID" });
    expect(probeStage).not.toHaveBeenCalled();
  });
});
