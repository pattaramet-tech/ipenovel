import type { WorkspaceAiQcProvider } from "./aiQc.service";
import { WorkspaceAiQcExternalProviderError } from "./aiQc.provider";
import {
  GEMINI_STRUCTURED_OUTPUT_PROBE_VARIANTS,
  probeGeminiInteractionsRequestStage,
  probeGeminiInteractionsStructuredOutputVariant,
  type GeminiInteractionsRequestStage,
  type GeminiStructuredOutputProbeVariant,
  type WorkspaceAiQcGeminiInteractionsConfig,
} from "./aiQc.geminiInteractions";
import { resolveWorkspaceAiQcRuntimeProviderConfig } from "./aiProviderRuntime";

export const GEMINI_STAGE_PROBE_ORDER = [
  "minimal",
  "system_instruction",
  "structured_output",
  "stored_sync",
] as const satisfies readonly GeminiInteractionsRequestStage[];

const SYNTHETIC_REQUEST: Parameters<WorkspaceAiQcProvider["execute"]>[0] = {
  requestKey: "d".repeat(64),
  operation: "semantic_qc",
  promptVersion: "workspace-ai-qc-diagnostic-v1",
  modelPolicyVersion: "gemini-interactions-diagnostic-v1",
  snapshotId: 1,
  normalizedSha256: "e".repeat(64),
  content: "Workspace AI QC Gemini Interactions diagnostic probe.",
};

export class WorkspaceAiQcGeminiStageProbeError extends Error {
  constructor(
    readonly code:
      | "DIAGNOSTIC_GUARD_REQUIRED"
      | "DIAGNOSTIC_PROVIDER_INVALID"
      | "DIAGNOSTIC_STAGE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcGeminiStageProbeError";
  }
}

function assertDiagnosticEnvironment(env: NodeJS.ProcessEnv) {
  if (env.WORKSPACE_AI_QC_RUNTIME_TARGET !== "preview") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_GUARD_REQUIRED",
      "Gemini stage probing is Preview-only."
    );
  }
  if (env.WORKSPACE_AI_QC_GEMINI_DIAGNOSTIC_ENABLED !== "true") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_GUARD_REQUIRED",
      "WORKSPACE_AI_QC_GEMINI_DIAGNOSTIC_ENABLED must be explicitly true."
    );
  }
  if (env.WORKSPACE_AI_QC_PROVIDER_ENABLED !== "true") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_GUARD_REQUIRED",
      "WORKSPACE_AI_QC_PROVIDER_ENABLED must remain true for diagnostic credential resolution."
    );
  }
  if (env.WORKSPACE_AI_QC_EXECUTION_ENABLED !== "false") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_GUARD_REQUIRED",
      "WORKSPACE_AI_QC_EXECUTION_ENABLED must be explicitly false during stage probing."
    );
  }
  if (env.WORKSPACE_PUBLISH_EXECUTION_ENABLED !== "false") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_GUARD_REQUIRED",
      "WORKSPACE_PUBLISH_EXECUTION_ENABLED must be explicitly false during stage probing."
    );
  }
}

type ProbeDeps = {
  resolveProvider: typeof resolveWorkspaceAiQcRuntimeProviderConfig;
  probeStage: typeof probeGeminiInteractionsRequestStage;
  probeStructuredOutputVariant: typeof probeGeminiInteractionsStructuredOutputVariant;
};

const defaultDeps: ProbeDeps = {
  resolveProvider: resolveWorkspaceAiQcRuntimeProviderConfig,
  probeStage: probeGeminiInteractionsRequestStage,
  probeStructuredOutputVariant: probeGeminiInteractionsStructuredOutputVariant,
};

export async function runWorkspaceAiQcGeminiStageProbe(input: {
  through: GeminiInteractionsRequestStage;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  deps?: ProbeDeps;
}) {
  const env = input.env ?? process.env;
  assertDiagnosticEnvironment(env);
  const throughIndex = GEMINI_STAGE_PROBE_ORDER.indexOf(input.through);
  if (throughIndex < 0) {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_STAGE_INVALID",
      "Gemini diagnostic stage is invalid."
    );
  }
  const deps = input.deps ?? defaultDeps;
  const resolved = await deps.resolveProvider();
  if (resolved.providerType !== "gemini_interactions") {
    throw new WorkspaceAiQcGeminiStageProbeError(
      "DIAGNOSTIC_PROVIDER_INVALID",
      "The active Workspace AI provider must use the Gemini Interactions adapter."
    );
  }
  const config = resolved.config as WorkspaceAiQcGeminiInteractionsConfig;
  const results: Array<{
    stage: GeminiInteractionsRequestStage;
    accepted: boolean;
    interactionStatus: string | null;
    interactionIdPresent: boolean;
  }> = [];
  const structuredOutputResults: Array<{
    variant: GeminiStructuredOutputProbeVariant;
    accepted: boolean;
    interactionStatus: string | null;
    interactionIdPresent: boolean;
  }> = [];

  for (const stage of GEMINI_STAGE_PROBE_ORDER.slice(0, throughIndex + 1)) {
    if (stage === "structured_output") {
      for (const variant of GEMINI_STRUCTURED_OUTPUT_PROBE_VARIANTS) {
        try {
          const result = await deps.probeStructuredOutputVariant({
            config,
            request: SYNTHETIC_REQUEST,
            variant,
            fetchImpl: input.fetchImpl,
          });
          structuredOutputResults.push(result);
        } catch (error) {
          if (error instanceof WorkspaceAiQcExternalProviderError) {
            return {
              ok: false as const,
              providerSource: resolved.source,
              profileId: resolved.profileId,
              model: config.model,
              through: input.through,
              results,
              structuredOutputResults,
              failedStage: stage,
              failedStructuredOutputVariant: variant,
              error: { code: error.code, message: error.message },
            };
          }
          throw new WorkspaceAiQcGeminiStageProbeError(
            "DIAGNOSTIC_PROVIDER_INVALID",
            "Gemini structured-output probe failed before a sanitized provider result was available."
          );
        }
      }
      const full = structuredOutputResults.at(-1)!;
      results.push({
        stage,
        accepted: true,
        interactionStatus: full.interactionStatus,
        interactionIdPresent: full.interactionIdPresent,
      });
      continue;
    }

    try {
      const result = await deps.probeStage({
        config,
        request: SYNTHETIC_REQUEST,
        stage,
        fetchImpl: input.fetchImpl,
      });
      results.push(result);
    } catch (error) {
      if (error instanceof WorkspaceAiQcExternalProviderError) {
        return {
          ok: false as const,
          providerSource: resolved.source,
          profileId: resolved.profileId,
          model: config.model,
          through: input.through,
          results,
          structuredOutputResults,
          failedStage: stage,
          failedStructuredOutputVariant: null,
          error: { code: error.code, message: error.message },
        };
      }
      throw new WorkspaceAiQcGeminiStageProbeError(
        "DIAGNOSTIC_PROVIDER_INVALID",
        "Gemini diagnostic probe failed before a sanitized provider result was available."
      );
    }
  }

  return {
    ok: true as const,
    providerSource: resolved.source,
    profileId: resolved.profileId,
    model: config.model,
    through: input.through,
    results,
    structuredOutputResults,
    failedStage: null,
    failedStructuredOutputVariant: null,
    error: null,
  };
}
