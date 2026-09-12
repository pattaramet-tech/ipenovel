import { ENV } from "../_core/env";
import type { WorkspaceAiQcProvider } from "./aiQc.service";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_INPUT_CHARS = 200_000;
const DEFAULT_PROVIDER_NAME = "openai-compatible";

export class WorkspaceAiQcExternalProviderError extends Error {
  constructor(
    readonly code:
      | "PROVIDER_DISABLED"
      | "PROVIDER_CONFIG_INCOMPLETE"
      | "PROVIDER_CONFIG_INVALID"
      | "PROVIDER_INPUT_TOO_LARGE"
      | "PROVIDER_REQUEST_FAILED"
      | "PROVIDER_RESPONSE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQcExternalProviderError";
  }
}

export interface WorkspaceAiQcProviderRawConfig {
  enabled: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  timeoutMs: string;
  maxInputChars: string;
  reconcileUrlTemplate: string;
}

export type WorkspaceAiQcProviderRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      apiUrl: string;
      apiKey: string;
      model: string;
      providerName: string;
      timeoutMs: number;
      maxInputChars: number;
      reconcileUrlTemplate: string | null;
    };

function rawConfigFromEnv(): WorkspaceAiQcProviderRawConfig {
  return {
    enabled: ENV.workspaceAiQcProviderEnabled,
    apiUrl: ENV.workspaceAiQcProviderApiUrl,
    apiKey: ENV.workspaceAiQcProviderApiKey,
    model: ENV.workspaceAiQcProviderModel,
    providerName: ENV.workspaceAiQcProviderName,
    timeoutMs: ENV.workspaceAiQcProviderTimeoutMs,
    maxInputChars: ENV.workspaceAiQcProviderMaxInputChars,
    reconcileUrlTemplate: ENV.workspaceAiQcProviderReconcileUrlTemplate,
  };
}

function requireBoundedText(raw: string, field: string, max: number) {
  const value = raw.trim();
  if (!value || value.length > max) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      `${field} must be non-empty and no longer than ${max} characters.`
    );
  }
  return value;
}

function parseBoundedPositiveInteger(raw: string, fallback: number, field: string, max: number) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      `${field} must be a positive integer no greater than ${max}.`
    );
  }
  return value;
}

function validateApiUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "WORKSPACE_AI_QC_PROVIDER_API_URL must be an absolute HTTP(S) URL."
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "WORKSPACE_AI_QC_PROVIDER_API_URL must use HTTP or HTTPS."
    );
  }
  if (parsed.username || parsed.password) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Workspace AI QC provider URLs must not embed credentials."
    );
  }
  return parsed.toString();
}

function validateReconcileUrlTemplate(raw: string): string | null {
  const template = raw.trim();
  if (!template) return null;
  const marker = "{providerRequestId}";
  if (template.split(marker).length !== 2) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE must contain {providerRequestId} exactly once."
    );
  }
  const probe = template.replace(marker, "receipt-probe");
  const validated = validateApiUrl(probe);
  const parsed = new URL(validated);
  if (parsed.username || parsed.password) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Workspace AI QC provider URLs must not embed credentials."
    );
  }
  return template;
}

export function resolveWorkspaceAiQcProviderConfig(
  raw: WorkspaceAiQcProviderRawConfig = rawConfigFromEnv()
): WorkspaceAiQcProviderRuntimeConfig {
  if (raw.enabled !== "true") return { enabled: false };

  const missing: string[] = [];
  if (!raw.apiUrl.trim()) missing.push("WORKSPACE_AI_QC_PROVIDER_API_URL");
  if (!raw.apiKey.trim()) missing.push("WORKSPACE_AI_QC_PROVIDER_API_KEY");
  if (!raw.model.trim()) missing.push("WORKSPACE_AI_QC_PROVIDER_MODEL");
  if (missing.length > 0) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INCOMPLETE",
      `Workspace AI QC provider is enabled but required environment variables are missing: ${missing.join(", ")}.`
    );
  }

  return {
    enabled: true,
    apiUrl: validateApiUrl(raw.apiUrl.trim()),
    apiKey: raw.apiKey.trim(),
    model: requireBoundedText(raw.model, "WORKSPACE_AI_QC_PROVIDER_MODEL", 160),
    providerName: raw.providerName.trim()
      ? requireBoundedText(raw.providerName, "WORKSPACE_AI_QC_PROVIDER_NAME", 120)
      : DEFAULT_PROVIDER_NAME,
    timeoutMs: parseBoundedPositiveInteger(
      raw.timeoutMs.trim(),
      DEFAULT_TIMEOUT_MS,
      "WORKSPACE_AI_QC_PROVIDER_TIMEOUT_MS",
      120_000
    ),
    maxInputChars: parseBoundedPositiveInteger(
      raw.maxInputChars.trim(),
      DEFAULT_MAX_INPUT_CHARS,
      "WORKSPACE_AI_QC_PROVIDER_MAX_INPUT_CHARS",
      1_000_000
    ),
    reconcileUrlTemplate: validateReconcileUrlTemplate(raw.reconcileUrlTemplate),
  };
}

type FetchLike = typeof fetch;

interface ChatCompletionResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
}

function readAssistantJson(response: ChatCompletionResponse) {
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "AI QC provider response did not contain a completion choice."
    );
  }
  const first = response.choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "AI QC provider response did not contain JSON message content."
    );
  }
  try {
    return JSON.parse(content) as { findings?: unknown };
  } catch {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "AI QC provider returned malformed JSON content."
    );
  }
}

function buildPrompt(input: Parameters<WorkspaceAiQcProvider["execute"]>[0]) {
  return JSON.stringify({
    contract: "workspace-ai-qc-provider-v1",
    operation: input.operation,
    promptVersion: input.promptVersion,
    modelPolicyVersion: input.modelPolicyVersion,
    snapshotId: input.snapshotId,
    normalizedSha256: input.normalizedSha256,
    instructions: {
      output: "Return one JSON object with a findings array only.",
      categories: ["foreign_word", "typo", "consistency", "duplicate_like", "formatting", "other"],
      severities: ["info", "warning", "error"],
      findingShape: {
        category: "one category above",
        severity: "one severity above",
        locationKey: "stable human-readable location",
        message: "concise advisory finding",
        confidence: "number from 0 to 1",
      },
      constraints: [
        "Do not rewrite or mutate the source content.",
        "Do not include markdown fences or prose outside the JSON object.",
        "Return at most 500 findings.",
      ],
    },
    content: input.content,
  });
}

function mapProviderResult(
  response: ChatCompletionResponse,
  parsed: { findings?: unknown },
  input: { normalizedSha256: string },
  config: Extract<WorkspaceAiQcProviderRuntimeConfig, { enabled: true }>
) {
  if (typeof response.id !== "string" || !response.id.trim()) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "AI QC provider response did not include a request id."
    );
  }
  if (!Array.isArray(parsed.findings)) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "AI QC provider JSON did not include a findings array."
    );
  }
  const findings = parsed.findings.map((value) => {
    const finding = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return {
      category: finding.category,
      severity: finding.severity,
      locationKey: finding.locationKey,
      message: finding.message,
      confidence: finding.confidence,
      evidenceSha256: input.normalizedSha256,
    };
  });
  return {
    providerRequestId: response.id.trim(),
    providerName: config.providerName,
    model: typeof response.model === "string" && response.model.trim() ? response.model.trim() : config.model,
    findings,
  };
}

function resolveReconcileUrl(template: string, providerRequestId: string) {
  const encoded = encodeURIComponent(providerRequestId);
  return template.replace("{providerRequestId}", encoded);
}

async function fetchCompletion(input: {
  url: string;
  init: RequestInit;
  context: { normalizedSha256: string };
  config: Extract<WorkspaceAiQcProviderRuntimeConfig, { enabled: true }>;
  fetchImpl: FetchLike;
  unresolvedOnNotFound?: boolean;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, { ...input.init, signal: controller.signal });
    if (input.unresolvedOnNotFound && (response.status === 404 || response.status === 410)) return null;
    if (!response.ok) {
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_REQUEST_FAILED",
        `AI QC provider request failed with HTTP ${response.status}.`
      );
    }
    let payload: ChatCompletionResponse;
    try {
      payload = await response.json() as ChatCompletionResponse;
    } catch {
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "AI QC provider response body was not valid JSON."
      );
    }
    return mapProviderResult(payload, readAssistantJson(payload), input.context, input.config);
  } catch (error) {
    if (error instanceof WorkspaceAiQcExternalProviderError) throw error;
    const message = error instanceof Error && error.name === "AbortError"
      ? "AI QC provider request timed out."
      : "AI QC provider request failed before a valid response was received.";
    throw new WorkspaceAiQcExternalProviderError("PROVIDER_REQUEST_FAILED", message);
  } finally {
    clearTimeout(timeout);
  }
}

export function createWorkspaceAiQcExternalProvider(
  config: Extract<WorkspaceAiQcProviderRuntimeConfig, { enabled: true }>,
  fetchImpl: FetchLike = fetch
): WorkspaceAiQcProvider {
  const provider: WorkspaceAiQcProvider = {
    mode: "external",
    async execute(input) {
      if (input.content.length > config.maxInputChars) {
        throw new WorkspaceAiQcExternalProviderError(
          "PROVIDER_INPUT_TOO_LARGE",
          `AI QC source exceeds configured maximum input size of ${config.maxInputChars} characters.`
        );
      }
      return fetchCompletion({
        url: config.apiUrl,
        fetchImpl,
        config,
        context: input,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.requestKey,
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            messages: [
              {
                role: "system",
                content: "You are a read-only Thai novel quality-control reviewer. Follow the supplied JSON contract exactly.",
              },
              { role: "user", content: buildPrompt(input) },
            ],
          }),
        },
      });
    },
  };

  if (config.reconcileUrlTemplate) {
    provider.reconcile = async (input) => {
      const result = await fetchCompletion({
        url: resolveReconcileUrl(config.reconcileUrlTemplate!, input.providerRequestId),
        fetchImpl,
        config,
        context: input,
        unresolvedOnNotFound: true,
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
          },
        },
      });
      if (result && result.providerRequestId !== input.providerRequestId) {
        throw new WorkspaceAiQcExternalProviderError(
          "PROVIDER_RESPONSE_INVALID",
          "AI QC provider reconciliation returned a different request id."
        );
      }
      return result;
    };
  }

  return provider;
}
export function createConfiguredWorkspaceAiQcProvider(fetchImpl: FetchLike = fetch) {
  const config = resolveWorkspaceAiQcProviderConfig();
  if (!config.enabled) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_DISABLED",
      "Workspace AI QC external provider is disabled."
    );
  }
  return createWorkspaceAiQcExternalProvider(config, fetchImpl);
}
