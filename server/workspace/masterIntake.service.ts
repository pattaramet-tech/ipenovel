import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import {
  novels,
  workspaceAuditEvents,
  workspaceEditorialSources,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceMasterIntakeRows,
  workspaceNovels,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { GoogleRestReadOnlyTransport } from "../nqa/google/transport";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  createEditorialEpisodeWorkItem,
} from "./editorialBoard.service";
import { importEditorialSource } from "./editorialDraft.service";
import { fetchEditorialGoogleDocSource } from "./editorialSource.googleDocs";
import { refreshWorkspaceGoogleNqaReadAccessToken } from "./googleNqaRead";
import { NQA_AUTOLINK_LIVE_TARGET } from "./nqaAutolink.runtime";
import {
  assertMasterIntakeRowRange,
  googleDocumentIdFromUrlOrId,
  masterIntakePreviewFingerprint,
  masterIntakeRowFingerprint,
  normalizeMasterIntakeNovelTitle,
  normalizeOptionalHttpUrl,
  parseMasterIntakeTitleRange,
  type MasterIntakeRowCanonical,
} from "./masterIntake.domain";
import {
  bindPublicationNovel,
  createWorkspacePublicationNovel,
} from "./service";

export type MasterIntakePreviewStatus =
  | "NEW"
  | "MATCH"
  | "UNCHANGED"
  | "UPDATED"
  | "CONFLICT";

export class WorkspaceMasterIntakeError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORKSPACE_NOT_FOUND"
      | "INVALID_RANGE"
      | "SHEET_NOT_FOUND"
      | "STALE_PREVIEW"
      | "GOOGLE_READ_FAILED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceMasterIntakeError";
  }
}

type PreviewRow = {
  rowNumber: number;
  status: MasterIntakePreviewStatus;
  rowFingerprint: string;
  rawTitle: string;
  novelTitle: string | null;
  episodeNumber: string | null;
  translationDocUrl: string | null;
  webSourceUrl: string | null;
  preparedSourceDocUrl: string | null;
  existingNovelId: number | null;
  workspaceNovelId: number | null;
  workItemId: number | null;
  blockers: string[];
  sourceAlreadyLinked: boolean;
};

type PreviewResult = {
  version: "workspace-master-intake-preview-v1";
  target: typeof NQA_AUTOLINK_LIVE_TARGET & { sheetId: number };
  workspaceId: number;
  googleConnectionId: number;
  startRow: number;
  endRow: number;
  previewFingerprint: string;
  rows: PreviewRow[];
  summary: Record<MasterIntakePreviewStatus, number>;
};

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceMasterIntakeError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}

function rawFingerprint(input: {
  rowNumber: number;
  rawTitle: string;
  translationDocUrl: string;
  webSourceUrl: string;
  preparedSourceDocUrl: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: "workspace-master-intake-invalid-v1", ...input }))
    .digest("hex");
}

function parseEpisodeSpan(value: string) {
  const normalized = value.normalize("NFKC").trim().replace(/[–—]/g, "-");
  const match = normalized.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
    return null;
  }
  return { start, end };
}

function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
) {
  return a.start <= b.end && b.start <= a.end;
}

function sameEpisodeIdentity(left: string, right: string) {
  const a = parseEpisodeSpan(left);
  const b = parseEpisodeSpan(right);
  return Boolean(a && b && a.start === b.start && a.end === b.end);
}

function quoteSheetName(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

async function readSheetRows(input: {
  actorUserId: number;
  googleConnectionId: number;
  startRow: number;
  endRow: number;
}) {
  const transport = new GoogleRestReadOnlyTransport({
    accessTokenProvider: () =>
      refreshWorkspaceGoogleNqaReadAccessToken({
        actorUserId: input.actorUserId,
        connectionId: input.googleConnectionId,
      }),
  });
  let metadata;
  try {
    metadata = await transport.getSpreadsheetMetadata(
      NQA_AUTOLINK_LIVE_TARGET.spreadsheetId
    );
  } catch {
    throw new WorkspaceMasterIntakeError(
      "GOOGLE_READ_FAILED",
      "Google Sheets metadata could not be read."
    );
  }
  const sheet = metadata.sheets.find(
    candidate => candidate.title === NQA_AUTOLINK_LIVE_TARGET.sheetName
  );
  if (!sheet) {
    throw new WorkspaceMasterIntakeError(
      "SHEET_NOT_FOUND",
      "Configured Master Intake Sheet tab was not found."
    );
  }
  const range =
    quoteSheetName(NQA_AUTOLINK_LIVE_TARGET.sheetName) +
    "!B" +
    input.startRow +
    ":K" +
    input.endRow;
  let batch;
  try {
    [batch] = await transport.batchGetValues({
      spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
      ranges: [range],
    });
  } catch {
    throw new WorkspaceMasterIntakeError(
      "GOOGLE_READ_FAILED",
      "Google Sheets row data could not be read."
    );
  }
  return {
    sheetId: sheet.sheetId,
    values: batch?.values ?? [],
  };
}

async function requireWorkspace(db: any, actorUserId: number, workspaceId: number) {
  await requireWorkspacePlatformAdmin(db, actorUserId);
  const [workspace] = await db
    .select({ id: workspaceWorkspaces.id, status: workspaceWorkspaces.status })
    .from(workspaceWorkspaces)
    .where(eq(workspaceWorkspaces.id, workspaceId))
    .limit(1);
  if (!workspace || workspace.status !== "active") {
    throw new WorkspaceMasterIntakeError(
      "WORKSPACE_NOT_FOUND",
      "Active Workspace was not found."
    );
  }
}

function summarize(rows: PreviewRow[]): Record<MasterIntakePreviewStatus, number> {
  const result: Record<MasterIntakePreviewStatus, number> = {
    NEW: 0,
    MATCH: 0,
    UNCHANGED: 0,
    UPDATED: 0,
    CONFLICT: 0,
  };
  for (const row of rows) result[row.status] += 1;
  return result;
}

export async function previewWorkspaceMasterIntake(input: {
  actorUserId: number;
  workspaceId: number;
  googleConnectionId: number;
  startRow: number;
  endRow: number;
}): Promise<PreviewResult> {
  try {
    assertMasterIntakeRowRange(input.startRow, input.endRow);
  } catch (error) {
    throw new WorkspaceMasterIntakeError(
      "INVALID_RANGE",
      error instanceof Error ? error.message : "Invalid row range."
    );
  }

  const db = await database();
  await requireWorkspace(db, input.actorUserId, input.workspaceId);
  const sheetRead = await readSheetRows(input);

  const [publicationNovels, workspaceNovelRows, provenanceRows] = await Promise.all([
    db.select({ id: novels.id, title: novels.title }).from(novels),
    db
      .select()
      .from(workspaceNovels)
      .where(eq(workspaceNovels.workspaceId, input.workspaceId)),
    db
      .select()
      .from(workspaceMasterIntakeRows)
      .where(eq(workspaceMasterIntakeRows.workspaceId, input.workspaceId)),
  ]);

  const titles = new Map<string, Array<{ id: number; title: string }>>();
  for (const novel of publicationNovels) {
    const key = normalizeMasterIntakeNovelTitle(String(novel.title ?? ""));
    const bucket = titles.get(key) ?? [];
    bucket.push({ id: Number(novel.id), title: String(novel.title ?? "") });
    titles.set(key, bucket);
  }
  const workspaceByNovelId = new Map(
    workspaceNovelRows.map((row: any) => [Number(row.novelId), row])
  );
  const provenanceByRow = new Map(
    provenanceRows
      .filter(
        (row: any) =>
          row.spreadsheetId === NQA_AUTOLINK_LIVE_TARGET.spreadsheetId &&
          Number(row.sheetId) === Number(sheetRead.sheetId)
      )
      .map((row: any) => [Number(row.rowNumber), row])
  );

  const rows: PreviewRow[] = [];
  for (let rowNumber = input.startRow; rowNumber <= input.endRow; rowNumber += 1) {
    const cells = sheetRead.values[rowNumber - input.startRow] ?? [];
    const rawTitle = String(cells[0] ?? "").trim();
    const translationDocUrl = String(cells[1] ?? "").trim();
    const webSourceRaw = String(cells[3] ?? "").trim();
    const preparedSourceDocUrl = String(cells[9] ?? "").trim();
    const parsed = parseMasterIntakeTitleRange(rawTitle);
    const translationDocumentId = googleDocumentIdFromUrlOrId(translationDocUrl);
    const preparedSourceDocumentId = googleDocumentIdFromUrlOrId(
      preparedSourceDocUrl
    );
    const webSourceUrl = normalizeOptionalHttpUrl(webSourceRaw);
    const blockers: string[] = [];
    if (!parsed) blockers.push("TITLE_RANGE_INVALID");
    if (!translationDocumentId) blockers.push("TRANSLATION_DOC_INVALID");
    if (!preparedSourceDocumentId) blockers.push("PREPARED_SOURCE_DOC_INVALID");
    if (webSourceUrl === undefined) blockers.push("WEB_SOURCE_URL_INVALID");

    if (!parsed || !translationDocumentId || !preparedSourceDocumentId || webSourceUrl === undefined) {
      rows.push({
        rowNumber,
        status: "CONFLICT",
        rowFingerprint: rawFingerprint({
          rowNumber,
          rawTitle,
          translationDocUrl,
          webSourceUrl: webSourceRaw,
          preparedSourceDocUrl,
        }),
        rawTitle,
        novelTitle: parsed?.novelTitle ?? null,
        episodeNumber: parsed?.episodeNumber ?? null,
        translationDocUrl: translationDocUrl || null,
        webSourceUrl: webSourceRaw || null,
        preparedSourceDocUrl: preparedSourceDocUrl || null,
        existingNovelId: null,
        workspaceNovelId: null,
        workItemId: null,
        blockers,
        sourceAlreadyLinked: false,
      });
      continue;
    }

    const canonical: MasterIntakeRowCanonical = {
      spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
      sheetId: sheetRead.sheetId,
      sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
      rowNumber,
      novelTitle: parsed.novelTitle,
      normalizedTitle: parsed.normalizedTitle,
      episodeNumber: parsed.episodeNumber,
      translationDocUrl,
      translationDocumentId,
      webSourceUrl,
      preparedSourceDocUrl,
      preparedSourceDocumentId,
    };
    const rowFingerprint = masterIntakeRowFingerprint(canonical);
    const provenance = provenanceByRow.get(rowNumber) as any;

    if (provenance) {
      if (
        provenance.normalizedTitle !== parsed.normalizedTitle ||
        !sameEpisodeIdentity(provenance.episodeNumber, parsed.episodeNumber)
      ) {
        blockers.push("SYNC_IDENTITY_CHANGED");
      }
      if (provenance.translationDocumentId !== translationDocumentId) {
        blockers.push("TRANSLATION_SOURCE_CHANGED");
      }
      const [workItem] = await db
        .select({ id: workspaceEditorialWorkItems.id })
        .from(workspaceEditorialWorkItems)
        .where(eq(workspaceEditorialWorkItems.id, provenance.workItemId))
        .limit(1);
      if (!workItem) blockers.push("SYNC_TARGET_MISSING");
      rows.push({
        rowNumber,
        status: blockers.length
          ? "CONFLICT"
          : provenance.rowFingerprint === rowFingerprint
            ? "UNCHANGED"
            : "UPDATED",
        rowFingerprint,
        rawTitle,
        novelTitle: parsed.novelTitle,
        episodeNumber: parsed.episodeNumber,
        translationDocUrl,
        webSourceUrl,
        preparedSourceDocUrl,
        existingNovelId: Number(provenance.workspaceNovelId)
          ? Number(
              workspaceNovelRows.find(
                (item: any) => Number(item.id) === Number(provenance.workspaceNovelId)
              )?.novelId ?? 0
            ) || null
          : null,
        workspaceNovelId: Number(provenance.workspaceNovelId),
        workItemId: Number(provenance.workItemId),
        blockers,
        sourceAlreadyLinked: false,
      });
      continue;
    }

    const candidates = titles.get(parsed.normalizedTitle) ?? [];
    if (candidates.length > 1) blockers.push("AMBIGUOUS_NOVEL_TITLE");
    const candidate = candidates.length === 1 ? candidates[0] : null;
    let workspaceNovelId: number | null = null;
    let workItemId: number | null = null;
    let sourceAlreadyLinked = false;

    if (candidate) {
      const workspaceNovel = workspaceByNovelId.get(candidate.id) as any;
      workspaceNovelId = workspaceNovel ? Number(workspaceNovel.id) : null;
      if (workspaceNovel) {
        const activeItems = await db
          .select({
            item: workspaceEditorialWorkItems,
            cardStatus: workspaceKanbanCards.status,
            columnKey: workspaceKanbanColumns.key,
          })
          .from(workspaceEditorialWorkItems)
          .innerJoin(
            workspaceKanbanCards,
            eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
          )
          .innerJoin(
            workspaceKanbanColumns,
            eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id)
          )
          .where(
            and(
              eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovel.id),
              eq(workspaceEditorialWorkItems.workItemType, "new_episode")
            )
          );
        for (const entry of activeItems) {
          if (entry.cardStatus !== "active") continue;
          const span = parseEpisodeSpan(entry.item.episodeNumber ?? "");
          if (!span || !spansOverlap(span, { start: parsed.rangeStart, end: parsed.rangeEnd })) continue;
          if (
            span.start === parsed.rangeStart &&
            span.end === parsed.rangeEnd
          ) {
            workItemId = Number(entry.item.id);
            const activeSources = await db
              .select({
                providerDocumentId: workspaceEditorialSources.providerDocumentId,
              })
              .from(workspaceEditorialSources)
              .where(
                and(
                  eq(workspaceEditorialSources.workItemId, entry.item.id),
                  eq(workspaceEditorialSources.status, "active")
                )
              );
            const matchingSource = activeSources.some(
              (source: any) =>
                source.providerDocumentId === translationDocumentId
            );
            const conflictingSource = activeSources.some(
              (source: any) =>
                source.providerDocumentId &&
                source.providerDocumentId !== translationDocumentId
            );
            if (conflictingSource) {
              blockers.push("EXISTING_TRANSLATION_SOURCE_CONFLICT");
            }
            if (!matchingSource && activeSources.length === 0 && entry.columnKey !== "new") {
              blockers.push("EXISTING_PACK_NOT_EDITABLE");
            }
            if (matchingSource) {
              sourceAlreadyLinked = true;
            }
          } else {
            blockers.push("EPISODE_RANGE_OVERLAP");
          }
        }
      }
    }

    rows.push({
      rowNumber,
      status: blockers.length ? "CONFLICT" : candidate ? "MATCH" : "NEW",
      rowFingerprint,
      rawTitle,
      novelTitle: parsed.novelTitle,
      episodeNumber: parsed.episodeNumber,
      translationDocUrl,
      webSourceUrl,
      preparedSourceDocUrl,
      existingNovelId: candidate?.id ?? null,
      workspaceNovelId,
      workItemId,
      blockers,
      sourceAlreadyLinked,
    });
  }

  const previewFingerprint = masterIntakePreviewFingerprint({
    workspaceId: input.workspaceId,
    startRow: input.startRow,
    endRow: input.endRow,
    rows,
  });

  return {
    version: "workspace-master-intake-preview-v1",
    target: {
      ...NQA_AUTOLINK_LIVE_TARGET,
      sheetId: sheetRead.sheetId,
    },
    workspaceId: input.workspaceId,
    googleConnectionId: input.googleConnectionId,
    startRow: input.startRow,
    endRow: input.endRow,
    previewFingerprint,
    rows,
    summary: summarize(rows),
  };
}

async function resolveWorkspaceNovelForSync(input: {
  actorUserId: number;
  workspaceId: number;
  previewRow: PreviewRow;
}) {
  const row = input.previewRow;
  if (!row.novelTitle) throw new Error("Parsed novel title is unavailable.");
  if (row.existingNovelId) {
    const bound = await bindPublicationNovel({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      novelId: row.existingNovelId,
    });
    return {
      novelId: row.existingNovelId,
      workspaceNovelId: Number(bound.workspaceNovelId),
      novelCreated: false,
    };
  }
  const created = await createWorkspacePublicationNovel({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    title: row.novelTitle,
  });
  return {
    novelId: Number(created.novelId),
    workspaceNovelId: Number(created.workspaceNovelId),
    novelCreated: true,
  };
}

async function resolveWorkItemForSync(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  previewRow: PreviewRow;
}) {
  if (input.previewRow.workItemId) {
    return { workItemId: input.previewRow.workItemId, created: false };
  }
  const created = await createEditorialEpisodeWorkItem({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    episodeNumber: input.previewRow.episodeNumber!,
    allowPendingSaleMetadata: true,
  });
  const card = (created.board?.columns ?? [])
    .flatMap((column: any) => column.cards ?? [])
    .find(
      (candidate: any) =>
        candidate.workItemType === "NEW_EPISODE" &&
        Number(candidate.workspaceNovelId) === input.workspaceNovelId &&
        sameEpisodeIdentity(
          String(candidate.episodeNumber ?? ""),
          input.previewRow.episodeNumber!
        )
    );
  if (!card?.workItemId) {
    throw new Error("Created Episode Pack could not be resolved.");
  }
  return { workItemId: Number(card.workItemId), created: created.created };
}

async function persistProvenance(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  workItemId: number;
  preview: PreviewResult;
  row: PreviewRow;
}) {
  const db = await database();
  const parsed = parseMasterIntakeTitleRange(input.row.rawTitle);
  if (
    !parsed ||
    !input.row.translationDocUrl ||
    !input.row.preparedSourceDocUrl
  ) {
    throw new Error("Master Intake row is no longer canonical.");
  }
  const translationDocumentId = googleDocumentIdFromUrlOrId(
    input.row.translationDocUrl
  );
  const preparedSourceDocumentId = googleDocumentIdFromUrlOrId(
    input.row.preparedSourceDocUrl
  );
  if (!translationDocumentId || !preparedSourceDocumentId) {
    throw new Error("Master Intake Google document identity is invalid.");
  }

  const values = {
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    workItemId: input.workItemId,
    spreadsheetId: input.preview.target.spreadsheetId,
    sheetId: input.preview.target.sheetId,
    sheetName: input.preview.target.sheetName,
    rowNumber: input.row.rowNumber,
    rawTitle: input.row.rawTitle,
    normalizedTitle: parsed.normalizedTitle,
    episodeNumber: parsed.episodeNumber,
    translationDocUrl: input.row.translationDocUrl,
    translationDocumentId,
    webSourceUrl: input.row.webSourceUrl,
    preparedSourceDocUrl: input.row.preparedSourceDocUrl,
    preparedSourceDocumentId,
    rowFingerprint: input.row.rowFingerprint,
    lastSyncedByUserId: input.actorUserId,
  };
  const [existing] = await db
    .select({ id: workspaceMasterIntakeRows.id })
    .from(workspaceMasterIntakeRows)
    .where(
      and(
        eq(workspaceMasterIntakeRows.workspaceId, input.workspaceId),
        eq(
          workspaceMasterIntakeRows.spreadsheetId,
          input.preview.target.spreadsheetId
        ),
        eq(workspaceMasterIntakeRows.sheetId, input.preview.target.sheetId),
        eq(workspaceMasterIntakeRows.rowNumber, input.row.rowNumber)
      )
    )
    .limit(1);
  if (existing) {
    await db
      .update(workspaceMasterIntakeRows)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(workspaceMasterIntakeRows.id, existing.id));
  } else {
    await db.insert(workspaceMasterIntakeRows).values(values);
  }
}

export async function syncWorkspaceMasterIntake(input: {
  actorUserId: number;
  workspaceId: number;
  googleConnectionId: number;
  startRow: number;
  endRow: number;
  expectedPreviewFingerprint: string;
}) {
  const preview = await previewWorkspaceMasterIntake(input);
  if (preview.previewFingerprint !== input.expectedPreviewFingerprint) {
    throw new WorkspaceMasterIntakeError(
      "STALE_PREVIEW",
      "Google Sheet or Workspace state changed after preview. Preview again before syncing."
    );
  }

  const correlationId = "master-intake:" + randomUUID();
  const results: Array<{
    rowNumber: number;
    status: MasterIntakePreviewStatus;
    ok: boolean;
    novelId: number | null;
    workspaceNovelId: number | null;
    workItemId: number | null;
    novelCreated: boolean;
    workItemCreated: boolean;
    sourceResult: string | null;
    error: string | null;
  }> = [];

  for (const row of preview.rows) {
    if (row.status === "CONFLICT" || row.status === "UNCHANGED") {
      results.push({
        rowNumber: row.rowNumber,
        status: row.status,
        ok: row.status === "UNCHANGED",
        novelId: row.existingNovelId,
        workspaceNovelId: row.workspaceNovelId,
        workItemId: row.workItemId,
        novelCreated: false,
        workItemCreated: false,
        sourceResult: null,
        error:
          row.status === "CONFLICT"
            ? row.blockers.join(", ")
            : null,
      });
      continue;
    }

    try {
      // Validate/read C before creating any database objects unless this exact
      // Google source is already durably linked to the existing work item.
      const sourcePayload = row.sourceAlreadyLinked
        ? null
        : await fetchEditorialGoogleDocSource({
            actorUserId: input.actorUserId,
            connectionId: input.googleConnectionId,
            documentUrlOrId: row.translationDocUrl!,
          });
      const target = await resolveWorkspaceNovelForSync({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        previewRow: row,
      });
      const work = await resolveWorkItemForSync({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        workspaceNovelId: target.workspaceNovelId,
        previewRow: row,
      });
      const imported = sourcePayload
        ? await importEditorialSource({
            actorUserId: input.actorUserId,
            workspaceId: input.workspaceId,
            workItemId: work.workItemId,
            payload: sourcePayload,
            googleConnectionId: input.googleConnectionId,
          })
        : null;
      await persistProvenance({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        workspaceNovelId: target.workspaceNovelId,
        workItemId: work.workItemId,
        preview,
        row,
      });
      results.push({
        rowNumber: row.rowNumber,
        status: row.status,
        ok: true,
        novelId: target.novelId,
        workspaceNovelId: target.workspaceNovelId,
        workItemId: work.workItemId,
        novelCreated: target.novelCreated,
        workItemCreated: work.created,
        sourceResult: imported
          ? String(imported.reason ?? "SOURCE_IMPORTED")
          : "SOURCE_ALREADY_LINKED",
        error: null,
      });
    } catch (error) {
      results.push({
        rowNumber: row.rowNumber,
        status: row.status,
        ok: false,
        novelId: row.existingNovelId,
        workspaceNovelId: row.workspaceNovelId,
        workItemId: row.workItemId,
        novelCreated: false,
        workItemCreated: false,
        sourceResult: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const db = await database();
  await db.insert(workspaceAuditEvents).values({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    eventType: "workspace_master_intake_sync_v1",
    entityType: "master_intake_sync",
    entityId: correlationId,
    correlationId,
    metadataJson: JSON.stringify({
      version: "workspace-master-intake-audit-v1",
      spreadsheetId: preview.target.spreadsheetId,
      sheetId: preview.target.sheetId,
      sheetName: preview.target.sheetName,
      startRow: preview.startRow,
      endRow: preview.endRow,
      previewFingerprint: preview.previewFingerprint,
      summary: {
        attempted: results.length,
        succeeded: results.filter(item => item.ok).length,
        failed: results.filter(item => !item.ok).length,
      },
      rows: results.map(item => ({
        rowNumber: item.rowNumber,
        status: item.status,
        ok: item.ok,
        novelId: item.novelId,
        workspaceNovelId: item.workspaceNovelId,
        workItemId: item.workItemId,
        novelCreated: item.novelCreated,
        workItemCreated: item.workItemCreated,
        sourceResult: item.sourceResult,
        error: item.error?.slice(0, 500) ?? null,
      })),
    }),
  });

  return {
    version: "workspace-master-intake-sync-v1" as const,
    correlationId,
    previewFingerprint: preview.previewFingerprint,
    results,
    summary: {
      attempted: results.length,
      succeeded: results.filter(item => item.ok).length,
      failed: results.filter(item => !item.ok).length,
    },
  };
}

export async function listWorkspaceMasterIntakeHistory(input: {
  actorUserId: number;
  workspaceId: number;
  limit?: number;
}) {
  const db = await database();
  await requireWorkspace(db, input.actorUserId, input.workspaceId);
  const rows = await db
    .select()
    .from(workspaceAuditEvents)
    .where(
      and(
        eq(workspaceAuditEvents.workspaceId, input.workspaceId),
        eq(workspaceAuditEvents.eventType, "workspace_master_intake_sync_v1")
      )
    )
    .orderBy(desc(workspaceAuditEvents.createdAt), desc(workspaceAuditEvents.id))
    .limit(Math.max(1, Math.min(50, input.limit ?? 20)));

  return rows.map((row: any) => {
    let metadata: any = null;
    try {
      metadata = JSON.parse(row.metadataJson);
    } catch {
      metadata = null;
    }
    return {
      id: row.id,
      correlationId: row.correlationId,
      createdAt: row.createdAt,
      actorUserId: row.actorUserId,
      metadata,
    };
  });
}
