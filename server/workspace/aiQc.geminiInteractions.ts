import type { WorkspaceAiQcProvider } from "./aiQc.service";
import { WorkspaceAiQcExternalProviderError } from "./aiQc.provider";

const GEMINI_API_HOST = "generativelanguage.googleapis.com";
const INTERACTIONS_PATH = /^\/(?:v1|v1beta)\/interactions\/?$/;

export interface WorkspaceAiQcGeminiInteractionsConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  timeoutMs: number;
  maxInputChars: number;
}

type FetchLike = typeof fetch;

type GeminiInteraction = {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  steps?: unknown;
};

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: [
              "foreign_word",
              "typo",
              "consistency",
              "duplicate_like",
              "formatting",
              "other",
            ],
          },
          severity: { type: "string", enum: ["info", "warning", "error"] },
          locationKey: { type: "string" },
          message: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "category",
          "severity",
          "locationKey",
          "message",
          "confidence",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

function buildPrompt(input: Parameters<WorkspaceAiQcProvider["execute"]>[0]) {
  return JSON.stringify({
    contract: "workspace-ai-qc-provider-v1",
    operation: input.operation,
    promptVersion: input.promptVersion,
    modelPolicyVersion: input.modelPolicyVersion,
    snapshotId: input.snapshotId,
    normalizedSha256: input.normalizedSha256,
    instructions: {
      output: "Return one JSON object matching the supplied response schema.",
      constraints: [
        "Do not rewrite or mutate the source content.",
        "Return advisory findings only.",
        "Return at most 500 findings.",
      ],
    },
    content: input.content,
  });
}

export function validateGeminiInteractionsApiUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Gemini Interactions API URL must be an absolute HTTPS URL."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== GEMINI_API_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !INTERACTIONS_PATH.test(url.pathname)
  ) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_CONFIG_INVALID",
      "Gemini Interactions API URL must target the official Google /v1 or /v1beta interactions endpoint without credentials, query, or fragment."
    );
  }
  return url.toString().replace(/\/$/, "");
}
function outputText(interaction: GeminiInteraction) {
  if (!Array.isArray(interaction.steps)) return null;
  const chunks: string[] = [];
  for (const rawStep of interaction.steps) {
    if (!rawStep || typeof rawStep !== "object") continue;
    const step = rawStep as { type?: unknown; content?: unknown };
    if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const rawPart of step.content) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as { type?: unknown; text?: unknown };
      if (part.type === "text" && typeof part.text === "string")
        chunks.push(part.text);
    }
  }
  const text = chunks.join("").trim();
  return text || null;
}

function mapCompletedInteraction(
  interaction: GeminiInteraction,
  normalizedSha256: string,
  config: WorkspaceAiQcGeminiInteractionsConfig,
  expectedRequestId?: string
) {
  if (typeof interaction.id !== "string" || !interaction.id.trim()) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "Gemini Interactions response did not include an Interaction id."
    );
  }
  const providerRequestId = interaction.id.trim();
  if (expectedRequestId && providerRequestId !== expectedRequestId) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "Gemini reconciliation returned a different Interaction id."
    );
  }
  if (interaction.status !== "completed") {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      `Gemini Interaction is not completed (status: ${String(interaction.status ?? "missing")}).`
    );
  }
  const text = outputText(interaction);
  if (!text) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "Gemini completed Interaction did not contain model text output."
    );
  }
  let parsed: { findings?: unknown };
  try {
    parsed = JSON.parse(text) as { findings?: unknown };
  } catch {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "Gemini Interaction returned malformed JSON output."
    );
  }
  if (!Array.isArray(parsed.findings)) {
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_RESPONSE_INVALID",
      "Gemini Interaction JSON did not include a findings array."
    );
  }
  return {
    providerRequestId,
    providerName: config.providerName,
    model:
      typeof interaction.model === "string" && interaction.model.trim()
        ? interaction.model.trim()
        : config.model,
    findings: parsed.findings.map(value => {
      const finding =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      return {
        category: finding.category,
        severity: finding.severity,
        locationKey: finding.locationKey,
        message: finding.message,
        confidence: finding.confidence,
        evidenceSha256: normalizedSha256,
      };
    }),
  };
}

function retrieveUrl(apiUrl: string, providerRequestId: string) {
  return `${apiUrl}/${encodeURIComponent(providerRequestId)}`;
}

const MAX_SAFE_UPSTREAM_TEXT = 600;
const MAX_SAFE_UPSTREAM_SUMMARY = 2000;

function requestSecrets(
  config: WorkspaceAiQcGeminiInteractionsConfig,
  init: RequestInit
) {
  const secrets = [config.apiKey];
  if (typeof init.body !== "string") return secrets;
  try {
    const request = JSON.parse(init.body) as { input?: unknown };
    if (typeof request.input !== "string") return secrets;
    const prompt = JSON.parse(request.input) as { content?: unknown };
    if (typeof prompt.content === "string" && prompt.content)
      secrets.push(prompt.content);
  } catch {
    // The request body is generated locally; ignore extraction failures and keep the API key redaction.
  }
  return secrets;
}

function sanitizeUpstreamText(value: unknown, secrets: string[]) {
  if (typeof value !== "string") return null;
  let sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized ? sanitized.slice(0, MAX_SAFE_UPSTREAM_TEXT) : null;
}

async function safeGeminiErrorSummary(
  response: Response,
  config: WorkspaceAiQcGeminiInteractionsConfig,
  init: RequestInit
) {
  const secrets = requestSecrets(config, init);
  try {
    const payload = (await response.json()) as {
      error?: {
        code?: unknown;
        status?: unknown;
        message?: unknown;
        details?: unknown;
      };
    };
    const error = payload?.error;
    if (!error || typeof error !== "object") return "";
    const parts: string[] = [];
    if (typeof error.code === "number" || typeof error.code === "string") {
      const code = sanitizeUpstreamText(String(error.code), secrets);
      if (code) parts.push(`code=${code.slice(0, 32)}`);
    }
    const status = sanitizeUpstreamText(error.status, secrets);
    if (status) parts.push(`status=${status}`);
    const message = sanitizeUpstreamText(error.message, secrets);
    if (message) parts.push(`message=${message}`);
    if (Array.isArray(error.details)) {
      const violations: string[] = [];
      for (const detail of error.details.slice(0, 5)) {
        if (!detail || typeof detail !== "object") continue;
        const fieldViolations = (detail as { fieldViolations?: unknown })
          .fieldViolations;
        if (!Array.isArray(fieldViolations)) continue;
        for (const violation of fieldViolations.slice(0, 5)) {
          if (!violation || typeof violation !== "object") continue;
          const field = sanitizeUpstreamText(
            (violation as { field?: unknown }).field,
            secrets
          );
          const description = sanitizeUpstreamText(
            (violation as { description?: unknown }).description,
            secrets
          );
          if (field || description)
            violations.push([field, description].filter(Boolean).join(": "));
          if (violations.length >= 5) break;
        }
        if (violations.length >= 5) break;
      }
      if (violations.length) parts.push(`fields=${violations.join(" | ")}`);
    }
    if (!parts.length) return "";
    return ` (${parts.join(", ").slice(0, MAX_SAFE_UPSTREAM_SUMMARY)})`;
  } catch {
    return "";
  }
}

async function fetchInteraction(input: {
  url: string;
  init: RequestInit;
  config: WorkspaceAiQcGeminiInteractionsConfig;
  fetchImpl: FetchLike;
  unresolvedOnNotFound?: boolean;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      ...input.init,
      signal: controller.signal,
    });
    if (
      input.unresolvedOnNotFound &&
      (response.status === 404 || response.status === 410)
    )
      return null;
    if (!response.ok) {
      const safeSummary = await safeGeminiErrorSummary(
        response,
        input.config,
        input.init
      );
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_REQUEST_FAILED",
        `Gemini Interactions request failed with HTTP ${response.status}${safeSummary}.`
      );
    }
    try {
      return (await response.json()) as GeminiInteraction;
    } catch {
      throw new WorkspaceAiQcExternalProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Gemini Interactions response body was not valid JSON."
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceAiQcExternalProviderError) throw error;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Gemini Interactions request timed out."
        : "Gemini Interactions request failed before a valid response was received.";
    throw new WorkspaceAiQcExternalProviderError(
      "PROVIDER_REQUEST_FAILED",
      message
    );
  } finally {
    clearTimeout(timeout);
  }
}
export function createWorkspaceAiQcGeminiInteractionsProvider(
  rawConfig: WorkspaceAiQcGeminiInteractionsConfig,
  fetchImpl: FetchLike = fetch
): WorkspaceAiQcProvider {
  const config = {
    ...rawConfig,
    apiUrl: validateGeminiInteractionsApiUrl(rawConfig.apiUrl),
  };
  return {
    mode: "external",
    async execute(input) {
      if (input.content.length > config.maxInputChars) {
        throw new WorkspaceAiQcExternalProviderError(
          "PROVIDER_INPUT_TOO_LARGE",
          `AI QC source exceeds configured maximum input size of ${config.maxInputChars} characters.`
        );
      }
      const interaction = await fetchInteraction({
        url: config.apiUrl,
        config,
        fetchImpl,
        init: {
          method: "POST",
          headers: {
            "x-goog-api-key": config.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            input: buildPrompt(input),
            system_instruction:
              "You are a read-only Thai novel quality-control reviewer. Return only the requested structured JSON.",
            store: true,
            background: false,
            generation_config: { temperature: 0 },
            response_format: {
              type: "text",
              mime_type: "application/json",
              schema: FINDINGS_SCHEMA,
            },
          }),
        },
      });
      return mapCompletedInteraction(
        interaction!,
        input.normalizedSha256,
        config
      );
    },
    async reconcile(input) {
      const interaction = await fetchInteraction({
        url: retrieveUrl(config.apiUrl, input.providerRequestId),
        config,
        fetchImpl,
        unresolvedOnNotFound: true,
        init: {
          method: "GET",
          headers: {
            "x-goog-api-key": config.apiKey,
            Accept: "application/json",
          },
        },
      });
      if (!interaction) return null;
      if (
        interaction.status === "in_progress" ||
        interaction.status === "requires_action"
      )
        return null;
      return mapCompletedInteraction(
        interaction,
        input.normalizedSha256,
        config,
        input.providerRequestId
      );
    },
  };
}
