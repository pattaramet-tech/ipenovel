import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../_core/env";
import { resolveManagedWorkspaceAiProviderRuntimeConfig } from "./aiProviderConfig.service";
import { resolveWorkspaceAiQcRuntimeProviderConfig } from "./aiProviderRuntime";

vi.mock("./aiProviderConfig.service", () => ({
  resolveManagedWorkspaceAiProviderRuntimeConfig: vi.fn(),
}));
const managedResolver = vi.mocked(resolveManagedWorkspaceAiProviderRuntimeConfig);
const original = {
  enabled: ENV.workspaceAiQcProviderEnabled,
  apiUrl: ENV.workspaceAiQcProviderApiUrl,
  apiKey: ENV.workspaceAiQcProviderApiKey,
  model: ENV.workspaceAiQcProviderModel,
  name: ENV.workspaceAiQcProviderName,
  timeout: ENV.workspaceAiQcProviderTimeoutMs,
  maxInput: ENV.workspaceAiQcProviderMaxInputChars,
  reconcile: ENV.workspaceAiQcProviderReconcileUrlTemplate,
};

describe("IPE-054-D0 runtime provider resolution", () => {
  beforeEach(() => {
    managedResolver.mockReset();
    ENV.workspaceAiQcProviderEnabled = "true";
  });
  afterEach(() => {
    ENV.workspaceAiQcProviderEnabled = original.enabled;
    ENV.workspaceAiQcProviderApiUrl = original.apiUrl;
    ENV.workspaceAiQcProviderApiKey = original.apiKey;
    ENV.workspaceAiQcProviderModel = original.model;
    ENV.workspaceAiQcProviderName = original.name;
    ENV.workspaceAiQcProviderTimeoutMs = original.timeout;
    ENV.workspaceAiQcProviderMaxInputChars = original.maxInput;
    ENV.workspaceAiQcProviderReconcileUrlTemplate = original.reconcile;
  });

  it("prefers the active database profile over legacy provider ENV", async () => {
    managedResolver.mockResolvedValue({
      profileId: 9,
      profileRevision: 2,
      providerType: "openai_compatible",
      enabled: true,
      apiUrl: "https://managed.example.test/v1/chat/completions",
      apiKey: "managed-key",
      model: "managed-model",
      providerName: "managed",
      timeoutMs: 45000,
      maxInputChars: 250000,
      reconcileUrlTemplate: "https://managed.example.test/v1/chat/completions/{providerRequestId}",
    });
    const resolved = await resolveWorkspaceAiQcRuntimeProviderConfig();
    expect(resolved.source).toBe("database");
    expect(resolved.profileId).toBe(9);
    expect(resolved.config).toMatchObject({ apiKey: "managed-key", model: "managed-model" });
  });

  it("falls back to the existing environment provider when no profile is active", async () => {
    managedResolver.mockResolvedValue(null);
    ENV.workspaceAiQcProviderApiUrl = "https://env.example.test/v1/chat/completions";
    ENV.workspaceAiQcProviderApiKey = "env-key";
    ENV.workspaceAiQcProviderModel = "env-model";
    ENV.workspaceAiQcProviderName = "env-provider";
    ENV.workspaceAiQcProviderTimeoutMs = "5000";
    ENV.workspaceAiQcProviderMaxInputChars = "10000";
    ENV.workspaceAiQcProviderReconcileUrlTemplate = "";
    const resolved = await resolveWorkspaceAiQcRuntimeProviderConfig();
    expect(resolved.source).toBe("environment");
    expect(resolved.profileId).toBeNull();
    expect(resolved.config).toMatchObject({ apiKey: "env-key", model: "env-model" });
  });

  it("keeps the ENV provider opt-in as an independent kill switch", async () => {
    ENV.workspaceAiQcProviderEnabled = "false";
    await expect(resolveWorkspaceAiQcRuntimeProviderConfig())
      .rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(managedResolver).not.toHaveBeenCalled();
  });

  it("supports an active Gemini Interactions profile", async () => {
    managedResolver.mockResolvedValue({
      profileId: 12, profileRevision: 1, providerType: "gemini_interactions", enabled: true,
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
      apiKey: "gemini-key", model: "gemini-3.8-flash", providerName: "gemini",
      timeoutMs: 30000, maxInputChars: 200000, reconcileUrlTemplate: null,
    });
    const resolved = await resolveWorkspaceAiQcRuntimeProviderConfig();
    expect(resolved).toMatchObject({ source: "database", profileId: 12, providerType: "gemini_interactions" });
  });

  it("still fails closed for an active profile whose adapter is not implemented", async () => {
    managedResolver.mockResolvedValue({
      profileId: 13, profileRevision: 1, providerType: "unsupported_vendor", enabled: true,
      apiUrl: "https://vendor.example.test/v1/qc", apiKey: "vendor-key", model: "model", providerName: "vendor",
      timeoutMs: 30000, maxInputChars: 200000, reconcileUrlTemplate: null,
    });
    await expect(resolveWorkspaceAiQcRuntimeProviderConfig())
      .rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });
  });
});