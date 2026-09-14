import { ENV } from "../_core/env";
import {
  createWorkspaceAiQcExternalProvider,
  resolveWorkspaceAiQcProviderConfig,
  WorkspaceAiQcExternalProviderError,
  type WorkspaceAiQcProviderRuntimeConfig,
} from "./aiQc.provider";
import { resolveManagedWorkspaceAiProviderRuntimeConfig } from "./aiProviderConfig.service";

export type WorkspaceAiQcRuntimeProviderSource = "database" | "environment";

export async function resolveWorkspaceAiQcRuntimeProviderConfig(): Promise<{
  source: WorkspaceAiQcRuntimeProviderSource;
  profileId: number | null;
  config: Extract<WorkspaceAiQcProviderRuntimeConfig, { enabled: true }>;
}> {
  if (ENV.workspaceAiQcProviderEnabled !== "true") {
    throw new WorkspaceAiQcExternalProviderError("PROVIDER_DISABLED", "Workspace AI QC external provider is disabled.");
  }

  const managed = await resolveManagedWorkspaceAiProviderRuntimeConfig();
  if (managed) {
    if (managed.providerType !== "openai_compatible") {
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_CONFIG_INVALID",
        `Active Workspace AI provider type ${managed.providerType} does not have an execution adapter yet.`
      );
    }
    return { source: "database", profileId: managed.profileId, config: managed };
  }

  const envConfig = resolveWorkspaceAiQcProviderConfig();
  if (!envConfig.enabled) {
    throw new WorkspaceAiQcExternalProviderError("PROVIDER_DISABLED", "Workspace AI QC external provider is disabled.");
  }
  return { source: "environment", profileId: null, config: envConfig };
}

export async function createRuntimeWorkspaceAiQcProvider(fetchImpl: typeof fetch = fetch) {
  const resolved = await resolveWorkspaceAiQcRuntimeProviderConfig();
  return createWorkspaceAiQcExternalProvider(resolved.config, fetchImpl);
}