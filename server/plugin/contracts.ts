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
 * The identity.whoami result - deliberately excludes email, openId, and
 * every novel/workspace field beyond the bound identity itself.
 */
export type WhoamiResult = {
  userId: number;
  name: string | null;
  role: "user" | "admin";
  scope: string;
  clientId: string;
};

// ---------------------------------------------------------------------------
// IPE-PLUGIN-001C tenant read tool contracts. Every tool takes ONLY resource
// locators (workspaceId/novelId/packId/chapterId) - never a userId, account,
// or authority selector: the tenant set is derived server-side from the
// token's bound users.id (workspaceWorkspaces.ownerUserId OR active
// workspaceMembers). Cross-tenant ids resolve to NOT_FOUND (no existence
// oracle), returned in-band as an isError tool result.
// ---------------------------------------------------------------------------

/** In-band tool failure when a resource id is out-of-tenant or unknown. */
export const PLUGIN_TOOL_NOT_FOUND = "NOT_FOUND";

const positiveInt = z.number().int().positive();

export const WorkspaceListArgsSchema = z.object({}).strict();
export const WorkspaceGetArgsSchema = z.object({ workspaceId: positiveInt }).strict();
export const NovelListArgsSchema = z.object({ workspaceId: positiveInt }).strict();
export const NovelGetArgsSchema = z
  .object({ workspaceId: positiveInt, novelId: positiveInt })
  .strict();
export const PackListArgsSchema = z
  .object({ workspaceId: positiveInt, novelId: positiveInt.optional() })
  .strict();
export const PackGetArgsSchema = z
  .object({ workspaceId: positiveInt, packId: positiveInt })
  .strict();
export const ChapterListArgsSchema = z
  .object({ workspaceId: positiveInt, packId: positiveInt })
  .strict();
export const ChapterGetArgsSchema = z
  .object({ workspaceId: positiveInt, chapterId: positiveInt })
  .strict();

export type PluginWorkspaceSummary = {
  workspaceId: number;
  name: string;
  /** Effective read role of the bound user in this workspace. */
  viewerRole: "owner" | "editor" | "reviewer" | "viewer";
};

export type PluginWorkspaceDetail = PluginWorkspaceSummary & { ownerUserId: number };

export type PluginNovelSummary = {
  workspaceId: number;
  workspaceNovelId: number;
  novelId: number;
  title: string;
  slug: string;
  publicationStatus: "published" | "archived";
  storyStatus: "ongoing" | "finished";
};

export type PluginPackSummary = {
  workspaceId: number;
  packId: number;
  workspaceNovelId: number;
  novelId: number;
  itemKey: string;
  episodeNumber: string | null;
  episodeTitle: string | null;
  price: string | null;
  isFree: boolean | null;
  /** Kanban column key (new/pending_check/needs_fix/editing/pending_confirm/ready_to_publish/published). */
  stage: string | null;
};

export type PluginChapterSummary = {
  workspaceId: number;
  packId: number;
  chapterId: number;
  sourceTabId: string;
  tabOrder: number;
  title: string;
  chapterNumber: string | null;
  chapterTitle: string | null;
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
