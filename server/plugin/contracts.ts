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

/** In-band tool failure marker for optimistic-concurrency / idempotency conflicts. */
export const PLUGIN_TOOL_CONFLICT = "CONFLICT";

const positiveInt = z.number().int().positive();
const sha256Hex = z.string().trim().regex(/^[a-f0-9]{64}$/);
const idempotencyKey = z.string().trim().min(8).max(255);

export const WorkspaceListArgsSchema = z.object({}).strict();
export const WorkspaceGetArgsSchema = z.object({ workspaceId: positiveInt }).strict();
export const NovelListArgsSchema = z.object({ workspaceId: positiveInt }).strict();
export const NovelGetArgsSchema = z
  .object({ workspaceId: positiveInt, novelId: positiveInt })
  .strict();

// ---------------------------------------------------------------------------
// IPE-PLUGIN-001D editorial tools (draft + checker reads, bounded mutations).
// Every tool reuses the Workspace services verbatim: the plugin layer only
// proves tenant lineage (workspaceId + packId == workItemId) and maps error
// outcomes. draft.edit carries ONLY the three paragraph replace commands -
// replace_tab / full-checker transforms / bulk cleanup / undo are structurally
// absent from the schema, and the service-side idempotency + optimistic
// concurrency (expectedDraftId/Version/Sha256) are passed through untouched.
// ---------------------------------------------------------------------------

export const DraftGetArgsSchema = z
  .object({ workspaceId: positiveInt, packId: positiveInt })
  .strict();

export const CheckerGetArgsSchema = z
  .object({ workspaceId: positiveInt, packId: positiveInt, runId: positiveInt.optional() })
  .strict();

const paragraphEditBase = {
  paragraphKey: sha256Hex,
  expectedParagraphFingerprint: sha256Hex,
  expectedText: z.string().max(200_000),
  replacementText: z.string().max(200_000),
};

/** ONLY the three paragraph replace commands - replace_tab is not in the plugin surface. */
export const DraftEditCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replace_sentence"),
      ...paragraphEditBase,
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace_range"),
      ...paragraphEditBase,
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("replace_paragraph"), ...paragraphEditBase }).strict(),
]);

export const DraftEditArgsSchema = z
  .object({
    workspaceId: positiveInt,
    packId: positiveInt,
    expectedDraftId: positiveInt,
    expectedDraftVersion: positiveInt,
    expectedDraftSha256: sha256Hex,
    command: DraftEditCommandSchema,
    idempotencyKey,
  })
  .strict();

export const CheckerRunArgsSchema = z
  .object({ workspaceId: positiveInt, packId: positiveInt, expectedDraftId: positiveInt })
  .strict();

export type DraftEditCommand = z.infer<typeof DraftEditCommandSchema>;

/** In-band structured conflict payload (optimistic concurrency / idempotency). */
export type PluginToolConflict = {
  /** The workspace service error code, e.g. DRAFT_CONFLICT / EDIT_CONFLICT. */
  code: string;
};

export type PluginDraftSummary = {
  workspaceId: number;
  packId: number;
  draftId: number | null;
  version: number | null;
  draftSha256: string | null;
  origin: string | null;
  refreshPending: boolean;
  tabs: Array<{
    sourceTabId: string;
    tabOrder: number;
    title: string;
    chapterNumber: string | null;
    chapterTitle: string | null;
    structuralSha256: string;
    paragraphs: Array<{
      paragraphKey: string;
      paragraphFingerprint: string;
      paragraphOrder: number;
      text: string;
    }>;
  }>;
};

export type PluginCheckerSummary = {
  workspaceId: number;
  packId: number;
  state:
    | "NOT_RUN"
    | "RUNNING"
    | "STALE"
    | "ERROR"
    | "CURRENT_HAS_FINDINGS"
    | "CURRENT_READY";
  staleReason: "DRAFT_CHANGED" | "ENGINE_CHANGED" | "ALLOW_LIST_CHANGED" | null;
  isCurrent: boolean;
  effectiveStatus: string | null;
  unresolvedCount: number;
  blockingIssueCount: number;
  currentAllowListSha256?: string;
  run: {
    runId: number;
    draftId: number;
    status: "passed" | "failed";
    findingCount: number;
    createdAt: string;
  } | null;
  findings: Array<{
    findingId: number;
    findingKey: string;
    ruleKey: string;
    severity: string;
    paragraphKey: string | null;
    paragraphFingerprint: string | null;
    startOffset: number | null;
    endOffset: number | null;
    sentenceText: string | null;
    message: string;
    disposition: string;
  }>;
};

export type PluginDraftEditOutcome = {
  workspaceId: number;
  packId: number;
  draftId: number;
  version: number;
  draftSha256: string;
  /** true when the same idempotencyKey + same payload was replayed (no new draft). */
  replayed: boolean;
  /** false when a newer draft already exists (caller should re-run draft.get). */
  isCurrent: boolean;
};

export type PluginCheckerRunOutcome = {
  workspaceId: number;
  packId: number;
  /** true when a NEW run row was created; false when the deterministic key reused the existing run. */
  created: boolean;
  runId: number;
  draftId: number;
  state: PluginCheckerSummary["state"];
  staleReason: PluginCheckerSummary["staleReason"];
  isCurrent: boolean;
  effectiveStatus: string | null;
  unresolvedCount: number;
  blockingIssueCount: number;
  /** Kanban projection the service applied - always needs_fix or pending_confirm. */
  kanbanProjection: { changed: boolean; targetColumnKey: string | null; reason: string | null };
};

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
  /** Server-defined: sanitized tool execution failure (never raw DB text). */
  SERVER_ERROR: -32001,
} as const;
