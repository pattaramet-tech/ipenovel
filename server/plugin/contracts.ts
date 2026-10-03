import { z } from "zod";

// Strict wire contracts for the plugin MCP transport skeleton (JSON-RPC 2.0
// over HTTP POST at /api/plugin/mcp). Deliberately narrow: only what the
// read-only identity slice needs. Extra fields are rejected at the envelope
// level the same way the NQA gateway rejects loose envelopes.

/** JSON-RPC 2.0 id: string, number, or null; absent = notification. */
export const JsonRpcIdSchema = z.union([z.string().max(128), z.number().finite()]);

export type JsonRpcId = string | number;

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.optional(),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .strict();

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** MCP tools/call params (only shape the identity slice accepts). */
export const McpToolCallParamsSchema = z
  .object({
    name: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type McpToolCallParams = z.infer<typeof McpToolCallParamsSchema>;

/** The authenticated principal a validated bearer token resolves to. */
export const PluginPrincipalSchema = z
  .object({
    userId: z.number().int().positive(),
    clientId: z.string().min(1),
    authorizationId: z.number().int().positive(),
    scopes: z.array(z.string().min(1)),
    /** sha256 of the presented token - correlation only, never reversible. */
    tokenId: z.string().length(64),
    authenticated: z.literal(true),
  })
  .strict();

export type PluginPrincipal = z.infer<typeof PluginPrincipalSchema>;

/**
 * The identity.whoami result - the ONLY business data this milestone ever
 * returns. Deliberately excludes email, openId, and every novel/workspace
 * field: another ChatGPT account must not be able to learn anything about a
 * user beyond "this is user N" and their display name/role.
 */
export type WhoamiResult = {
  userId: number;
  name: string | null;
  role: "user" | "admin";
  scope: string;
  clientId: string;
};

/** JSON-RPC response builders - fixed shapes, no dynamic keys. */
export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** Server-defined: capability authorization denied (scope/disabled/unknown). */
  AUTHORIZATION_DENIED: -32000,
} as const;
