import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceAiQcExternalProvider,
  resolveWorkspaceAiQcProviderConfig,
  WorkspaceAiQcExternalProviderError,
  type WorkspaceAiQcProviderRawConfig,
} from "./aiQc.provider";

const raw = (overrides: Partial<WorkspaceAiQcProviderRawConfig> = {}): WorkspaceAiQcProviderRawConfig => ({
  enabled: "true",
  apiUrl: "https://ai.example.test/v1/chat/completions",
  apiKey: "env-only-test-key",
  model: "qc-model-v1",
  providerName: "synthetic-provider",
  timeoutMs: "5000",
  maxInputChars: "10000",
  ...overrides,
});

const input = {
  requestKey: "workspace-ai-request-1",
  operation: "novel_qc",
  promptVersion: "prompt-v1",
  modelPolicyVersion: "policy-v1",
  snapshotId: 41,
  normalizedSha256: "a".repeat(64),
  content: "�����ҷ��ͺ",
};

describe("Workspace AI QC external provider configuration", () => {
  it("is disabled unless the exact opt-in literal is true", () => {
    expect(resolveWorkspaceAiQcProviderConfig(raw({ enabled: "" }))).toEqual({ enabled: false });
    expect(resolveWorkspaceAiQcProviderConfig(raw({ enabled: "TRUE" }))).toEqual({ enabled: false });
  });

  it("fails closed with missing ENV names only and never leaks a configured secret", () => {
    const secret = "do-not-leak-this-api-key";
    let error: unknown;
    try {
      resolveWorkspaceAiQcProviderConfig(raw({ apiUrl: "", apiKey: secret, model: "" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkspaceAiQcExternalProviderError);
    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_INCOMPLETE" });
    expect(String(error)).toContain("WORKSPACE_AI_QC_PROVIDER_API_URL");
    expect(String(error)).toContain("WORKSPACE_AI_QC_PROVIDER_MODEL");
    expect(String(error)).not.toContain(secret);
  });

  it("rejects model/provider labels that exceed the persisted artifact contract", () => {
    expect(() => resolveWorkspaceAiQcProviderConfig(raw({ model: "m".repeat(161) })))
      .toThrow(/WORKSPACE_AI_QC_PROVIDER_MODEL/);
    expect(() => resolveWorkspaceAiQcProviderConfig(raw({ providerName: "p".repeat(121) })))
      .toThrow(/WORKSPACE_AI_QC_PROVIDER_NAME/);
  });
  it("rejects invalid URL and bounded numeric configuration", () => {
    expect(() => resolveWorkspaceAiQcProviderConfig(raw({ apiUrl: "not-a-url" })))
      .toThrow(/WORKSPACE_AI_QC_PROVIDER_API_URL/);
    expect(() => resolveWorkspaceAiQcProviderConfig(raw({ timeoutMs: "0" })))
      .toThrow(/WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS/);
    expect(() => resolveWorkspaceAiQcProviderConfig(raw({ maxInputChars: "1000001" })))
      .toThrow(/WORKSPACE_AI_QC_PROVIDER_MAX_INPUT_CHARS/);
  });
});

describe("Workspace AI QC OpenAI-compatible adapter", () => {
  it("uses the ENV-derived bearer credential, deterministic request key, and maps findings without trusting model hashes", async () => {
    const config = resolveWorkspaceAiQcProviderConfig(raw());
    if (!config.enabled) throw new Error("test config unexpectedly disabled");
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer env-only-test-key");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(input.requestKey);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qc-model-v1");
      expect(JSON.stringify(body)).not.toContain("env-only-test-key");
      return new Response(JSON.stringify({
        id: "provider-request-123",
        model: "qc-model-v1-actual",
        choices: [{
          message: {
            content: JSON.stringify({
              findings: [{
                category: "typo",
                severity: "warning",
                locationKey: "paragraph:3",
                message: "���ӷ���õ�Ǩ�ͺ",
                confidence: 0.91,
                evidenceSha256: "b".repeat(64),
              }],
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = createWorkspaceAiQcExternalProvider(config, fetchMock as typeof fetch);
    const result = await provider.execute(input) as any;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      providerRequestId: "provider-request-123",
      providerName: "synthetic-provider",
      model: "qc-model-v1-actual",
      findings: [{
        category: "typo",
        severity: "warning",
        locationKey: "paragraph:3",
        message: "���ӷ���õ�Ǩ�ͺ",
        confidence: 0.91,
        evidenceSha256: input.normalizedSha256,
      }],
    });
  });

  it("fails without sending a request when source content exceeds the configured bound", async () => {
    const config = resolveWorkspaceAiQcProviderConfig(raw({ maxInputChars: "4" }));
    if (!config.enabled) throw new Error("test config unexpectedly disabled");
    const fetchMock = vi.fn();
    const provider = createWorkspaceAiQcExternalProvider(config, fetchMock as typeof fetch);
    await expect(provider.execute({ ...input, content: "12345" }))
      .rejects.toMatchObject({ code: "PROVIDER_INPUT_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes non-success provider errors without returning response bodies", async () => {
    const config = resolveWorkspaceAiQcProviderConfig(raw());
    if (!config.enabled) throw new Error("test config unexpectedly disabled");
    const fetchMock = vi.fn(async () => new Response("upstream-secret-body", { status: 429 }));
    const provider = createWorkspaceAiQcExternalProvider(config, fetchMock as typeof fetch);
    let error: unknown;
    try {
      await provider.execute(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
    expect(String(error)).toContain("HTTP 429");
    expect(String(error)).not.toContain("upstream-secret-body");
  });
});
