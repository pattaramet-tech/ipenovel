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
import { defaultEditorialEpisodePackSaleFromRange } from "./editorialApproval.domain";
import {
  createEditorialEpisodeWorkItem,
} from "./editorialBoard.service";
import { importEditorialSource } from "./editorialDraft.service";
import { fetchEditorialGoogleDocSource } from "./editorialSource.googleDocs";
import { refreshWorkspaceGoogleNqaReadAccessToken } from "./googleNqaRead";
import { NQA_AUTOLINK_LIVE_TARGET } from "./nqaAutolink.runtime";
import {
  assertMasterIntakeRowRange,
  canonicalMasterIntakeIdentityFingerprint,
  canonicalizeActiveSourceKeys,
  googleDocumentIdFromUrlOrId,
  masterIntakePreviewFingerprint,
  masterIntakeProvenancePreviewStatus,
  masterIntakeRowFingerprint,
  masterIntakeRowIdentityFingerprint,
  normalizeMasterIntakeNovelTitle,
  normalizeOptionalHttpUrl,
  parseMasterIntakeEpisodeSpan,
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
  provenanceId: number | null;
  provenanceRowNumber: number | null;
  blockers: string[];
  sourceAlreadyLinked: boolean;
  /** Sync may replace the pack's active translation source (same canonical identity). */
  sourceReplacementExpected: boolean;
  /**
   * Canonical `<sourceKind>:<sourceKey>` set observed active on the target
   * Work Item during this preview. This is the authorization binding for a
   * later source replacement: the sync refuses to mutate when the current
   * active-source state differs from what the operator reviewed.
   */
  observedActiveSourceKeys: string[];
  /** IPE-061: provenance classification for this row. */
  provenanceDisposition: "SAME_IDENTITY" | "REBOUND" | "ROW_REUSED" | "NONE";
  /** Stale at-row locator (different identity) reconciled when this row syncs. */
  reconcileStaleProvenanceId: number | null;
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

function affectedRows(result: any) {
  return Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0);
}

function provenanceIdentityFingerprint(row: any): string | null {
  // Canonical business identity (normalized title + canonical episode span)
  // recomputed from the persisted provenance fields at runtime — legacy
  // provenance records created under the old source-bound fingerprint
  // resolve through the same canonicalization without any data migration.
  // Malformed legacy records (unparseable title/episode) return null: a
  // per-row non-match that must never crash the whole batch.
  return canonicalMasterIntakeIdentityFingerprint({
    normalizedTitle: String(row.normalizedTitle ?? ""),
    episodeNumber: String(row.episodeNumber ?? ""),
  });
}

function spansOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
) {
  return a.start <= b.end && b.start <= a.end;
}

function sameEpisodeIdentity(left: string, right: string) {
  const a = parseMasterIntakeEpisodeSpan(left);
  const b = parseMasterIntakeEpisodeSpan(right);
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
    ":O" +
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

async function readSpecificSheetRows(input: {
  actorUserId: number;
  googleConnectionId: number;
  rowNumbers: number[];
}) {
  const uniqueRows = Array.from(new Set(input.rowNumbers)).sort((a, b) => a - b);
  const valuesByRow = new Map<number, unknown[]>();
  if (uniqueRows.length === 0) return valuesByRow;
  const transport = new GoogleRestReadOnlyTransport({
    accessTokenProvider: () =>
      refreshWorkspaceGoogleNqaReadAccessToken({
        actorUserId: input.actorUserId,
        connectionId: input.googleConnectionId,
      }),
  });
  const ranges = uniqueRows.map(
    rowNumber =>
      quoteSheetName(NQA_AUTOLINK_LIVE_TARGET.sheetName) +
      "!B" +
      rowNumber +
      ":O" +
      rowNumber
  );
  let batches;
  try {
    batches = await transport.batchGetValues({
      spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
      ranges,
    });
  } catch {
    throw new WorkspaceMasterIntakeError(
      "GOOGLE_READ_FAILED",
      "Google Sheets provenance rows could not be verified."
    );
  }
  uniqueRows.forEach((rowNumber, index) => {
    valuesByRow.set(rowNumber, batches[index]?.values?.[0] ?? []);
  });
  return valuesByRow;
}

function sheetRowIdentityFingerprint(input: {
  rowNumber: number;
  cells: unknown[];
  sheetId: number;
}) {
  const rawTitle = String(input.cells[0] ?? "").trim();
  const translationDocUrl = String(input.cells[1] ?? "").trim();
  const webSourceRaw = String(input.cells[3] ?? "").trim();
  const preparedSourceRaw = String(input.cells[13] ?? "").trim();
  const parsed = parseMasterIntakeTitleRange(rawTitle);
  const translationDocumentId = googleDocumentIdFromUrlOrId(translationDocUrl);
  const preparedSourceDocumentId = preparedSourceRaw
    ? googleDocumentIdFromUrlOrId(preparedSourceRaw)
    : null;
  const webSourceUrl = normalizeOptionalHttpUrl(webSourceRaw);
  if (!parsed || !translationDocumentId || webSourceUrl === undefined) return null;
  return masterIntakeRowIdentityFingerprint({
    spreadsheetId: NQA_AUTOLINK_LIVE_TARGET.spreadsheetId,
    sheetId: input.sheetId,
    sheetName: NQA_AUTOLINK_LIVE_TARGET.sheetName,
    rowNumber: input.rowNumber,
    novelTitle: parsed.novelTitle,
    normalizedTitle: parsed.normalizedTitle,
    episodeNumber: parsed.episodeNumber,
    translationDocUrl,
    translationDocumentId,
    webSourceUrl,
    preparedSourceDocUrl: preparedSourceDocumentId ? preparedSourceRaw : null,
    preparedSourceDocumentId,
  });
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

  const currentSheetIdentityByRow = new Map<number, string | null>();
  const selectedIdentityFingerprints = new Set<string>();
  for (let rowNumber = input.startRow; rowNumber <= input.endRow; rowNumber += 1) {
    const identity = sheetRowIdentityFingerprint({
      rowNumber,
      cells: sheetRead.values[rowNumber - input.startRow] ?? [],
      sheetId: sheetRead.sheetId,
    });
    currentSheetIdentityByRow.set(rowNumber, identity);
    if (identity) selectedIdentityFingerprints.add(identity);
  }
  const provenanceRowsToVerify = provenanceRows
    .filter((row: any) => {
      if (
        row.spreadsheetId !== NQA_AUTOLINK_LIVE_TARGET.spreadsheetId ||
        Number(row.sheetId) !== Number(sheetRead.sheetId)
      ) {
        return false;
      }
      // Malformed legacy records canonicalize to null -> never selected for
      // verification and never treated as an identity match.
      const identity = provenanceIdentityFingerprint(row);
      if (identity === null) return false;
      return (
        selectedIdentityFingerprints.has(identity) &&
        (Number(row.rowNumber) < input.startRow || Number(row.rowNumber) > input.endRow)
      );
    })
    .map((row: any) => Number(row.rowNumber));
  const externalIdentityRows = await readSpecificSheetRows({
    actorUserId: input.actorUserId,
    googleConnectionId: input.googleConnectionId,
    rowNumbers: provenanceRowsToVerify,
  });
  externalIdentityRows.forEach((cells, rowNumber) => {
    currentSheetIdentityByRow.set(
      rowNumber,
      sheetRowIdentityFingerprint({ rowNumber, cells, sheetId: sheetRead.sheetId })
    );
  });

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
    const preparedSourceRaw = String(cells[13] ?? "").trim();
    const parsed = parseMasterIntakeTitleRange(rawTitle);
    const translationDocumentId = googleDocumentIdFromUrlOrId(translationDocUrl);
    const preparedSourceDocumentId = preparedSourceRaw
      ? googleDocumentIdFromUrlOrId(preparedSourceRaw)
      : null;
    const preparedSourceDocUrl = preparedSourceDocumentId ? preparedSourceRaw : "";
    const webSourceUrl = normalizeOptionalHttpUrl(webSourceRaw);
    const blockers: string[] = [];
    if (!parsed) blockers.push("TITLE_RANGE_INVALID");
    if (!translationDocumentId) blockers.push("TRANSLATION_DOC_INVALID");
    if (webSourceUrl === undefined) blockers.push("WEB_SOURCE_URL_INVALID");

    if (!parsed || !translationDocumentId || webSourceUrl === undefined) {
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
        provenanceId: null,
        provenanceRowNumber: null,
        blockers,
        sourceAlreadyLinked: false,
        sourceReplacementExpected: false,
        observedActiveSourceKeys: [],
        provenanceDisposition: "NONE",
        reconcileStaleProvenanceId: null,
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
      preparedSourceDocUrl: preparedSourceDocUrl || null,
      preparedSourceDocumentId,
    };
    const rowFingerprint = masterIntakeRowFingerprint(canonical);
    // Canonical business identity: normalized title + canonical episode span.
    // Source documents/URLs and sheet/row metadata are deliberately excluded —
    // changing them must be a source update/rebind, never an identity change.
    const identityFingerprint = masterIntakeRowIdentityFingerprint(canonical);
    const provenanceAtRow = provenanceByRow.get(rowNumber) as any;
    const identityMatches = provenanceRows.filter(
      (candidate: any) =>
        candidate.spreadsheetId === NQA_AUTOLINK_LIVE_TARGET.spreadsheetId &&
        Number(candidate.sheetId) === Number(sheetRead.sheetId) &&
        provenanceIdentityFingerprint(candidate) === identityFingerprint
    );
    if (identityMatches.length > 1) blockers.push("AMBIGUOUS_PROVENANCE_REBIND");
    const uniqueIdentityMatch = identityMatches.length === 1 ? identityMatches[0] : null;
    if (uniqueIdentityMatch && Number(uniqueIdentityMatch.rowNumber) !== rowNumber) {
      const oldRowIdentity = currentSheetIdentityByRow.get(Number(uniqueIdentityMatch.rowNumber));
      if (oldRowIdentity === undefined) {
        blockers.push("PROVENANCE_REBIND_SOURCE_ROW_NOT_VERIFIED");
      } else if (oldRowIdentity === identityFingerprint) {
        blockers.push("PROVENANCE_REBIND_SOURCE_ROW_STILL_PRESENT");
      }
    }
    // Resolution precedence: a provenance record matching the canonical
    // identity (even after a row move / source change) wins. An at-row
    // provenance that does NOT canonical-match means the row's title/episode
    // changed (or the legacy record is malformed) — fail closed from the
    // provenance context itself, never via NEW-path derivation.
    let provenance: any = null;
    let atRowIdentityChanged = false;
    // IPE-061: true row-reuse reconciliation (CASE C) — set when the at-row
    // provenance record belongs to a DIFFERENT, verifiably-gone identity.
    let reusedProvenanceDisposition: "ROW_REUSED" | "REBOUND" | null = null;
    let reusedStaleProvenanceId: number | null = null;
    if (uniqueIdentityMatch) {
      provenance = uniqueIdentityMatch;
    } else if (provenanceAtRow) {
      // IPE-061: the at-row provenance record does NOT canonical-match this
      // row. Classify before failing: a rowNumber is only a sheet locator,
      // so the record may be a stale locator left by a REUSED row.
      const staleIdentity = provenanceIdentityFingerprint(provenanceAtRow);
      const staleSiblingRecords =
        staleIdentity === null
          ? 0
          : provenanceRows.filter(
              (record: any) =>
                record !== provenanceAtRow &&
                provenanceIdentityFingerprint(record) === staleIdentity
            ).length;
      const staleVerifiedOccurrences =
        staleIdentity === null
          ? 0
          : Array.from(currentSheetIdentityByRow.values()).filter(
              (value: string | null) => value === staleIdentity
            ).length;
      const ambiguousReuse =
        staleIdentity === null ||
        blockers.includes("AMBIGUOUS_PROVENANCE_REBIND") ||
        staleSiblingRecords > 0 ||
        staleVerifiedOccurrences > 1;
      if (ambiguousReuse) {
        // CASE D — ambiguous/malformed: fail closed with provenance context.
        provenance = provenanceAtRow;
        atRowIdentityChanged = true;
        if (staleIdentity === null) {
          // Malformed legacy record (R1-D contract).
          if (identityMatches.length === 0) {
            blockers.push("SYNC_IDENTITY_CHANGED");
          }
        } else if (!blockers.includes("AMBIGUOUS_PROVENANCE_REBIND")) {
          // Well-formed identity claimed by multiple locators / seen in
          // multiple verified rows — refuse to guess the authoritative one.
          blockers.push("AMBIGUOUS_PROVENANCE_REBIND");
        }
      } else {
        // CASE C — true row reuse: the old identity's only locator is this
        // row, and the sheet now carries a different (verified) identity.
        // Release the stale locator and let this row follow the normal
        // NEW/existing-candidate path; sync reconciles the locator
        // (overwrite/delete) with a preview-bound ownership guard.
        reusedStaleProvenanceId = Number(provenanceAtRow.id);
        reusedProvenanceDisposition =
          staleVerifiedOccurrences === 1 ? "REBOUND" : "ROW_REUSED";
      }
    }

    if (provenance && !atRowIdentityChanged) {
      // Defensive re-check: canonical identity equality is guaranteed by the
      // match above, but keep the explicit blocker for stored-field drift.
      if (
        provenance.normalizedTitle !== parsed.normalizedTitle ||
        !sameEpisodeIdentity(provenance.episodeNumber, parsed.episodeNumber)
      ) {
        blockers.push("SYNC_IDENTITY_CHANGED");
      }
      // Translation document changes are a source update/rebind on the SAME
      // Episode Pack — never a hard blocker (TRANSLATION_SOURCE_CHANGED /
      // SYNC_TARGET_SOURCE_CHANGED removed from this path).
      const [workItem] = await db
        .select({
          id: workspaceEditorialWorkItems.id,
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
            eq(workspaceEditorialWorkItems.id, provenance.workItemId),
            eq(workspaceKanbanCards.status, "active")
          )
        )
        .limit(1);
      let provenanceSourceAlreadyLinked = false;
      let provenanceSourceReplacementExpected = false;
      let canonicalDisposition: "SAME_IDENTITY" | "REBOUND" = "SAME_IDENTITY";
      let staleAtRowProvenanceId: number | null = null;
      let provenanceObservedActiveSourceKeys: string[] = [];
      if (!workItem) {
        blockers.push("SYNC_TARGET_MISSING");
      } else {
        const activeSources = await db
          .select({
            providerDocumentId: workspaceEditorialSources.providerDocumentId,
            sourceKind: workspaceEditorialSources.sourceKind,
            sourceKey: workspaceEditorialSources.sourceKey,
          })
          .from(workspaceEditorialSources)
          .where(
            and(
              eq(workspaceEditorialSources.workItemId, provenance.workItemId),
              eq(workspaceEditorialSources.status, "active")
            )
          );
        const matchingSource = activeSources.some(
          (source: any) => source.providerDocumentId === translationDocumentId
        );
        const conflictingSource = activeSources.some(
          (source: any) =>
            source.providerDocumentId &&
            source.providerDocumentId !== translationDocumentId
        );
        // Same canonical identity + different active translation source =>
        // the sync may replace/rebind the source onto the existing pack.
        provenanceSourceReplacementExpected = conflictingSource;
        // Bind the replacement authorization to the exact observed state,
        // using the same `<sourceKind>:<sourceKey>` identity the source
        // mutation service itself uses for conflict decisions.
        provenanceObservedActiveSourceKeys = canonicalizeActiveSourceKeys(
          activeSources.map(
            (source: any) => `${String(source.sourceKind)}:${String(source.sourceKey)}`
          )
        );
        if (!matchingSource && activeSources.length === 0 && workItem.columnKey !== "new") {
          blockers.push("EXISTING_PACK_NOT_EDITABLE");
        }
        provenanceSourceAlreadyLinked = matchingSource;
      }
      const provenanceWorkspaceNovel = workspaceNovelRows.find(
        (item: any) => Number(item.id) === Number(provenance.workspaceNovelId)
      );
      canonicalDisposition =
        Number(provenance.rowNumber) === rowNumber ? "SAME_IDENTITY" : "REBOUND";
      // IPE-061: an at-row record carrying a DIFFERENT identity than this
      // canonical match is a stale locator — reconciled (deleted) when this
      // row syncs, so the matched provenance record remains the single owner.
      if (
        provenanceAtRow &&
        Number(provenanceAtRow.id) !== Number(provenance.id)
      ) {
        staleAtRowProvenanceId = Number(provenanceAtRow.id);
      }
      rows.push({
        rowNumber,
        status: masterIntakeProvenancePreviewStatus({
          hasBlockers: blockers.length > 0,
          rowUnchanged: provenance.rowFingerprint === rowFingerprint,
          sourceAlreadyLinked: provenanceSourceAlreadyLinked,
          workspaceNovelActive: provenanceWorkspaceNovel?.status === "active",
        }),
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
        provenanceId: Number(provenance.id),
        provenanceRowNumber: Number(provenance.rowNumber),
        blockers,
        sourceAlreadyLinked: provenanceSourceAlreadyLinked,
        sourceReplacementExpected: provenanceSourceReplacementExpected,
        observedActiveSourceKeys: provenanceObservedActiveSourceKeys,
        provenanceDisposition: canonicalDisposition,
        reconcileStaleProvenanceId: staleAtRowProvenanceId,
      });
      continue;
    }

    if (atRowIdentityChanged) {
      // F1: the row's stored provenance no longer matches this row's
      // canonical identity (title/range changed, or the legacy record is
      // malformed). Report the conflict from the provenance context itself —
      // no candidate search, no new/rebound Episode Pack, no source
      // replacement, no NEW-path derivation.
      const provenanceWorkspaceNovel = workspaceNovelRows.find(
        (item: any) => Number(item.id) === Number(provenance.workspaceNovelId)
      );
      rows.push({
        rowNumber,
        status: "CONFLICT",
        rowFingerprint,
        rawTitle,
        novelTitle: parsed.novelTitle,
        episodeNumber: parsed.episodeNumber,
        translationDocUrl,
        webSourceUrl,
        preparedSourceDocUrl,
        existingNovelId: Number(provenance.workspaceNovelId)
          ? Number(provenanceWorkspaceNovel?.novelId ?? 0) || null
          : null,
        workspaceNovelId: Number(provenance.workspaceNovelId) || null,
        workItemId: Number(provenance.workItemId) || null,
        provenanceId: Number(provenance.id),
        provenanceRowNumber: Number(provenance.rowNumber),
        blockers,
        sourceAlreadyLinked: false,
        sourceReplacementExpected: false,
        observedActiveSourceKeys: [],
        provenanceDisposition: "NONE",
        reconcileStaleProvenanceId: null,
      });
      continue;
    }

    const candidates = titles.get(parsed.normalizedTitle) ?? [];
    if (candidates.length > 1) blockers.push("AMBIGUOUS_NOVEL_TITLE");
    const candidate = candidates.length === 1 ? candidates[0] : null;
    let workspaceNovelId: number | null = null;
    let workItemId: number | null = null;
    let sourceAlreadyLinked = false;
    let sourceReplacementExpected = false;
    let observedActiveSourceKeys: string[] = [];

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
          const span = parseMasterIntakeEpisodeSpan(entry.item.episodeNumber ?? "");
          if (!span || !spansOverlap(span, { start: parsed.rangeStart, end: parsed.rangeEnd })) continue;
          if (
            span.start === parsed.rangeStart &&
            span.end === parsed.rangeEnd
          ) {
            workItemId = Number(entry.item.id);
            const linkedProvenance = provenanceRows.find(
              (provenance: any) =>
                Number(provenance.workItemId) === workItemId &&
                Number(provenance.rowNumber) !== rowNumber
            );
            if (linkedProvenance) {
              blockers.push("WORK_ITEM_ALREADY_LINKED_TO_SHEET_ROW");
            }
            const activeSources = await db
              .select({
                providerDocumentId: workspaceEditorialSources.providerDocumentId,
                sourceKind: workspaceEditorialSources.sourceKind,
                sourceKey: workspaceEditorialSources.sourceKey,
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
            // Same normalized title + exact canonical episode span + a
            // different active translation source = source update/rebind on
            // the existing pack — NOT an identity conflict.
            sourceReplacementExpected = conflictingSource;
            // Bind the replacement authorization to the exact observed state.
            observedActiveSourceKeys = canonicalizeActiveSourceKeys(
              activeSources.map(
                (source: any) => `${String(source.sourceKind)}:${String(source.sourceKey)}`
              )
            );
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
      provenanceId: null,
      provenanceRowNumber: null,
      blockers,
      sourceAlreadyLinked,
      sourceReplacementExpected,
      observedActiveSourceKeys,

      provenanceDisposition: reusedProvenanceDisposition ?? "NONE",
      reconcileStaleProvenanceId: reusedStaleProvenanceId,
    });
  }

  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex]!;
    const leftParsed = parseMasterIntakeTitleRange(left.rawTitle);
    if (!leftParsed) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const right = rows[rightIndex]!;
      const rightParsed = parseMasterIntakeTitleRange(right.rawTitle);
      if (!rightParsed || leftParsed.normalizedTitle !== rightParsed.normalizedTitle) continue;
      if (
        !spansOverlap(
          { start: leftParsed.rangeStart, end: leftParsed.rangeEnd },
          { start: rightParsed.rangeStart, end: rightParsed.rangeEnd }
        )
      ) {
        continue;
      }
      const exact =
        leftParsed.rangeStart === rightParsed.rangeStart &&
        leftParsed.rangeEnd === rightParsed.rangeEnd;
      const blocker = exact
        ? "DUPLICATE_BATCH_EPISODE_IDENTITY"
        : "BATCH_EPISODE_RANGE_OVERLAP";
      if (!left.blockers.includes(blocker)) left.blockers.push(blocker);
      if (!right.blockers.includes(blocker)) right.blockers.push(blocker);
      left.status = "CONFLICT";
      right.status = "CONFLICT";
    }
  }

  const provenanceRebindRows = rows.filter(
    row =>
      row.provenanceId !== null &&
      row.provenanceRowNumber !== null &&
      row.provenanceRowNumber !== row.rowNumber
  );
  if (provenanceRebindRows.length > 0) {
    const movingIds = new Set(
      provenanceRebindRows.map(row => Number(row.provenanceId))
    );
    let unsafeBatch = provenanceRebindRows.some(row => row.status === "CONFLICT");
    for (const row of provenanceRebindRows) {
      const occupant = provenanceByRow.get(row.rowNumber) as any;
      if (
        occupant &&
        Number(occupant.id) !== Number(row.provenanceId) &&
        !movingIds.has(Number(occupant.id))
      ) {
        unsafeBatch = true;
      }
    }
    if (movingIds.size !== provenanceRebindRows.length) unsafeBatch = true;
    if (unsafeBatch) {
      for (const row of provenanceRebindRows) {
        if (!row.blockers.includes("PROVENANCE_REBIND_BATCH_INCOMPLETE")) {
          row.blockers.push("PROVENANCE_REBIND_BATCH_INCOMPLETE");
        }
        row.status = "CONFLICT";
      }
    }
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

  let novelId = row.existingNovelId;
  if (!novelId) {
    const db = await database();
    const titleRows = await db.select({ id: novels.id, title: novels.title }).from(novels);
    const matching = titleRows.filter(
      (candidate: any) =>
        normalizeMasterIntakeNovelTitle(String(candidate.title ?? "")) ===
        normalizeMasterIntakeNovelTitle(row.novelTitle!)
    );
    if (matching.length > 1) {
      throw new Error("Novel title became ambiguous after preview.");
    }
    novelId = matching.length === 1 ? Number(matching[0]!.id) : null;
  }

  if (novelId) {
    const bound = await bindPublicationNovel({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      novelId,
    });
    return {
      novelId,
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
  const defaultSale = defaultEditorialEpisodePackSaleFromRange(
    input.previewRow.episodeNumber!
  );
  const created = await createEditorialEpisodeWorkItem({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    episodeNumber: input.previewRow.episodeNumber!,
    saleMode: defaultSale.saleMode,
    price: defaultSale.price,
    isFree: defaultSale.isFree,
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
  if (!parsed || !input.row.translationDocUrl) {
    throw new Error("Master Intake row is no longer canonical.");
  }
  const translationDocumentId = googleDocumentIdFromUrlOrId(
    input.row.translationDocUrl
  );
  const preparedSourceDocumentId = input.row.preparedSourceDocUrl
    ? googleDocumentIdFromUrlOrId(input.row.preparedSourceDocUrl)
    : null;
  const preparedSourceDocUrl = preparedSourceDocumentId
    ? input.row.preparedSourceDocUrl
    : null;
  if (!translationDocumentId) {
    throw new Error("Master Intake translation document identity is invalid.");
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
    preparedSourceDocUrl,
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
  // IPE-061 TOCTOU guard: a reused row's sync is bound to the exact stale
  // locator observed at preview time. If concurrent work reconciled or
  // moved it, refuse this row instead of overwriting someone else's record.
  if (input.row.reconcileStaleProvenanceId != null && existing) {
    if (Number(existing.id) !== input.row.reconcileStaleProvenanceId) {
      throw new WorkspaceMasterIntakeError(
        "STALE_PREVIEW",
        "Provenance ownership of this row changed after preview. Preview again before syncing."
      );
    }
    if (
      input.row.provenanceDisposition === "REBOUND" &&
      input.row.provenanceId != null &&
      Number(input.row.provenanceId) !== input.row.reconcileStaleProvenanceId
    ) {
      // The canonical identity matched a provenance record elsewhere: delete
      // the stale at-row locator and keep the matched record as the single owner.
      await db
        .delete(workspaceMasterIntakeRows)
        .where(eq(workspaceMasterIntakeRows.id, Number(existing.id)));
      return;
    }
    // ROW_REUSED: fall through — the update below overwrites the stale
    // locator in place (no release gap; reconcile-by-overwrite).
  }
  if (existing) {
    await db
      .update(workspaceMasterIntakeRows)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(workspaceMasterIntakeRows.id, existing.id));
  } else {
    await db.insert(workspaceMasterIntakeRows).values(values);
  }
}

async function rebindMovedMasterIntakeProvenance(preview: PreviewResult) {
  const moves = preview.rows.filter(
    row =>
      row.status !== "CONFLICT" &&
      row.provenanceId !== null &&
      row.provenanceRowNumber !== null &&
      row.provenanceRowNumber !== row.rowNumber
  );
  if (moves.length === 0) return;

  const db = await database();
  await db.transaction(async (tx: any) => {
    const scopeRows = await tx
      .select()
      .from(workspaceMasterIntakeRows)
      .where(
        and(
          eq(workspaceMasterIntakeRows.workspaceId, preview.workspaceId),
          eq(workspaceMasterIntakeRows.spreadsheetId, preview.target.spreadsheetId),
          eq(workspaceMasterIntakeRows.sheetId, preview.target.sheetId)
        )
      )
      .for("update");
    const byId = new Map(scopeRows.map((row: any) => [Number(row.id), row]));
    const byRow = new Map(scopeRows.map((row: any) => [Number(row.rowNumber), row]));
    const movingIds = new Set(moves.map(row => Number(row.provenanceId)));

    if (movingIds.size !== moves.length) {
      throw new Error("Master Intake provenance rebind is ambiguous.");
    }

    for (const move of moves) {
      const record = byId.get(Number(move.provenanceId)) as any;
      if (
        !record ||
        Number(record.workItemId) !== Number(move.workItemId) ||
        Number(record.workspaceNovelId) !== Number(move.workspaceNovelId) ||
        Number(record.rowNumber) !== Number(move.provenanceRowNumber)
      ) {
        throw new Error("Master Intake provenance changed before row rebind.");
      }
      const parsed = parseMasterIntakeTitleRange(move.rawTitle);
      const translationDocumentId = move.translationDocUrl
        ? googleDocumentIdFromUrlOrId(move.translationDocUrl)
        : null;
      const preparedSourceDocumentId = move.preparedSourceDocUrl
        ? googleDocumentIdFromUrlOrId(move.preparedSourceDocUrl)
        : null;
      if (!parsed || !translationDocumentId) {
        throw new Error("Master Intake row identity became invalid before row rebind.");
      }
      const currentIdentity = masterIntakeRowIdentityFingerprint({
        spreadsheetId: preview.target.spreadsheetId,
        sheetId: preview.target.sheetId,
        sheetName: preview.target.sheetName,
        rowNumber: move.rowNumber,
        novelTitle: parsed.novelTitle,
        normalizedTitle: parsed.normalizedTitle,
        episodeNumber: parsed.episodeNumber,
        translationDocUrl: move.translationDocUrl!,
        translationDocumentId,
        webSourceUrl: move.webSourceUrl,
        preparedSourceDocUrl: move.preparedSourceDocUrl,
        preparedSourceDocumentId,
      });
      if (provenanceIdentityFingerprint(record) !== currentIdentity) {
        throw new Error("Master Intake source identity changed before row rebind.");
      }
      const occupant = byRow.get(move.rowNumber) as any;
      if (
        occupant &&
        Number(occupant.id) !== Number(move.provenanceId) &&
        !movingIds.has(Number(occupant.id))
      ) {
        throw new Error("Master Intake row rebind target became occupied.");
      }
      const temporaryRow = -Number(move.provenanceId);
      const temporaryOccupant = byRow.get(temporaryRow) as any;
      if (temporaryOccupant && Number(temporaryOccupant.id) !== Number(move.provenanceId)) {
        throw new Error("Master Intake provenance rebind temporary slot is unavailable.");
      }
    }

    for (const move of moves) {
      const temporaryRow = -Number(move.provenanceId);
      const update = await tx
        .update(workspaceMasterIntakeRows)
        .set({ rowNumber: temporaryRow })
        .where(
          and(
            eq(workspaceMasterIntakeRows.id, Number(move.provenanceId)),
            eq(workspaceMasterIntakeRows.rowNumber, Number(move.provenanceRowNumber))
          )
        );
      if (affectedRows(update) !== 1) {
        throw new Error("Master Intake provenance changed during row rebind.");
      }
    }
    for (const move of moves) {
      const temporaryRow = -Number(move.provenanceId);
      const update = await tx
        .update(workspaceMasterIntakeRows)
        .set({ rowNumber: move.rowNumber })
        .where(
          and(
            eq(workspaceMasterIntakeRows.id, Number(move.provenanceId)),
            eq(workspaceMasterIntakeRows.rowNumber, temporaryRow)
          )
        );
      if (affectedRows(update) !== 1) {
        throw new Error("Master Intake provenance rebind could not be finalized.");
      }
    }
  });
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

  await rebindMovedMasterIntakeProvenance(preview);

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
      // R2 TOCTOU guard: a replacement authorization without the preview-
      // observed active-source binding must never mutate source state. The
      // preview fingerprint version makes such tokens stale anyway; this is
      // defense in depth so a boolean alone can never authorize replacement.
      if (row.sourceReplacementExpected === true && !Array.isArray(row.observedActiveSourceKeys)) {
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
          error:
            "STALE_PREVIEW: source replacement requires the preview-observed active source state.",
        });
        continue;
      }
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
            // Same canonical Episode Pack identity + different translation
            // document: the sync explicitly replaces the pack's active
            // source. importEditorialSource verifies the current active
            // source state against this preview-observed binding INSIDE its
            // mutation transaction (work item locked FOR UPDATE) — any drift
            // fails closed with STALE_PREVIEW and zero source mutation.
            replaceActiveSource: row.sourceReplacementExpected === true,
            expectedActiveSourceKeys: Array.isArray(row.observedActiveSourceKeys)
              ? row.observedActiveSourceKeys
              : undefined,
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
