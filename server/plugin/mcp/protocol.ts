import { z } from "zod";
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_V1_ENABLED_CAPABILITIES,
  authorizePluginCapability,
  type PluginAuditSink,
  type PluginCapability,
  type PluginPermissionScope,
} from "../controlPlane";
import {
  JSONRPC_ERROR_CODES,
  McpToolCallParamsSchema,
  PluginPrincipalSchema,
  JsonRpcRequestSchema,
  PLUGIN_TOOL_CONFLICT,
  PLUGIN_TOOL_NOT_FOUND,
  CheckerGetArgsSchema,
  CheckerRunArgsSchema,
  DraftEditArgsSchema,
  DraftGetArgsSchema,
  WorkspaceGetArgsSchema,
  WorkspaceListArgsSchema,
  NovelGetArgsSchema,
  NovelListArgsSchema,
  PackGetArgsSchema,
  PackListArgsSchema,
  ChapterGetArgsSchema,
  ChapterListArgsSchema,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcId,
  type PluginPrincipal,
} from "../contracts";
import {
  findPluginPackChapter,
  findPluginUserDisplay,
  findPluginVisibleWorkspace,
  findPluginWorkspaceNovel,
  findPluginWorkspacePack,
  listPluginPackChapters,
  listPluginVisibleWorkspaces,
  listPluginWorkspaceNovels,
  listPluginWorkspacePacks,
} from "../store";
// IPE-PLUGIN-001D: the REAL Workspace services, reused VERBATIM (no business
// logic duplication - the plugin layer proves tenant lineage, then delegates
// with actorUserId = principal.userId).
import { getEditorialDraftReadModel } from "../../workspace/editorialDraft.service";
import {
  getEditorialForeignCheckerReadModel,
  runEditorialForeignChecker,
} from "../../workspace/editorialForeignChecker.service";
import { applyEditorialEditorEdit } from "../../workspace/editorialEditor.service";
import { newPluginCorrelationId } from "../audit";
import {
  handleChapterGet,
  handleChapterList,
  handleCheckerGet,
  handleCheckerRun,
  handleDraftEdit,
  handleDraftGet,
  handleIdentityWhoami,
  handleNovelGet,
  handleNovelList,
  handlePackGet,
  handlePackList,
  handleWorkspaceGet,
  handleWorkspaceList,
  type EditorialToolDeps,
  type WorkspaceToolDeps,
} from "./handlers";

// Remove the placeholder duplicate import block if the earlier edit left one
// (getEditorialDraftReadModel etc. were imported from editorialDraft.service
// above - see the IPE-PLUGIN-001D comment).

// IPE-PLUGIN-001B MCP transport skeleton - JSON-RPC 2.0 dispatch over HTTP
// POST. Deliberately the MINIMAL protocol surface: initialize (stateless
// handshake reply), tools/list, tools/call, and notifications/initialized.
// No resources, prompts, completions, logging, or sampling - those
// capabilities are simply not advertised. All security decisions already
// happened at the transport edge (bearer validation + scope authorization
// below); the JSON-RPC layer only routes.

export const PLUGIN_MCP_PROTOCOL_VERSION = "2025-06-18";
export const PLUGIN_MCP_SERVER_NAME = "ipenovel-plugin";

export type McpDispatchDependencies = {
  auditSink: PluginAuditSink;
  now: () => Date;
  loadUserDisplay: (userId: number) => Promise<{ name: string | null; role: "user" | "admin" } | null>;
  /** Tenant read loaders (001C) - server-side boundary implementations. */
  workspaceTools: WorkspaceToolDeps;
  /** Editorial read/mutation deps (001D) - tenant proof + real Workspace services. */
  editorialTools: EditorialToolDeps;
};

export type McpDispatchOutcome =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "notification_accepted"; status: 202 };

/**
 * Loads the minimal display fields identity.whoami may return. Reads via
 * the plugin store (and therefore the db override-aware singleton).
 */
export async function defaultLoadUserDisplay(
  userId: number
): Promise<{ name: string | null; role: "user" | "admin" } | null> {
  return findPluginUserDisplay(userId);
}

/** Default tenant tool loaders - the store functions behind the boundary. */
export function defaultWorkspaceToolDeps(): WorkspaceToolDeps {
  return {
    listVisibleWorkspaces: listPluginVisibleWorkspaces,
    findVisibleWorkspace: findPluginVisibleWorkspace,
    listWorkspaceNovels: listPluginWorkspaceNovels,
    findWorkspaceNovel: findPluginWorkspaceNovel,
    listWorkspacePacks: listPluginWorkspacePacks,
    findWorkspacePack: findPluginWorkspacePack,
    listPackChapters: listPluginPackChapters,
    findPackChapter: findPluginPackChapter,
  };
}

/**
 * Default editorial deps (001D): the 001C tenant proof via the plugin store,
 * then the REAL Workspace services. No editorial business logic lives here.
 */
export function defaultEditorialToolDeps(): EditorialToolDeps {
  return {
    findVisibleWorkspace: findPluginVisibleWorkspace,
    findWorkspacePack: findPluginWorkspacePack,
    // IPE-PLUGIN-001D-R2: the access policy is chosen HERE (server wiring) -
    // never by client input. The service then resolves the caller's EFFECTIVE
    // role from the database (owner via ownerUserId, else active
    // workspaceMembers row) and enforces the policy grade.
    getDraftReadModel: input =>
      getEditorialDraftReadModel({ ...input, accessPolicy: "plugin_read" }),
    getCheckerReadModel: input =>
      getEditorialForeignCheckerReadModel({ ...input, accessPolicy: "plugin_read" }),
    applyEdit: input =>
      applyEditorialEditorEdit({
        ...input,
        accessPolicy: "plugin_edit",
        command: input.command as Parameters<typeof applyEditorialEditorEdit>[0]["command"],
      }),
    runChecker: input =>
      runEditorialForeignChecker({ ...input, accessPolicy: "plugin_checker_run" }),
  };
}

/** Human-readable JSON-schema for each tool's strict arguments object.
 *  `required` defaults to every property; pass an explicit subset to
 *  advertise optional arguments (e.g. pack.list's novelId filter). */
type ToolJsonSchema = {
  type: "object";
  properties: Record<string, { type: string; minimum?: number; description?: string }>;
  required?: string[];
  additionalProperties: false;
};

type EditorCommandJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  oneOf?: unknown[];
};

const TOOL_JSON_SCHEMA_TYPE = "object";

function toolInputSchema(
  properties: ToolJsonSchema["properties"],
  required: string[] = Object.keys(properties)
): ToolJsonSchema {
  return {
    type: TOOL_JSON_SCHEMA_TYPE,
    properties,
    required,
    additionalProperties: false,
  };
}

const WORKSPACE_ID_PROPERTY = { workspaceId: { type: "integer" as const, minimum: 1 } };

/** The draft.edit command oneOf — mirrors DraftEditCommandSchema exactly:
 *  replace_sentence / replace_range carry startOffset+endOffset,
 *  replace_paragraph does not; replace_tab is structurally absent. */
function draftEditCommandJsonSchema(): Record<string, unknown> {
  const paragraphFields = {
    paragraphKey: { type: "string" },
    expectedParagraphFingerprint: { type: "string" },
    expectedText: { type: "string" },
    replacementText: { type: "string" },
  };
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { const: "replace_sentence" },
          ...paragraphFields,
          startOffset: { type: "integer", minimum: 0 },
          endOffset: { type: "integer", minimum: 0 },
        },
        required: ["kind", ...Object.keys(paragraphFields), "startOffset", "endOffset"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "replace_range" },
          ...paragraphFields,
          startOffset: { type: "integer", minimum: 0 },
          endOffset: { type: "integer", minimum: 0 },
        },
        required: ["kind", ...Object.keys(paragraphFields), "startOffset", "endOffset"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "replace_paragraph" }, ...paragraphFields },
        required: ["kind", ...Object.keys(paragraphFields)],
        additionalProperties: false,
      },
    ],
  };
}

/** tools/list is derived from the registry + enable allowlist - never hand-written. */
export function buildPluginToolsList(): Array<{
  name: string;
  description: string;
  inputSchema: ToolJsonSchema | EditorCommandJsonSchema;
}> {
  const schemas: Record<PluginCapability, ToolJsonSchema | EditorCommandJsonSchema> = {
    "identity.whoami": toolInputSchema({}),
    "workspace.list": toolInputSchema({}),
    "workspace.get": toolInputSchema(WORKSPACE_ID_PROPERTY),
    "novel.list": toolInputSchema(WORKSPACE_ID_PROPERTY),
    "novel.get": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, novelId: { type: "integer", minimum: 1 } }),
    "pack.list": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, novelId: { type: "integer" as const, minimum: 1 } }, ["workspaceId"]),
    "pack.get": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, packId: { type: "integer", minimum: 1 } }),
    "chapter.list": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, packId: { type: "integer", minimum: 1 } }),
    "chapter.get": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, chapterId: { type: "integer", minimum: 1 } }),
    "draft.get": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, packId: { type: "integer", minimum: 1 } }),
    "checker.get": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, packId: { type: "integer", minimum: 1 }, runId: { type: "integer", minimum: 1 } }, ["workspaceId", "packId"]),
    "draft.edit": {
      type: TOOL_JSON_SCHEMA_TYPE,
      properties: {
        workspaceId: { type: "integer", minimum: 1 },
        packId: { type: "integer", minimum: 1 },
        expectedDraftId: { type: "integer", minimum: 1 },
        expectedDraftVersion: { type: "integer", minimum: 1 },
        expectedDraftSha256: { type: "string" },
        idempotencyKey: { type: "string" },
        command: draftEditCommandJsonSchema(),
      },
      required: ["workspaceId", "packId", "expectedDraftId", "expectedDraftVersion", "expectedDraftSha256", "command", "idempotencyKey"],
      additionalProperties: false,
    },
    "checker.run": toolInputSchema({ ...WORKSPACE_ID_PROPERTY, packId: { type: "integer", minimum: 1 }, expectedDraftId: { type: "integer", minimum: 1 } }),
  };
  return PLUGIN_V1_ENABLED_CAPABILITIES.map(capability => ({
    name: capability,
    description: PLUGIN_CAPABILITIES[capability].description,
    inputSchema: schemas[capability],
  }));
}

type ToolOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "invalid_params"; message: string }
  | { kind: "not_found" }
  | { kind: "conflict"; code: string }
  | { kind: "denied"; reason: string }
  | { kind: "server_error" };

/**
 * The one dispatch table - registry, args schema, and handler MUST agree for
 * every enabled capability; the isolation static test locks the registry to
 * exactly this set, so a registry-only entry is structurally impossible.
 */
function pluginToolDispatch(
  principal: PluginPrincipal,
  scopes: readonly PluginPermissionScope[],
  deps: McpDispatchDependencies
): Record<
  PluginCapability,
  { argsSchema: z.ZodTypeAny; run: (args: unknown) => Promise<ToolOutcome> }
> {
  const identity = { userId: principal.userId, clientId: principal.clientId, scopes };
  const tenantDeps = deps.workspaceTools;
  return {
    "identity.whoami": {
      argsSchema: WorkspaceListArgsSchema,
      run: async () => ({ kind: "ok", result: await handleIdentityWhoami(identity, deps) }),
    },
    "workspace.list": {
      argsSchema: WorkspaceListArgsSchema,
      run: async () => ({ kind: "ok", result: await handleWorkspaceList({ userId: principal.userId }, tenantDeps) }),
    },
    "workspace.get": {
      argsSchema: WorkspaceGetArgsSchema,
      run: async args => {
        const parsed = WorkspaceGetArgsSchema.parse(args);
        const result = await handleWorkspaceGet({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "novel.list": {
      argsSchema: NovelListArgsSchema,
      run: async args => {
        const parsed = NovelListArgsSchema.parse(args);
        const result = await handleNovelList({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "novel.get": {
      argsSchema: NovelGetArgsSchema,
      run: async args => {
        const parsed = NovelGetArgsSchema.parse(args);
        const result = await handleNovelGet({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "pack.list": {
      argsSchema: PackListArgsSchema,
      run: async args => {
        const parsed = PackListArgsSchema.parse(args);
        const result = await handlePackList({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "pack.get": {
      argsSchema: PackGetArgsSchema,
      run: async args => {
        const parsed = PackGetArgsSchema.parse(args);
        const result = await handlePackGet({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "chapter.list": {
      argsSchema: ChapterListArgsSchema,
      run: async args => {
        const parsed = ChapterListArgsSchema.parse(args);
        const result = await handleChapterList({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "chapter.get": {
      argsSchema: ChapterGetArgsSchema,
      run: async args => {
        const parsed = ChapterGetArgsSchema.parse(args);
        const result = await handleChapterGet({ userId: principal.userId }, parsed, tenantDeps);
        return result === null ? { kind: "not_found" } : { kind: "ok", result };
      },
    },
    "draft.get": {
      argsSchema: DraftGetArgsSchema,
      run: async args => {
        const parsed = DraftGetArgsSchema.parse(args);
        return toToolOutcome(await handleDraftGet({ userId: principal.userId }, parsed, deps.editorialTools));
      },
    },
    "checker.get": {
      argsSchema: CheckerGetArgsSchema,
      run: async args => {
        const parsed = CheckerGetArgsSchema.parse(args);
        return toToolOutcome(await handleCheckerGet({ userId: principal.userId }, parsed, deps.editorialTools));
      },
    },
    "draft.edit": {
      argsSchema: DraftEditArgsSchema,
      run: async args => {
        const parsed = DraftEditArgsSchema.parse(args);
        return toToolOutcome(await handleDraftEdit({ userId: principal.userId }, parsed, deps.editorialTools));
      },
    },
    "checker.run": {
      argsSchema: CheckerRunArgsSchema,
      run: async args => {
        const parsed = CheckerRunArgsSchema.parse(args);
        return toToolOutcome(await handleCheckerRun({ userId: principal.userId }, parsed, deps.editorialTools));
      },
    },
  };
}

/** Maps an EditorialToolStatus to a protocol ToolOutcome (audit-neutral). */
function toToolOutcome(status: import("./handlers").EditorialToolStatus<Record<string, unknown>>): ToolOutcome {
  switch (status.status) {
    case "ok":
      return { kind: "ok", result: status.value };
    case "not_found":
      return { kind: "not_found" };
    case "conflict":
      return { kind: "conflict", code: status.code };
    case "invalid":
      return { kind: "invalid_params", message: status.message };
    case "denied":
      return { kind: "denied", reason: status.reason };
    case "server_error":
      return { kind: "server_error" };
  }
}

function parsePrincipal(input: unknown): PluginPrincipal | null {
  const parsed = PluginPrincipalSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

async function executeAuthorizedTool(
  capability: string,
  rawArgs: unknown,
  principal: PluginPrincipal,
  scopes: readonly PluginPermissionScope[],
  deps: McpDispatchDependencies
): Promise<ToolOutcome> {
  const decision = authorizePluginCapability({
    capability,
    grantedScopes: scopes,
    enabledCapabilities: PLUGIN_V1_ENABLED_CAPABILITIES,
  });
  const correlationId = newPluginCorrelationId();
  const audit = async (eventType: "mcp_tool_allowed" | "mcp_tool_denied", reason: string) => {
    await deps.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType,
      actorUserId: principal.userId,
      clientId: principal.clientId,
      correlationId,
      safeMetadata: JSON.stringify({ capability, reason }),
      createdAt: deps.now().toISOString(),
    });
  };

  if (!decision.allowed) {
    await audit("mcp_tool_denied", decision.reason);
    return { kind: "denied", reason: decision.reason };
  }

  // Registry/allowlist and this dispatch table must agree - the static
  // surface test locks the registry to exactly the keys above, so a missing
  // entry is a build-time-visible programming error, handled fail-closed.
  const dispatch = pluginToolDispatch(principal, scopes, deps)[capability as PluginCapability];
  if (!dispatch) {
    await audit("mcp_tool_denied", "UNKNOWN_CAPABILITY");
    return { kind: "denied", reason: "UNKNOWN_CAPABILITY" };
  }

  const parsedArgs = dispatch.argsSchema.safeParse(rawArgs ?? {});
  if (!parsedArgs.success) {
    return { kind: "invalid_params", message: "Tool arguments failed validation." };
  }

  const outcome = await dispatch.run(parsedArgs.data);
  if (outcome.kind === "not_found") {
    // In-tenant boundary miss: audit it as a deny (with the fixed reason -
    // never the requested ids) but answer in-band as an empty tool failure
    // so no existence oracle is created.
    await audit("mcp_tool_denied", "TENANT_NOT_FOUND");
    return { kind: "not_found" };
  }
  if (outcome.kind === "ok") {
    await audit("mcp_tool_allowed", "ALLOW");
  }
  return outcome;
}

/**
 * Handles ONE already-parsed JSON-RPC message (bearer-validated principal
 * attached). Returns the response body, or notification-accepted.
 */
async function handleMessage(
  message: unknown,
  principal: PluginPrincipal | null,
  scopes: readonly PluginPermissionScope[],
  deps: McpDispatchDependencies
): Promise<McpDispatchOutcome> {
  const parsed = JsonRpcRequestSchema.safeParse(message);
  if (!parsed.success) {
    return {
      kind: "response",
      status: 400,
      body: jsonRpcError(
        null,
        JSONRPC_ERROR_CODES.INVALID_REQUEST,
        "Request failed JSON-RPC 2.0 validation."
      ),
    };
  }
  const request = parsed.data;
  const id = request.id;

  // Notification (no id): acknowledge without a body. Only the one
  // notification the MCP lifecycle defines is accepted; anything else is
  // still a 202 (no response is ever sent for a notification, and emitting
  // errors for them would leak method oracle to unauthenticated probes).
  if (id === undefined) {
    return { kind: "notification_accepted", status: 202 };
  }

  if (!principal) {
    return {
      kind: "response",
      status: 401,
      body: jsonRpcError(null, JSONRPC_ERROR_CODES.INVALID_REQUEST, "Unauthorized."),
    };
  }

  switch (request.method) {
    case "initialize": {
      return {
        kind: "response",
        status: 200,
        body: jsonRpcResult(id, {
          protocolVersion: PLUGIN_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: PLUGIN_MCP_SERVER_NAME, version: "0.1.0" },
        }),
      };
    }
    case "tools/list": {
      return { kind: "response", status: 200, body: jsonRpcResult(id, { tools: buildPluginToolsList() }) };
    }
    case "tools/call": {
      const params = McpToolCallParamsSchema.safeParse(request.params);
      if (!params.success) {
        return {
          kind: "response",
          status: 200,
          body: jsonRpcError(
            id,
            JSONRPC_ERROR_CODES.INVALID_PARAMS,
            "tools/call params failed validation."
          ),
        };
      }
      const outcome = await executeAuthorizedTool(params.data.name, params.data.arguments, principal, scopes, deps);
      if (outcome.kind === "denied") {
        // Registry/scope-level denial - protocol-level error, never in-band.
        return {
          kind: "response",
          status: 200,
          body: jsonRpcError(
            id,
            JSONRPC_ERROR_CODES.AUTHORIZATION_DENIED,
            "Tool call denied.",
            { reason: outcome.reason }
          ),
        };
      }
      if (outcome.kind === "invalid_params") {
        return {
          kind: "response",
          status: 200,
          body: jsonRpcError(id, JSONRPC_ERROR_CODES.INVALID_PARAMS, outcome.message),
        };
      }
      if (outcome.kind === "conflict") {
        // In-band, structured conflict: optimistic concurrency / idempotency.
        // Carries the service error code only - never draft text or payloads.
        return {
          kind: "response",
          status: 200,
          body: jsonRpcResult(id, {
            content: [{ type: "text", text: PLUGIN_TOOL_CONFLICT }],
            structuredContent: { code: outcome.code },
            isError: true,
          }),
        };
      }
      if (outcome.kind === "server_error") {
        // Sanitized: fixed text, never raw DB/driver detail.
        return {
          kind: "response",
          status: 200,
          body: jsonRpcError(id, JSONRPC_ERROR_CODES.SERVER_ERROR, "The tool call failed server-side."),
        };
      }
      if (outcome.kind === "not_found") {
        // In-band, fixed-text empty failure: out-of-tenant and nonexistent
        // ids are indistinguishable by design (no existence oracle).
        return {
          kind: "response",
          status: 200,
          body: jsonRpcResult(id, {
            content: [{ type: "text", text: PLUGIN_TOOL_NOT_FOUND }],
            structuredContent: null,
            isError: true,
          }),
        };
      }
      return {
        kind: "response",
        status: 200,
        body: jsonRpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(outcome.result) }],
          structuredContent: outcome.result,
          isError: false,
        }),
      };
    }
    default:
      return {
        kind: "response",
        status: 200,
        body: jsonRpcError(id, JSONRPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found."),
      };
  }
}

/**
 * Entry point for POST /api/plugin/mcp. `principal` is null whenever the
 * bearer edge rejected the request - the transport answers 401 itself
 * before calling this; a null here only occurs for malformed envelopes.
 */
export async function dispatchPluginMcpRequest(
  body: unknown,
  principal: unknown,
  scopes: readonly PluginPermissionScope[],
  deps: McpDispatchDependencies
): Promise<McpDispatchOutcome> {
  const validatedPrincipal = parsePrincipal(principal);
  const activeScopes = validatedPrincipal ? scopes : [];

  if (Array.isArray(body)) {
    // Batched requests are not part of this skeleton (MCP 2025-06-18 removed
    // JSON-RPC batching) - one deterministic error, no partial processing.
    const id: JsonRpcId | null = null;
    return {
      kind: "response",
      status: 400,
      body: jsonRpcError(id, JSONRPC_ERROR_CODES.INVALID_REQUEST, "Batched requests are not supported."),
    };
  }

  return handleMessage(body, validatedPrincipal, activeScopes, deps);
}
