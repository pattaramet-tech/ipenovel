import type {
  PluginChapterSummary,
  PluginNovelSummary,
  PluginPackSummary,
  PluginWorkspaceDetail,
  PluginWorkspaceSummary,
  WhoamiResult,
} from "../contracts";
import type {
  PluginPackChapter,
  PluginVisibleWorkspace,
  PluginWorkspaceNovel,
  PluginWorkspacePack,
} from "../store";

// IPE-PLUGIN-001B/001C MCP tool handlers - the ONLY business logic reachable
// through the MCP transport skeleton. Every handler receives its data
// loaders injected (never imported) so this module stays pure, unit-testable
// without a database, and free of any server/workspace import (enforced by
// the isolation static test). Tenant visibility itself lives in the store
// queries - handlers only reshape what the boundary already filtered.

export type WhoamiToolDeps = {
  /**
   * Loads the display name/role for a bound user id. Injected rather than
   * imported so this handler stays a pure unit-testable function; the real
   * implementation (see mcp/protocol.ts wiring) reads via the same db
   * override-aware singleton every other server feature uses.
   */
  loadUserDisplay: (userId: number) => Promise<{ name: string | null; role: "user" | "admin" } | null>;
};

export async function handleIdentityWhoami(
  principal: { userId: number; clientId: string; scopes: readonly string[] },
  deps: WhoamiToolDeps
): Promise<WhoamiResult> {
  const user = await deps.loadUserDisplay(principal.userId);
  // The bearer validation joins users already, so a missing row here is a
  // vanishing race (user deleted between validation and tool call) - fail
  // closed with an empty identity rather than fabricating one.
  const name = user?.name ?? null;
  const role = user?.role ?? "user";
  return {
    userId: principal.userId,
    name,
    role,
    scope: Array.from(principal.scopes).sort().join(" "),
    clientId: principal.clientId,
  };
}

// ---------------------------------------------------------------------------
// IPE-PLUGIN-001C tenant read handlers.
//
// A handler returning null means "the requested resource is out-of-tenant or
// does not exist" - the protocol layer turns that into the fixed in-band
// NOT_FOUND tool failure (and audits it). Handlers NEVER accept a userId or
// authority selector: the tenant identity is principal.userId alone, and the
// store queries re-derive visibility inside their own WHERE on every call
// (no check-then-read window).
// ---------------------------------------------------------------------------

export type WorkspaceToolDeps = {
  listVisibleWorkspaces: (userId: number) => Promise<PluginVisibleWorkspace[]>;
  findVisibleWorkspace: (workspaceId: number, userId: number) => Promise<PluginVisibleWorkspace | null>;
  listWorkspaceNovels: (workspaceId: number, userId: number) => Promise<PluginWorkspaceNovel[]>;
  findWorkspaceNovel: (workspaceId: number, novelId: number, userId: number) => Promise<PluginWorkspaceNovel | null>;
  listWorkspacePacks: (workspaceId: number, userId: number) => Promise<PluginWorkspacePack[]>;
  findWorkspacePack: (workspaceId: number, packId: number, userId: number) => Promise<PluginWorkspacePack | null>;
  listPackChapters: (workspaceId: number, packId: number, userId: number) => Promise<PluginPackChapter[]>;
  findPackChapter: (workspaceId: number, chapterId: number, userId: number) => Promise<PluginPackChapter | null>;
};

export async function handleWorkspaceList(
  principal: { userId: number },
  deps: WorkspaceToolDeps
): Promise<{ workspaces: PluginWorkspaceSummary[] }> {
  const rows = await deps.listVisibleWorkspaces(principal.userId);
  return {
    workspaces: rows.map(row => ({
      workspaceId: row.workspaceId,
      name: row.name,
      viewerRole: row.viewerRole,
    })),
  };
}

export async function handleWorkspaceGet(
  principal: { userId: number },
  args: { workspaceId: number },
  deps: WorkspaceToolDeps
): Promise<PluginWorkspaceDetail | null> {
  const row = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  return row
    ? { workspaceId: row.workspaceId, name: row.name, ownerUserId: row.ownerUserId, viewerRole: row.viewerRole }
    : null;
}

export async function handleNovelList(
  principal: { userId: number },
  args: { workspaceId: number },
  deps: WorkspaceToolDeps
): Promise<{ workspaceId: number; novels: PluginNovelSummary[] } | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const novels = await deps.listWorkspaceNovels(args.workspaceId, principal.userId);
  return {
    workspaceId: args.workspaceId,
    novels: novels.map(novel => ({ ...novel, workspaceId: args.workspaceId })),
  };
}

export async function handleNovelGet(
  principal: { userId: number },
  args: { workspaceId: number; novelId: number },
  deps: WorkspaceToolDeps
): Promise<PluginNovelSummary | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const novel = await deps.findWorkspaceNovel(args.workspaceId, args.novelId, principal.userId);
  return novel ? { ...novel, workspaceId: args.workspaceId } : null;
}

export async function handlePackList(
  principal: { userId: number },
  args: { workspaceId: number; novelId?: number },
  deps: WorkspaceToolDeps
): Promise<{ workspaceId: number; packs: PluginPackSummary[] } | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const packs = await deps.listWorkspacePacks(args.workspaceId, principal.userId);
  const filtered = args.novelId === undefined ? packs : packs.filter(pack => pack.novelId === args.novelId);
  return {
    workspaceId: args.workspaceId,
    packs: filtered.map(pack => ({ ...pack, workspaceId: args.workspaceId })),
  };
}

export async function handlePackGet(
  principal: { userId: number },
  args: { workspaceId: number; packId: number },
  deps: WorkspaceToolDeps
): Promise<PluginPackSummary | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const pack = await deps.findWorkspacePack(args.workspaceId, args.packId, principal.userId);
  return pack ? { ...pack, workspaceId: args.workspaceId } : null;
}

export async function handleChapterList(
  principal: { userId: number },
  args: { workspaceId: number; packId: number },
  deps: WorkspaceToolDeps
): Promise<{ workspaceId: number; packId: number; chapters: PluginChapterSummary[] } | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const pack = await deps.findWorkspacePack(args.workspaceId, args.packId, principal.userId);
  if (!pack) return null;
  const chapters = await deps.listPackChapters(args.workspaceId, args.packId, principal.userId);
  return {
    workspaceId: args.workspaceId,
    packId: args.packId,
    chapters: chapters.map(chapter => ({
      ...chapter,
      workspaceId: args.workspaceId,
      packId: args.packId,
    })),
  };
}

export async function handleChapterGet(
  principal: { userId: number },
  args: { workspaceId: number; chapterId: number },
  deps: WorkspaceToolDeps
): Promise<PluginChapterSummary | null> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return null;
  const chapter = await deps.findPackChapter(args.workspaceId, args.chapterId, principal.userId);
  return chapter ? { ...chapter, workspaceId: args.workspaceId } : null;
}
