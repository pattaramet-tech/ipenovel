import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

export type LLMRuntimeMode = "generic" | "legacy_forge";

/**
 * Thrown by invokeLLM() when the provider responds with a non-2xx status -
 * a typed, sanitized alternative to parsing `.message`. Callers that need to
 * decide anything based on the failure (e.g. OCR's bounded transient-retry
 * policy in server/ocr-slip-verification-v2.ts) should check `httpStatus`/
 * `runtimeMode` on this class instead of pattern-matching the message
 * string. `.message` itself stays exactly as sanitized as the plain Error
 * this replaces - never the endpoint URL, the API key, or the upstream
 * response body.
 */
export class LLMInvokeError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly runtimeMode: LLMRuntimeMode
  ) {
    super(`LLM invoke failed: HTTP ${httpStatus} (${runtimeMode})`);
    this.name = "LLMInvokeError";
  }
}

export type LLMRuntimeConfig = {
  mode: LLMRuntimeMode;
  apiUrl: string;
  apiKey: string;
  model: string;
};

export type LLMRuntimeConfigInput = {
  llmApiUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  forgeApiUrl?: string;
  forgeApiKey?: string;
};

const LEGACY_FORGE_MODEL = "gemini-2.5-flash";
const LEGACY_FORGE_DEFAULT_API_URL = "https://forge.manus.im/v1/chat/completions";

/**
 * Rejects anything that isn't a plain, credential-free http(s) URL -
 * deliberately never includes the rejected value itself in the thrown
 * message (an operator-supplied LLM_API_URL is not something this should
 * ever echo back into logs/error responses).
 */
function assertValidGenericApiUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("[LLM] LLM_API_URL is not a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("[LLM] LLM_API_URL must use the http: or https: scheme.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("[LLM] LLM_API_URL must not contain embedded credentials.");
  }
}

/**
 * THE single place LLM_API_URL/LLM_API_KEY/LLM_MODEL vs. the legacy
 * BUILT_IN_FORGE_API_URL/BUILT_IN_FORGE_API_KEY pair is resolved -
 * everything else (invokeLLM below) just uses the result. Pure function
 * (raw strings in, a config or a thrown Error out) so it's testable without
 * touching process.env or module state - see server/_core/llm.test.ts.
 *
 * Precedence, deliberately fail-closed:
 *   - If ANY of LLM_API_URL/LLM_API_KEY/LLM_MODEL is non-empty (after
 *     trim), "generic" mode is explicitly selected and ALL THREE are
 *     required - never falls back to BUILT_IN_FORGE_*, and never mixes a
 *     value from one set with a value from the other (e.g. a generic URL
 *     paired with a Forge key). A partial generic config throws, naming
 *     only the missing variable NAMES.
 *   - Only when none of the three LLM_* vars are set does this fall back
 *     to "legacy_forge": BUILT_IN_FORGE_API_KEY (required),
 *     BUILT_IN_FORGE_API_URL if set (else the historical
 *     forge.manus.im default), and the historical hardcoded model - exactly
 *     current Manus Production behavior, unchanged.
 */
export function resolveLLMRuntimeConfig(input: LLMRuntimeConfigInput): LLMRuntimeConfig {
  const llmApiUrl = (input.llmApiUrl ?? "").trim();
  const llmApiKey = (input.llmApiKey ?? "").trim();
  const llmModel = (input.llmModel ?? "").trim();

  const genericModeSelected = llmApiUrl !== "" || llmApiKey !== "" || llmModel !== "";

  if (genericModeSelected) {
    const missing: string[] = [];
    if (!llmApiUrl) missing.push("LLM_API_URL");
    if (!llmApiKey) missing.push("LLM_API_KEY");
    if (!llmModel) missing.push("LLM_MODEL");
    if (missing.length > 0) {
      throw new Error(
        `[LLM] Incomplete generic LLM configuration - missing: ${missing.join(", ")}. ` +
          "This mode never falls back to legacy Forge configuration once selected."
      );
    }
    assertValidGenericApiUrl(llmApiUrl);
    return { mode: "generic", apiUrl: llmApiUrl, apiKey: llmApiKey, model: llmModel };
  }

  const forgeApiKey = (input.forgeApiKey ?? "").trim();
  if (!forgeApiKey) {
    throw new Error(
      "[LLM] LLM API key is not configured - set LLM_API_URL, LLM_API_KEY, and LLM_MODEL " +
        "(operator-owned provider) or BUILT_IN_FORGE_API_KEY (legacy Manus Forge)."
    );
  }

  const forgeApiUrl = (input.forgeApiUrl ?? "").trim();
  const apiUrl = forgeApiUrl
    ? `${forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : LEGACY_FORGE_DEFAULT_API_URL;

  return { mode: "legacy_forge", apiUrl, apiKey: forgeApiKey, model: LEGACY_FORGE_MODEL };
}

const resolveRuntimeConfig = (): LLMRuntimeConfig =>
  resolveLLMRuntimeConfig({
    llmApiUrl: ENV.llmApiUrl,
    llmApiKey: ENV.llmApiKey,
    llmModel: ENV.llmModel,
    forgeApiUrl: ENV.forgeApiUrl,
    forgeApiKey: ENV.forgeApiKey,
  });

/**
 * Exposes ONLY the resolved mode - never the apiKey or the rest of the
 * runtime config - for callers that need to branch on provider mode without
 * ever touching a secret (see server/services/ocrImageInputService.ts,
 * which needs to know whether to prepare a base64 data URL for a generic
 * provider or leave the existing signed-URL behavior alone for legacy
 * Forge). Reuses resolveRuntimeConfig()/resolveLLMRuntimeConfig() - this
 * file remains the ONLY place generic-vs-legacy_forge precedence is ever
 * decided; nothing else may re-derive it. Throws exactly like
 * resolveRuntimeConfig() does when the LLM isn't configured at all -
 * callers that need a fail-closed default should catch that themselves.
 */
export function getLLMRuntimeMode(): LLMRuntimeMode {
  return resolveRuntimeConfig().mode;
}

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  // Resolved lazily, per call - never at module import - so an
  // unconfigured/misconfigured LLM provider can never crash server startup
  // or block any route other than the one that actually tries to call an
  // LLM (OCR's existing graceful-degradation catch in
  // ocr-slip-verification-v2.ts's parseSlipImage() is what turns this
  // throw into technicalError=true, not this function).
  const config = resolveRuntimeConfig();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
  } = params;

  const payload: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(normalizeMessage),
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  payload.max_tokens = 32768;
  // The `thinking` field is a Forge-specific extension - an arbitrary
  // OpenAI-compatible provider (generic mode) may reject an unrecognized
  // field outright, so it's only ever sent in legacy_forge mode, preserving
  // current Manus Production request behavior unchanged.
  if (config.mode === "legacy_forge") {
    payload.thinking = { budget_tokens: 128 };
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    // Deliberately never includes the upstream response body (may contain
    // the configured endpoint, request echoes, or provider-specific detail)
    // or the endpoint URL itself - OCR's existing catch in
    // ocr-slip-verification-v2.ts logs this Error verbatim via
    // console.error, so it must already be safe to appear in logs as-is.
    throw new LLMInvokeError(response.status, config.mode);
  }

  return (await response.json()) as InvokeResult;
}
