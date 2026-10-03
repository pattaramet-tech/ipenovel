import {
  PLUGIN_CAPABILITIES,
  PLUGIN_V1_ENABLED_CAPABILITIES,
  authorizePluginCapability,
  type PluginAuditSink,
  type PluginPermissionScope,
} from "../controlPlane";
import {
  JSONRPC_ERROR_CODES,
  McpToolCallParamsSchema,
  PluginPrincipalSchema,
  JsonRpcRequestSchema,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcId,
  type PluginPrincipal,
} from "../contracts";
import { findPluginUserDisplay } from "../store";
import { newPluginCorrelationId } from "../audit";
import { handleIdentityWhoami } from "./handlers";

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

/** tools/list is derived from the registry + enable allowlist - never hand-written. */
export function buildPluginToolsList(): Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never>; additionalProperties: boolean };
}> {
  return PLUGIN_V1_ENABLED_CAPABILITIES.map(capability => {
    const definition = PLUGIN_CAPABILITIES[capability];
    return {
      name: capability,
      description: definition.description,
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: true },
    };
  });
}

function parsePrincipal(input: unknown): PluginPrincipal | null {
  const parsed = PluginPrincipalSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

async function executeAuthorizedTool(
  capability: string,
  principal: PluginPrincipal,
  scopes: readonly PluginPermissionScope[],
  deps: McpDispatchDependencies
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  const decision = authorizePluginCapability({
    capability,
    grantedScopes: scopes,
    enabledCapabilities: PLUGIN_V1_ENABLED_CAPABILITIES,
  });
  const correlationId = newPluginCorrelationId();

  if (!decision.allowed) {
    await deps.auditSink.append({
      auditVersion: "plugin-audit-v1",
      eventType: "mcp_tool_denied",
      actorUserId: principal.userId,
      clientId: principal.clientId,
      correlationId,
      safeMetadata: JSON.stringify({ capability, reason: decision.reason }),
      createdAt: deps.now().toISOString(),
    });
    return { ok: false, reason: decision.reason };
  }

  if (capability !== "identity.whoami") {
    // Registry/allowlist and handlers must agree - a future capability must
    // land in both on the same milestone, never registry-only.
    return { ok: false, reason: "UNKNOWN_CAPABILITY" };
  }

  const result = await handleIdentityWhoami(
    { userId: principal.userId, clientId: principal.clientId, scopes },
    { loadUserDisplay: deps.loadUserDisplay }
  );
  await deps.auditSink.append({
    auditVersion: "plugin-audit-v1",
    eventType: "mcp_tool_allowed",
    actorUserId: principal.userId,
    clientId: principal.clientId,
    correlationId,
    safeMetadata: JSON.stringify({ capability, reason: "ALLOW" }),
    createdAt: deps.now().toISOString(),
  });
  return { ok: true, result };
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
      const outcome = await executeAuthorizedTool(params.data.name, principal, scopes, deps);
      if (!outcome.ok) {
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
