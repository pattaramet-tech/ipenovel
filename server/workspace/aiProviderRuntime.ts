import { ENV } from "../_core/env";
import {
  createWorkspaceAiQcExternalProvider,
  resolveWorkspaceAiQcProviderConfig,
  WorkspaceAiQcExternalProviderError,
  type WorkspaceAiQcProviderRuntimeConfig,
} from "./aiQc.provider";
import { createWorkspaceAiQcGeminiInteractionsProvider } from "./aiQc.geminiInteractions";
import { resolveManagedWorkspaceAiProviderRuntimeConfig } from "./aiProviderConfig.service";

export type WorkspaceAiQcRuntimeProviderSource = "database" | "environment";
export type WorkspaceAiQcRuntimeProviderType = "openai_compatible" | "gemini_interactions";

export async function resolveWorkspaceAiQcRuntimeProviderConfig(): Promise<{
  source: WorkspaceAiQcRuntimeProviderSource;
  profileId: number | null;
  providerType: WorkspaceAiQcRuntimeProviderType;
  config: Extract<WorkspaceAiQcProviderRuntimeConfig, { enabled: true }>;
}> {
  if (ENV.workspaceAiQcProviderEnabled !== "true") {
    throw new WorkspaceAiQcExternalProviderError("PROVIDER_DISABLED", "Workspace AI QC external provider is disabled.");
  }

  const managed = await resolveManagedWorkspaceAiProviderRuntimeConfig();
  if (managed) {
    if (managed.providerType !== "openai_compatible" && managed.providerType !== "gemini_interactions") {
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_CONFIG_INVALID",
        `Active Workspace AI provider type ${managed.providerType} does not have an execution adapter.`
      );    }
    return { source: "database", profileId: managed.profileId, providerType: managed.providerType, config: managed };
  }

  const envConfig = resolveWorkspaceAiQcProviderConfig();
  if (!envConfig.enabled) {
    throw new WorkspaceAiQcExternalProviderError("PROVIDER_DISABLED", "Workspace AI QC external provider is disabled.");
  }
  return { source: "environment", profileId: null, providerType: "openai_compatible", config: envConfig };
}

export async function createRuntimeWorkspaceAiQcProvider(fetchImpl: typeof fetch = fetch) {
  const resolved = await resolveWorkspaceAiQcRuntimeProviderConfig();
  if (resolved.providerType === "gemini_interactions") {
    return createWorkspaceAiQcGeminiInteractionsProvider(resolved.config, fetchImpl);
  }
  return createWorkspaceAiQcExternalProvider(resolved.config, fetchImpl);
}
