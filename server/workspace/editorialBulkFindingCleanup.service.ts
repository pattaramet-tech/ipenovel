import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  workspaceAuditEvents,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  editorialBulkCleanupPreviewFingerprint,
  findingMatchesEditorialBulkCleanupAction,
  groupEditorialBulkCleanupFindings,
  type EditorialBulkCleanupAction,
  type EditorialBulkCleanupFinding,
} from "./editorialBulkFindingCleanup.domain";
import { applyEditorialBulkFindingCleanupRevision } from "./editorialEditor.service";
import {
  getEditorialForeignCheckerReadModel,
  runEditorialForeignChecker,
} from "./editorialForeignChecker.service";

export class WorkspaceEditorialBulkCleanupError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORKSPACE_NOT_FOUND"
      | "INVALID_SELECTION"
      | "PREVIEW_STALE"
      | "GROUP_NOT_FOUND"
      | "NO_MATCHES",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialBulkCleanupError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialBulkCleanupError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}

async function requireWorkspace(
  db: any,
  actorUserId: number,
  workspaceId: number
) {
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const [workspace] = await db
    .select({ id: workspaceWorkspaces.id, status: workspaceWorkspaces.status })
    .from(workspaceWorkspaces)
    .where(eq(workspaceWorkspaces.id, workspaceId))
    .limit(1);
  if (!workspace || workspace.status !== "active") {
    throw new WorkspaceEditorialBulkCleanupError(
      "WORKSPACE_NOT_FOUND",
      "Active Workspace was not found."
    );
  }
}

function normalizeWorkItemIds(workItemIds: readonly number[]) {
  const ids = Array.from(new Set(workItemIds))
    .filter(id => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
  if (!ids.length || ids.length > 100) {
    throw new WorkspaceEditorialBulkCleanupError(
      "INVALID_SELECTION",
      "Bulk cleanup supports 1-100 selected Episode Packs."
    );
  }
  return ids;
}

function projectFinding(finding: any): EditorialBulkCleanupFinding {
  return {
    findingKey: String(finding.findingKey),
    ruleKey: String(finding.ruleKey),
    token: String(finding.token ?? ""),
    normalizedToken: String(finding.normalizedToken ?? ""),
    sourceTabId: String(finding.sourceTabId),
    paragraphKey: String(finding.paragraphKey),
    paragraphOrder: Number(finding.paragraphOrder),
    paragraphFingerprint: String(finding.paragraphFingerprint),
    startOffset: Number(finding.startOffset),
    endOffset: Number(finding.endOffset),
    disposition: String(finding.disposition ?? "open"),
    resolutionVersion: Number(finding.resolutionVersion ?? 0),
  };
}

export async function previewEditorialBulkFindingCleanup(input: {
  actorUserId: number;
  workspaceId: number;
  workItemIds: number[];
}) {
  const db = await database();
  await requireWorkspace(db, input.actorUserId, input.workspaceId);
  const workItemIds = normalizeWorkItemIds(input.workItemIds);

  const workItems: Array<{
    workItemId: number;
    draftId: number | null;
    draftVersion: number | null;
    draftSha256: string | null;
    runId: number | null;
    engineVersion: string | null;
    isCurrent: boolean;
    openFindings: EditorialBulkCleanupFinding[];
    blocker: string | null;
  }> = [];

  for (const workItemId of workItemIds) {
    const readModel = await getEditorialForeignCheckerReadModel({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      workItemId,
    });
    const openFindings = (readModel.findings ?? [])
      .filter((finding: any) => finding.disposition === "open")
      .map(projectFinding);
    const blocker = !readModel.latestDraft
      ? "DRAFT_REQUIRED"
      : !readModel.run
        ? "CHECKER_REQUIRED"
        : !readModel.isCurrent
          ? "CHECKER_STALE"
          : null;
    workItems.push({
      workItemId,
      draftId: readModel.latestDraft?.id ?? null,
      draftVersion: readModel.latestDraft?.version ?? null,
      draftSha256: readModel.latestDraft?.draftSha256 ?? null,
      runId: readModel.run?.id ?? null,
      engineVersion: readModel.run?.engineVersion ?? null,
      isCurrent: Boolean(readModel.isCurrent),
      openFindings,
      blocker,
    });
  }

  const currentRows = workItems.flatMap(item =>
    item.blocker
      ? []
      : item.openFindings.map(finding => ({
          workItemId: item.workItemId,
          finding,
        }))
  );
  const groups = groupEditorialBulkCleanupFindings(currentRows);
  const sourceJunkFindings = currentRows.filter(
    row => row.finding.ruleKey === "source_junk"
  );
  const sourceJunkParagraphs = new Set(
    sourceJunkFindings.map(
      row => `${row.workItemId}:${row.finding.paragraphKey}`
    )
  );
  const sourceJunkWorkItems = Array.from(
    new Set(sourceJunkFindings.map(row => row.workItemId))
  ).sort((a, b) => a - b);

  const previewFingerprint = editorialBulkCleanupPreviewFingerprint({
    workspaceId: input.workspaceId,
    workItemIds,
    workItems,
  });

  return {
    version: "workspace-editorial-bulk-cleanup-preview-v1" as const,
    workspaceId: input.workspaceId,
    workItemIds,
    previewFingerprint,
    workItems: workItems.map(item => ({
      workItemId: item.workItemId,
      draftId: item.draftId,
      draftVersion: item.draftVersion,
      draftSha256: item.draftSha256,
      runId: item.runId,
      engineVersion: item.engineVersion,
      isCurrent: item.isCurrent,
      blocker: item.blocker,
      openFindingCount: item.openFindings.length,
      sourceJunkCount: item.openFindings.filter(
        finding => finding.ruleKey === "source_junk"
      ).length,
    })),
    groups,
    sourceJunk: {
      occurrenceCount: sourceJunkFindings.length,
      paragraphCount: sourceJunkParagraphs.size,
      workItemCount: sourceJunkWorkItems.length,
      workItemIds: sourceJunkWorkItems,
    },
    summary: {
      selectedWorkItems: workItemIds.length,
      readyWorkItems: workItems.filter(item => !item.blocker).length,
      blockedWorkItems: workItems.filter(item => item.blocker).length,
      openFindingCount: currentRows.length,
      groupedFindingCount: groups.length,
    },
  };
}

export async function applyEditorialBulkFindingCleanup(input: {
  actorUserId: number;
  workspaceId: number;
  workItemIds: number[];
  expectedPreviewFingerprint: string;
  action: EditorialBulkCleanupAction;
}) {
  const preview = await previewEditorialBulkFindingCleanup(input);
  if (preview.previewFingerprint !== input.expectedPreviewFingerprint) {
    throw new WorkspaceEditorialBulkCleanupError(
      "PREVIEW_STALE",
      "Draft or checker findings changed after preview. Preview again before cleanup."
    );
  }

  if (input.action.kind === "group") {
    const groupKey = input.action.groupKey;
    const group = preview.groups.find(
      candidate => candidate.groupKey === groupKey
    );
    if (!group) {
      throw new WorkspaceEditorialBulkCleanupError(
        "GROUP_NOT_FOUND",
        "Selected finding group is no longer present."
      );
    }
  } else if (preview.sourceJunk.occurrenceCount === 0) {
    throw new WorkspaceEditorialBulkCleanupError(
      "NO_MATCHES",
      "No open source-junk findings remain in the selected Episode Packs."
    );
  }

  const correlationId = "editorial-bulk-cleanup:" + randomUUID();
  const results: Array<{
    workItemId: number;
    ok: boolean;
    skipped: boolean;
    fromDraftId: number | null;
    toDraftId: number | null;
    removedFindingCount: number;
    removedParagraphCount: number;
    changedParagraphCount: number;
    checkerRunId: number | null;
    effectiveStatus: string | null;
    unresolvedCount: number | null;
    error: string | null;
  }> = [];

  for (const item of preview.workItems) {
    if (
      item.blocker ||
      !item.draftId ||
      !item.draftVersion ||
      !item.draftSha256 ||
      !item.runId
    ) {
      results.push({
        workItemId: item.workItemId,
        ok: false,
        skipped: true,
        fromDraftId: item.draftId,
        toDraftId: null,
        removedFindingCount: 0,
        removedParagraphCount: 0,
        changedParagraphCount: 0,
        checkerRunId: null,
        effectiveStatus: null,
        unresolvedCount: null,
        error: item.blocker ?? "CLEANUP_NOT_READY",
      });
      continue;
    }

    const readModel = await getEditorialForeignCheckerReadModel({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      workItemId: item.workItemId,
      runId: item.runId,
    });
    const matching = (readModel.findings ?? [])
      .filter((finding: any) => finding.disposition === "open")
      .map(projectFinding)
      .filter(finding =>
        findingMatchesEditorialBulkCleanupAction(finding, input.action)
      );

    if (!matching.length) {
      results.push({
        workItemId: item.workItemId,
        ok: true,
        skipped: true,
        fromDraftId: item.draftId,
        toDraftId: item.draftId,
        removedFindingCount: 0,
        removedParagraphCount: 0,
        changedParagraphCount: 0,
        checkerRunId: item.runId,
        effectiveStatus: readModel.effectiveStatus,
        unresolvedCount: readModel.unresolvedCount,
        error: null,
      });
      continue;
    }

    const findingKeys = matching
      .map(finding => finding.findingKey)
      .sort();
    const actionKey =
      input.action.kind === "source_junk"
        ? "source-junk"
        : input.action.groupKey;
    const idempotencyKey =
      "bulk-cleanup:" +
      sha256(
        [
          String(input.workspaceId),
          String(item.workItemId),
          preview.previewFingerprint,
          actionKey,
          findingKeys.join(","),
        ].join("\0")
      );

    try {
      const edited = await applyEditorialBulkFindingCleanupRevision({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        workItemId: item.workItemId,
        expectedDraftId: item.draftId,
        expectedDraftVersion: item.draftVersion,
        expectedDraftSha256: item.draftSha256,
        expectedRunId: item.runId,
        expectedFindingKeys: findingKeys,
        action: input.action,
        idempotencyKey,
      });
      if (!edited.draft?.id) {
        throw new Error("Bulk cleanup did not produce a current Draft.");
      }
      const checker = await runEditorialForeignChecker({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        workItemId: item.workItemId,
        expectedDraftId: edited.draft.id,
      });
      results.push({
        workItemId: item.workItemId,
        ok: true,
        skipped: false,
        fromDraftId: item.draftId,
        toDraftId: edited.draft.id,
        removedFindingCount: edited.removedFindingCount,
        removedParagraphCount: edited.removedParagraphCount,
        changedParagraphCount: edited.changedParagraphCount,
        checkerRunId: checker.run?.id ?? null,
        effectiveStatus: checker.effectiveStatus,
        unresolvedCount: checker.unresolvedCount,
        error: null,
      });
    } catch (error) {
      results.push({
        workItemId: item.workItemId,
        ok: false,
        skipped: false,
        fromDraftId: item.draftId,
        toDraftId: null,
        removedFindingCount: 0,
        removedParagraphCount: 0,
        changedParagraphCount: 0,
        checkerRunId: null,
        effectiveStatus: null,
        unresolvedCount: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const db = await database();
  await db.insert(workspaceAuditEvents).values({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    eventType: "workspace_editorial_bulk_cleanup_v1",
    entityType: "editorial_bulk_cleanup",
    entityId: correlationId,
    correlationId,
    metadataJson: JSON.stringify({
      version: "workspace-editorial-bulk-cleanup-audit-v1",
      previewFingerprint: preview.previewFingerprint,
      action:
        input.action.kind === "source_junk"
          ? { kind: "source_junk" }
          : { kind: "group", groupKey: input.action.groupKey },
      summary: {
        selected: results.length,
        changed: results.filter(result => result.ok && !result.skipped).length,
        skipped: results.filter(result => result.skipped).length,
        failed: results.filter(result => !result.ok).length,
        removedFindings: results.reduce(
          (sum, result) => sum + result.removedFindingCount,
          0
        ),
        removedParagraphs: results.reduce(
          (sum, result) => sum + result.removedParagraphCount,
          0
        ),
      },
      workItems: results.map(result => ({
        workItemId: result.workItemId,
        ok: result.ok,
        skipped: result.skipped,
        fromDraftId: result.fromDraftId,
        toDraftId: result.toDraftId,
        removedFindingCount: result.removedFindingCount,
        removedParagraphCount: result.removedParagraphCount,
        checkerRunId: result.checkerRunId,
        effectiveStatus: result.effectiveStatus,
        unresolvedCount: result.unresolvedCount,
        errorSha256: result.error ? sha256(result.error) : null,
      })),
    }),
  });

  return {
    version: "workspace-editorial-bulk-cleanup-result-v1" as const,
    correlationId,
    previewFingerprint: preview.previewFingerprint,
    results,
    summary: {
      selected: results.length,
      changed: results.filter(result => result.ok && !result.skipped).length,
      skipped: results.filter(result => result.skipped).length,
      failed: results.filter(result => !result.ok).length,
      removedFindings: results.reduce(
        (sum, result) => sum + result.removedFindingCount,
        0
      ),
      removedParagraphs: results.reduce(
        (sum, result) => sum + result.removedParagraphCount,
        0
      ),
      remainingOpenFindings: results.reduce(
        (sum, result) => sum + Number(result.unresolvedCount ?? 0),
        0
      ),
    },
  };
}
