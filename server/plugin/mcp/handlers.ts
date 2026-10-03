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

// IPE-PLUGIN-001B/001C/001D MCP tool handlers - the ONLY business logic
// reachable through the MCP transport skeleton. Every handler receives its
// data loaders injected (never imported) so this module stays pure,
// unit-testable without a database. The 001D editorial handlers delegate to
// the REAL Workspace services via deps (the protocol wires the actual
// functions) - the plugin layer never re-implements editorial business
// logic; it only proves tenant lineage and reshapes the service result.

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
// IPE-PLUGIN-001C tenant read handlers (workspace/novel/pack/chapter).
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

// ---------------------------------------------------------------------------
// IPE-PLUGIN-001D editorial tools - draft/checker reads + bounded mutations.
//
// Pure orchestrators: tenant lineage is proven FIRST (the 001C boundary -
// foreign / paused / unlinked / missing packs are all indistinguishable
// NOT_FOUND), then the REAL Workspace services are invoked via deps with
// actorUserId = principal.userId (never client-supplied). Service failures
// are mapped to typed statuses by ERROR CODE only (no workspace class
// imports, no message sniffing):
//   *_NOT_FOUND                       -> not_found
//   ADMIN_REQUIRED                    -> denied (Workspace is an admin
//                                        back-office; the plugin inherits
//                                        that gate verbatim)
//   *_CONFLICT / STALE_PREVIEW /
//   REFRESH_REQUIRES_REVIEW /
//   UNDO_NOT_AVAILABLE                -> conflict (client-recoverable:
//                                        re-run draft.get and echo fresh
//                                        identity fields)
//   EDIT_INVALID / ALLOW_WORD_INVALID /
//   ANOMALY_CONFIRM_INVALID /
//   SOURCE_INVALID                    -> invalid
//   DATABASE_UNAVAILABLE / other      -> server_error (never raw DB text)
// ---------------------------------------------------------------------------

export type EditorialServiceError = { code?: string };

export type EditorialToolStatus<T> =
  | { status: "ok"; value: T }
  | { status: "not_found" }
  | { status: "conflict"; code: string }
  | { status: "invalid"; message: string }
  | { status: "denied"; reason: string }
  | { status: "server_error" };

function mapEditorialServiceError(error: unknown): EditorialToolStatus<never> {
  const code = (error as EditorialServiceError | null)?.code ?? "";
  if (code.endsWith("_NOT_FOUND")) {
    return { status: "not_found" };
  }
  if (code === "ADMIN_REQUIRED") {
    return { status: "denied", reason: "ADMIN_REQUIRED" };
  }
  if (
    code.endsWith("_CONFLICT") ||
    code === "STALE_PREVIEW" ||
    code === "REFRESH_REQUIRES_REVIEW" ||
    code === "UNDO_NOT_AVAILABLE"
  ) {
    return { status: "conflict", code: code || "CONFLICT" };
  }
  if (
    code === "EDIT_INVALID" ||
    code === "ALLOW_WORD_INVALID" ||
    code === "ANOMALY_CONFIRM_INVALID" ||
    code === "SOURCE_INVALID"
  ) {
    return { status: "invalid", message: "The edit payload was rejected by the editorial service." };
  }
  return { status: "server_error" };
}

export type EditorialToolDeps = {
  /** 001C tenant boundary - the same owner-or-active-member proof every read tool uses. */
  findVisibleWorkspace: (workspaceId: number, userId: number) => Promise<PluginVisibleWorkspace | null>;
  findWorkspacePack: (workspaceId: number, packId: number, userId: number) => Promise<PluginWorkspacePack | null>;
  /** Workspace services, reused VERBATIM (actorUserId is always principal.userId). */
  getDraftReadModel: (input: {
    actorUserId: number;
    workspaceId: number;
    workItemId: number;
  }) => Promise<unknown>;
  getCheckerReadModel: (input: {
    actorUserId: number;
    workspaceId: number;
    workItemId: number;
    runId?: number;
  }) => Promise<unknown>;
  applyEdit: (input: {
    actorUserId: number;
    workspaceId: number;
    workItemId: number;
    expectedDraftId: number;
    expectedDraftVersion: number;
    expectedDraftSha256: string;
    command: unknown;
    idempotencyKey: string;
  }) => Promise<unknown>;
  runChecker: (input: {
    actorUserId: number;
    workspaceId: number;
    workItemId: number;
    expectedDraftId?: number;
  }) => Promise<unknown>;
};

async function provePackLineage(
  principal: { userId: number },
  args: { workspaceId: number; packId: number },
  deps: EditorialToolDeps
): Promise<boolean> {
  const workspace = await deps.findVisibleWorkspace(args.workspaceId, principal.userId);
  if (!workspace) return false;
  // packId IS workspaceEditorialWorkItems.id; the pack query enforces the
  // ACTIVE novel binding + editorial board + package saleMode, so paused /
  // unlinked / foreign packs all resolve to null here (fail closed).
  const pack = await deps.findWorkspacePack(args.workspaceId, args.packId, principal.userId);
  return pack !== null;
}

export async function handleDraftGet(
  principal: { userId: number },
  args: { workspaceId: number; packId: number },
  deps: EditorialToolDeps
): Promise<EditorialToolStatus<Record<string, unknown>>> {
  if (!(await provePackLineage(principal, args, deps))) return { status: "not_found" };
  try {
    const raw = (await deps.getDraftReadModel({
      actorUserId: principal.userId,
      workspaceId: args.workspaceId,
      workItemId: args.packId,
    })) as Record<string, unknown>;
    const latestDraft = (raw.latestDraft ?? null) as Record<string, unknown> | null;
    const tabsRaw = (raw.tabs ?? []) as Array<Record<string, unknown>>;
    return {
      status: "ok",
      value: {
        workspaceId: args.workspaceId,
        packId: args.packId,
        draftId: latestDraft ? latestDraft.id : null,
        version: latestDraft ? latestDraft.version : null,
        draftSha256: latestDraft ? latestDraft.draftSha256 : null,
        origin: latestDraft ? latestDraft.origin : null,
        refreshPending: raw.refreshPending === true,
        tabs: tabsRaw.map(tab => ({
          sourceTabId: tab.sourceTabId,
          tabOrder: tab.tabOrder,
          title: tab.title,
          chapterNumber: tab.chapterNumber ?? null,
          chapterTitle: tab.chapterTitle ?? null,
          structuralSha256: tab.structuralSha256,
          paragraphs: ((tab.paragraphs ?? []) as Array<Record<string, unknown>>).map(paragraph => ({
            paragraphKey: paragraph.paragraphKey,
            paragraphFingerprint: paragraph.paragraphFingerprint,
            paragraphOrder: paragraph.paragraphOrder,
            text: paragraph.text,
          })),
        })),
      },
    };
  } catch (error) {
    return mapEditorialServiceError(error);
  }
}

export async function handleCheckerGet(
  principal: { userId: number },
  args: { workspaceId: number; packId: number; runId?: number },
  deps: EditorialToolDeps
): Promise<EditorialToolStatus<Record<string, unknown>>> {
  if (!(await provePackLineage(principal, args, deps))) return { status: "not_found" };
  try {
    const raw = (await deps.getCheckerReadModel({
      actorUserId: principal.userId,
      workspaceId: args.workspaceId,
      workItemId: args.packId,
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
    })) as Record<string, unknown>;
    const run = (raw.run ?? null) as Record<string, unknown> | null;
    return {
      status: "ok",
      value: {
        workspaceId: args.workspaceId,
        packId: args.packId,
        state: raw.state,
        staleReason: raw.staleReason ?? null,
        isCurrent: raw.isCurrent === true,
        effectiveStatus: raw.effectiveStatus ?? null,
        unresolvedCount: Number(raw.unresolvedCount ?? 0),
        blockingIssueCount: Number(raw.blockingIssueCount ?? 0),
        run: run
          ? {
              runId: run.id,
              draftId: run.draftId,
              status: run.status,
              findingCount: run.findingCount,
              createdAt: (run.createdAt as Date).toISOString(),
            }
          : null,
        findings: ((raw.findings ?? []) as Array<Record<string, unknown>>).map(finding => ({
          findingId: finding.id,
          findingKey: finding.findingKey,
          ruleKey: finding.ruleKey,
          severity: finding.severity,
          paragraphKey: finding.paragraphKey ?? null,
          paragraphFingerprint: finding.paragraphFingerprint ?? null,
          startOffset: finding.startOffset ?? null,
          endOffset: finding.endOffset ?? null,
          sentenceText: finding.sentenceText ?? null,
          message: finding.message,
          disposition: finding.disposition,
        })),
      },
    };
  } catch (error) {
    return mapEditorialServiceError(error);
  }
}

export async function handleDraftEdit(
  principal: { userId: number },
  args: {
    workspaceId: number;
    packId: number;
    expectedDraftId: number;
    expectedDraftVersion: number;
    expectedDraftSha256: string;
    command: Record<string, unknown>;
    idempotencyKey: string;
  },
  deps: EditorialToolDeps
): Promise<EditorialToolStatus<Record<string, unknown>>> {
  if (!(await provePackLineage(principal, args, deps))) return { status: "not_found" };
  try {
    const raw = (await deps.applyEdit({
      actorUserId: principal.userId,
      workspaceId: args.workspaceId,
      workItemId: args.packId,
      expectedDraftId: args.expectedDraftId,
      expectedDraftVersion: args.expectedDraftVersion,
      expectedDraftSha256: args.expectedDraftSha256,
      command: args.command,
      idempotencyKey: args.idempotencyKey,
    })) as Record<string, unknown>;
    const draft = raw.draft as Record<string, unknown>;
    return {
      status: "ok",
      value: {
        workspaceId: args.workspaceId,
        packId: args.packId,
        draftId: draft.id,
        version: draft.version,
        draftSha256: draft.draftSha256,
        replayed: raw.replayed === true,
        isCurrent: raw.isCurrent === true,
      },
    };
  } catch (error) {
    return mapEditorialServiceError(error);
  }
}

export async function handleCheckerRun(
  principal: { userId: number },
  args: { workspaceId: number; packId: number; expectedDraftId?: number },
  deps: EditorialToolDeps
): Promise<EditorialToolStatus<Record<string, unknown>>> {
  if (!(await provePackLineage(principal, args, deps))) return { status: "not_found" };
  try {
    const raw = (await deps.runChecker({
      actorUserId: principal.userId,
      workspaceId: args.workspaceId,
      workItemId: args.packId,
      ...(args.expectedDraftId !== undefined ? { expectedDraftId: args.expectedDraftId } : {}),
    })) as Record<string, unknown>;
    const projection = (raw.kanbanProjection ?? {}) as Record<string, unknown>;
    return {
      status: "ok",
      value: {
        workspaceId: args.workspaceId,
        packId: args.packId,
        created: raw.created === true,
        // runEditorialForeignChecker returns { created, ...readModel,
        // kanbanProjection } - runId/draftId live inside the read model.
        runId: (raw.run as Record<string, unknown> | null | undefined)?.id as number,
        draftId:
          ((raw.run as Record<string, unknown> | null | undefined)?.draftId as number | undefined) ??
          ((raw.latestDraft as Record<string, unknown> | null | undefined)?.id as number | undefined) ??
          null,
        state: raw.state,
        staleReason: raw.staleReason ?? null,
        isCurrent: raw.isCurrent === true,
        effectiveStatus: raw.effectiveStatus ?? null,
        unresolvedCount: Number(raw.unresolvedCount ?? 0),
        blockingIssueCount: Number(raw.blockingIssueCount ?? 0),
        kanbanProjection: {
          changed: projection.changed === true,
          targetColumnKey: projection.targetColumnKey ?? null,
          reason: projection.reason ?? null,
        },
      },
    };
  } catch (error) {
    return mapEditorialServiceError(error);
  }
}
