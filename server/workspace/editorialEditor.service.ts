import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  workspaceEditorialCheckerAllowWords,
  workspaceEditorialCheckerFindingStates,
  workspaceEditorialCheckerFindings,
  workspaceEditorialCheckerRuns,
  workspaceEditorialDraftEditEvents,
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDraftTransforms,
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  EditorialAccessError,
  resolveEditorialPluginAccess,
  type EditorialAccessPolicy,
} from "./editorialAccess.service";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import {
  editorialDraftSha256,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";
import {
  applyEditorialBulkCleanupToDocument,
  findingMatchesEditorialBulkCleanupAction,
  type EditorialBulkCleanupAction,
  type EditorialBulkCleanupFinding,
} from "./editorialBulkFindingCleanup.domain";
import { EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION } from "./editorialForeignChecker.domain";
import {
  EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
  evaluateEditorialFullChecker,
  previewEditorialFullCheckerTransform,
  previewEditorialFullCheckerTransforms,
  type EditorialFullCheckerTransformCode,
} from "./editorialFullChecker.domain";
import {
  applyEditorialDraftEdit,
  editorialEditIdempotencyPayloadSha256,
  EditorialEditorDomainError,
  type EditorialDraftEditCommand,
  type EditorialParagraphEditCommand,
} from "./editorialEditor.domain";
import { projectEditorialQcColumn } from "./editorialQcProjection.service";

export class WorkspaceEditorialEditorError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORK_ITEM_NOT_FOUND"
      | "DRAFT_NOT_FOUND"
      | "DRAFT_CONFLICT"
      | "FINDING_NOT_FOUND"
      | "FINDING_CONFLICT"
      | "EDIT_CONFLICT"
      | "UNDO_NOT_AVAILABLE"
      | "EDIT_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialEditorError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insertId(result: any) {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new WorkspaceEditorialEditorError(
      "DATABASE_UNAVAILABLE",
      "Workspace editor record was not persisted."
    );
  }
  return id;
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialEditorError(
      "DATABASE_UNAVAILABLE",
      "Workspace editor database is unavailable."
    );
  }
  return db;
}

async function requireWorkItem(
  db: any,
  actorUserId: number,
  workspaceId: number,
  workItemId: number,
  accessPolicy: EditorialAccessPolicy = "workspace_route"
) {
  // IPE-PLUGIN-001D-R2: the workspace_route policy preserves the historical
  // platform-admin gate bit-for-bit; plugin policies resolve the caller's
  // EFFECTIVE role from the database (owner via ownerUserId, else ACTIVE
  // workspaceMembers row) and enforce the policy grade. Fail-closed:
  // no workspace / no effective membership -> WORK_ITEM_NOT_FOUND (no
  // existence oracle); member below grade -> EDIT_FORBIDDEN (denied).
  if (accessPolicy !== "workspace_route") {
    const decision = await resolveEditorialPluginAccess(db, {
      actorUserId,
      workspaceId,
      policy: accessPolicy,
    });
    if (!decision.allowed) {
      if (decision.reason === "FORBIDDEN") throw new EditorialAccessError();
      throw new WorkspaceEditorialEditorError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was not found in this Workspace."
      );
    }
  } else {
    await requireWorkspacePlatformAdmin(db, actorUserId);
  }
  const [row] = await db
    .select({
      workItem: workspaceEditorialWorkItems,
      card: workspaceKanbanCards,
      board: workspaceKanbanBoards,
    })
    .from(workspaceEditorialWorkItems)
    .innerJoin(
      workspaceKanbanCards,
      eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id)
    )
    .innerJoin(
      workspaceKanbanBoards,
      eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id)
    )
    .where(
      and(
        eq(workspaceEditorialWorkItems.id, workItemId),
        eq(workspaceKanbanBoards.workspaceId, workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
        eq(workspaceKanbanBoards.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialEditorError(
      "WORK_ITEM_NOT_FOUND",
      "Editorial work item was not found in this Workspace."
    );
  }
  return row;
}

async function latestDraft(db: any, workItemId: number) {
  const [draft] = await db
    .select()
    .from(workspaceEditorialDrafts)
    .where(eq(workspaceEditorialDrafts.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialDrafts.version),
      desc(workspaceEditorialDrafts.id)
    )
    .limit(1);
  return draft ?? null;
}

async function loadFullCheckerAllowWords(db: any, workspaceId: number) {
  const rows = await db
    .select({ normalizedWord: workspaceEditorialCheckerAllowWords.normalizedWord })
    .from(workspaceEditorialCheckerAllowWords)
    .where(
      and(
        eq(workspaceEditorialCheckerAllowWords.workspaceId, workspaceId),
        eq(workspaceEditorialCheckerAllowWords.status, "active")
      )
    )
    .orderBy(asc(workspaceEditorialCheckerAllowWords.normalizedWord));
  return rows.map((row: any) => String(row.normalizedWord));
}

async function draftById(db: any, workItemId: number, draftId: number) {
  const [draft] = await db
    .select()
    .from(workspaceEditorialDrafts)
    .where(
      and(
        eq(workspaceEditorialDrafts.id, draftId),
        eq(workspaceEditorialDrafts.workItemId, workItemId)
      )
    )
    .limit(1);
  return draft ?? null;
}

async function loadDraftDocument(
  db: any,
  draftId: number
): Promise<EditorialDraftDocument> {
  const tabs = await db
    .select()
    .from(workspaceEditorialDraftTabs)
    .where(eq(workspaceEditorialDraftTabs.draftId, draftId))
    .orderBy(asc(workspaceEditorialDraftTabs.tabOrder));

  const result: EditorialDraftDocument = { tabs: [], warnings: [] };
  for (const tab of tabs) {
    const paragraphs = await db
      .select()
      .from(workspaceEditorialDraftParagraphs)
      .where(eq(workspaceEditorialDraftParagraphs.draftTabId, tab.id))
      .orderBy(asc(workspaceEditorialDraftParagraphs.paragraphOrder));
    const warnings = JSON.parse(tab.warningsJson || "[]") as string[];
    result.tabs.push({
      sourceTabId: tab.sourceTabId,
      tabOrder: tab.tabOrder,
      title: tab.title,
      paragraphs: paragraphs.map((paragraph: any) => ({
        paragraphKey: paragraph.paragraphKey,
        sourceParagraphIndex: paragraph.sourceParagraphIndex,
        paragraphOrder: paragraph.paragraphOrder,
        text: paragraph.text,
        sourceParagraphFingerprint: paragraph.sourceParagraphFingerprint,
        sourceOccurrenceCount: paragraph.sourceOccurrenceCount,
        sourceOccurrenceOrdinal: paragraph.sourceOccurrenceOrdinal,
        paragraphFingerprint: paragraph.paragraphFingerprint,
        occurrenceCount: paragraph.occurrenceCount,
        occurrenceOrdinal: paragraph.occurrenceOrdinal,
      })),
      fingerprintSequence: JSON.parse(
        tab.fingerprintSequenceJson || "[]"
      ) as string[],
      structuralSha256: tab.structuralSha256,
      chapterNumber: tab.chapterNumber,
      chapterTitle: tab.chapterTitle,
      warnings,
    });
    result.warnings.push(...warnings);
  }
  result.warnings = Array.from(new Set(result.warnings));
  return result;
}

async function persistManualDraft(
  tx: any,
  input: {
    workItemId: number;
    sourceSnapshotId: number;
    parentDraftId: number;
    version: number;
    actorUserId: number;
    transformCode:
      | "manual_edit"
      | "manual_undo"
      | "manual_tab_exclude"
      | "manual_tab_restore"
      | "bulk_finding_cleanup"
      | "full_checker_transform";
    beforeSha256: string;
    document: EditorialDraftDocument;
    presentationJson: string;
    details: Record<string, unknown>;
  }
) {
  const afterSha256 = editorialDraftSha256(input.document);
  const draftId = insertId(
    await tx.insert(workspaceEditorialDrafts).values({
      workItemId: input.workItemId,
      sourceSnapshotId: input.sourceSnapshotId,
      parentDraftId: input.parentDraftId,
      version: input.version,
      origin: "manual",
      transformCode: input.transformCode,
      draftSha256: afterSha256,
      presentationJson: input.presentationJson,
      warningsJson: JSON.stringify(input.document.warnings),
      createdByUserId: input.actorUserId,
    })
  );

  for (const tab of input.document.tabs) {
    const draftTabId = insertId(
      await tx.insert(workspaceEditorialDraftTabs).values({
        draftId,
        sourceTabId: tab.sourceTabId,
        tabOrder: tab.tabOrder,
        title: tab.title,
        fingerprintSequenceJson: JSON.stringify(tab.fingerprintSequence),
        structuralSha256: tab.structuralSha256,
        chapterNumber: tab.chapterNumber,
        chapterTitle: tab.chapterTitle,
        warningsJson: JSON.stringify(tab.warnings),
      })
    );
    if (tab.paragraphs.length) {
      await tx.insert(workspaceEditorialDraftParagraphs).values(
        tab.paragraphs.map(paragraph => ({
          draftTabId,
          paragraphKey: paragraph.paragraphKey,
          sourceParagraphIndex: paragraph.sourceParagraphIndex,
          paragraphOrder: paragraph.paragraphOrder,
          text: paragraph.text,
          sourceParagraphFingerprint: paragraph.sourceParagraphFingerprint,
          sourceOccurrenceCount: paragraph.sourceOccurrenceCount,
          sourceOccurrenceOrdinal: paragraph.sourceOccurrenceOrdinal,
          paragraphFingerprint: paragraph.paragraphFingerprint,
          occurrenceCount: paragraph.occurrenceCount,
          occurrenceOrdinal: paragraph.occurrenceOrdinal,
        }))
      );
    }
  }

  await tx.insert(workspaceEditorialDraftTransforms).values({
    draftId,
    parentDraftId: input.parentDraftId,
    transformCode: input.transformCode,
    beforeSha256: input.beforeSha256,
    afterSha256,
    detailsJson: JSON.stringify(input.details),
    actorUserId: input.actorUserId,
  });
  return { draftId, afterSha256 };
}

async function validateFinding(
  tx: any,
  input: {
    workItemId: number;
    currentDraftId: number;
    findingId: number;
    command: EditorialParagraphEditCommand;
  }
) {
  const [row] = await tx
    .select({
      finding: workspaceEditorialCheckerFindings,
      run: workspaceEditorialCheckerRuns,
    })
    .from(workspaceEditorialCheckerFindings)
    .innerJoin(
      workspaceEditorialCheckerRuns,
      eq(
        workspaceEditorialCheckerFindings.runId,
        workspaceEditorialCheckerRuns.id
      )
    )
    .where(
      and(
        eq(workspaceEditorialCheckerFindings.id, input.findingId),
        eq(workspaceEditorialCheckerRuns.workItemId, input.workItemId)
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_NOT_FOUND",
      "Finding was not found in this work item."
    );
  }
  if (row.run.draftId !== input.currentDraftId) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Finding belongs to an older Draft."
    );
  }
  if (
    row.finding.paragraphKey !== input.command.paragraphKey ||
    row.finding.paragraphFingerprint !==
      input.command.expectedParagraphFingerprint
  ) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Finding paragraph identity no longer matches the edit target."
    );
  }
  if (
    input.command.kind === "replace_sentence" &&
    (row.finding.sentenceStartOffset !== input.command.startOffset ||
      row.finding.sentenceEndOffset !== input.command.endOffset ||
      row.finding.sentenceText !== input.command.expectedText)
  ) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Finding sentence range no longer matches the requested edit."
    );
  }
  return row.finding;
}

function mapDomainError(error: unknown): never {
  if (error instanceof EditorialEditorDomainError) {
    const conflict = [
      "PARAGRAPH_NOT_FOUND",
      "PARAGRAPH_AMBIGUOUS",
      "PARAGRAPH_CONFLICT",
      "TAB_NOT_FOUND",
      "TAB_AMBIGUOUS",
      "TAB_CONFLICT",
      "RANGE_CONFLICT",
    ].includes(error.code);
    throw new WorkspaceEditorialEditorError(
      conflict ? "EDIT_CONFLICT" : "EDIT_INVALID",
      error.message
    );
  }
  throw error;
}

export async function getEditorialEditorReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const draft = await latestDraft(db, input.workItemId);
  if (!draft) {
    return { latestDraft: null, canUndo: false, lastEdit: null, history: [] };
  }
  const [lastEdit] = await db
    .select()
    .from(workspaceEditorialDraftEditEvents)
    .where(eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId))
    .orderBy(
      desc(workspaceEditorialDraftEditEvents.createdAt),
      desc(workspaceEditorialDraftEditEvents.id)
    )
    .limit(1);
  const history = await db
    .select()
    .from(workspaceEditorialDraftEditEvents)
    .where(eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId))
    .orderBy(
      desc(workspaceEditorialDraftEditEvents.createdAt),
      desc(workspaceEditorialDraftEditEvents.id)
    )
    .limit(20);

  const currentDocument = await loadDraftDocument(db, draft.id);
  let rootDraft = draft;
  let baselineDocument = currentDocument;
  while (rootDraft.parentDraftId) {
    const prior = await draftById(db, input.workItemId, rootDraft.parentDraftId);
    if (!prior) break;
    rootDraft = prior;
    baselineDocument = await loadDraftDocument(db, prior.id);
  }
  const currentIds = new Set(currentDocument.tabs.map(tab => tab.sourceTabId));
  const excludedTabs = baselineDocument.tabs
    .filter(tab => !currentIds.has(tab.sourceTabId))
    .map(tab => ({ sourceTabId: tab.sourceTabId, title: tab.title, tabOrder: tab.tabOrder }));

  return {
    latestDraft: draft,
    tabs: currentDocument.tabs.map(tab => ({ sourceTabId: tab.sourceTabId, title: tab.title, tabOrder: tab.tabOrder })),
    excludedTabs,
    canUndo: Boolean(
      draft.origin === "manual" &&
      draft.parentDraftId &&
      lastEdit?.toDraftId === draft.id &&
      lastEdit?.editKind !== "undo"
    ),
    lastEdit: lastEdit ?? null,
    history,
  };
}

async function createTabRevision(input: {
  actorUserId: number; workspaceId: number; workItemId: number;
  expectedDraftId: number; expectedDraftSha256: string; sourceTabId: string;
  action: "exclude" | "restore";
}) {
  const db = await database();
  await requireWorkItem(db, input.actorUserId, input.workspaceId, input.workItemId);
  return db.transaction(async (tx: any) => {
    const current = await latestDraft(tx, input.workItemId);
    if (!current || current.id !== input.expectedDraftId || current.draftSha256 !== input.expectedDraftSha256) {
      throw new WorkspaceEditorialEditorError("DRAFT_CONFLICT", "Draft changed before the tab action was applied.");
    }
    const document = await loadDraftDocument(tx, current.id);
    let nextDocument: EditorialDraftDocument;
    if (input.action === "exclude") {
      if (document.tabs.length <= 1) throw new WorkspaceEditorialEditorError("EDIT_INVALID", "Draft must keep at least one tab.");
      const target = document.tabs.find(tab => tab.sourceTabId === input.sourceTabId);
      if (!target) throw new WorkspaceEditorialEditorError("EDIT_CONFLICT", "Tab is not present in the current Draft.");
      nextDocument = { ...document, tabs: document.tabs.filter(tab => tab.sourceTabId !== input.sourceTabId) };
    } else {
      if (document.tabs.some(tab => tab.sourceTabId === input.sourceTabId)) throw new WorkspaceEditorialEditorError("EDIT_CONFLICT", "Tab is already present in the current Draft.");
      let cursor = current;
      let restored: EditorialDraftDocument["tabs"][number] | undefined;
      while (cursor.parentDraftId && !restored) {
        const prior = await draftById(tx, input.workItemId, cursor.parentDraftId);
        if (!prior) break;
        const priorDocument = await loadDraftDocument(tx, prior.id);
        restored = priorDocument.tabs.find(tab => tab.sourceTabId === input.sourceTabId);
        cursor = prior;
      }
      if (!restored) throw new WorkspaceEditorialEditorError("EDIT_CONFLICT", "Excluded tab could not be restored from Draft history.");
      nextDocument = { ...document, tabs: [...document.tabs, restored].sort((a,b) => a.tabOrder - b.tabOrder) };
    }
    nextDocument.warnings = Array.from(new Set(nextDocument.tabs.flatMap(tab => tab.warnings)));
    const persisted = await persistManualDraft(tx, {
      workItemId: input.workItemId, sourceSnapshotId: current.sourceSnapshotId, parentDraftId: current.id,
      version: current.version + 1, actorUserId: input.actorUserId,
      transformCode: input.action === "exclude" ? "manual_tab_exclude" : "manual_tab_restore",
      beforeSha256: current.draftSha256, document: nextDocument, presentationJson: current.presentationJson,
      details: { action: input.action, sourceTabId: input.sourceTabId },
    });
    await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId, expectedDraftId: persisted.draftId, targetColumnKey: "editing",
      actorUserId: input.actorUserId, reason: `workspace_editor_tab_${input.action}`,
      idempotencyKey: `editor-tab-${input.action}-${persisted.draftId}`,
    });
    return { draft: await draftById(tx, input.workItemId, persisted.draftId), action: input.action, sourceTabId: input.sourceTabId };
  });
}

export async function getEditorialFullCheckerReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
}) {
  const db = await database();
  const row = await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const draft = await latestDraft(db, input.workItemId);
  if (!draft) {
    return {
      engineVersion: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
      latestDraft: null,
      checker: null,
      transforms: [],
      allSafe: null,
    };
  }
  const document = await loadDraftDocument(db, draft.id);
  const allowWords = await loadFullCheckerAllowWords(db, input.workspaceId);
  const checker = evaluateEditorialFullChecker({
    document,
    episodeNumber: row.workItem.episodeNumber ?? null,
    allowWords,
  });
  const previews = previewEditorialFullCheckerTransforms({ document, allowWords });
  return {
    engineVersion: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
    latestDraft: draft,
    checker,
    transforms: previews.transforms,
    allSafe: previews.allSafe,
  };
}

export async function applyEditorialFullCheckerTransformRevision(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  transformCode: EditorialFullCheckerTransformCode | "all_safe";
  expectedTransformId: string;
  idempotencyKey: string;
}) {
  const db = await database();
  const row = await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const payloadSha256 = sha256(
    JSON.stringify({
      version: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
      expectedDraftId: input.expectedDraftId,
      expectedDraftVersion: input.expectedDraftVersion,
      expectedDraftSha256: input.expectedDraftSha256,
      transformCode: input.transformCode,
      expectedTransformId: input.expectedTransformId,
    })
  );

  return db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new WorkspaceEditorialEditorError(
        "WORK_ITEM_NOT_FOUND",
        "Work item was removed before Full Checker transform started."
      );
    }

    const [replay] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(
        and(
          eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId),
          eq(workspaceEditorialDraftEditEvents.idempotencyKey, input.idempotencyKey)
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.payloadSha256 !== payloadSha256 ||
        replay.actorUserId !== input.actorUserId ||
        replay.editKind !== "bulk_cleanup"
      ) {
        throw new WorkspaceEditorialEditorError(
          "EDIT_CONFLICT",
          "Full Checker transform idempotency key was reused with another payload."
        );
      }
      const currentDraft = await latestDraft(tx, input.workItemId);
      return {
        draft: await draftById(tx, input.workItemId, replay.toDraftId),
        editEvent: replay,
        replayed: true,
        isCurrent: currentDraft?.id === replay.toDraftId,
        transformCode: input.transformCode,
      };
    }

    const current = await latestDraft(tx, input.workItemId);
    if (
      !current ||
      current.id !== input.expectedDraftId ||
      current.version !== input.expectedDraftVersion ||
      current.draftSha256 !== input.expectedDraftSha256
    ) {
      throw new WorkspaceEditorialEditorError(
        "DRAFT_CONFLICT",
        "Draft changed after Full Checker preview. Preview again before applying."
      );
    }

    const document = await loadDraftDocument(tx, current.id);
    const allowWords = await loadFullCheckerAllowWords(tx, input.workspaceId);
    const preview = previewEditorialFullCheckerTransform({
      document,
      transformCode: input.transformCode,
      allowWords,
    });
    if (preview.transformId !== input.expectedTransformId) {
      throw new WorkspaceEditorialEditorError(
        "EDIT_CONFLICT",
        "Full Checker preview is stale. Preview again before applying."
      );
    }
    if (!preview.changed) {
      throw new WorkspaceEditorialEditorError(
        "EDIT_INVALID",
        "Full Checker transform no longer changes the Draft."
      );
    }
    if (!preview.idempotent) {
      throw new WorkspaceEditorialEditorError(
        "EDIT_INVALID",
        "Full Checker transform failed its idempotency check and cannot be applied."
      );
    }

    const checker = evaluateEditorialFullChecker({
      document,
      episodeNumber: row.workItem.episodeNumber ?? null,
      allowWords,
    });
    const persisted = await persistManualDraft(tx, {
      workItemId: input.workItemId,
      sourceSnapshotId: current.sourceSnapshotId,
      parentDraftId: current.id,
      version: current.version + 1,
      actorUserId: input.actorUserId,
      transformCode: "full_checker_transform",
      beforeSha256: current.draftSha256,
      document: preview.document,
      presentationJson: current.presentationJson,
      details: {
        engineVersion: EDITORIAL_FULL_CHECKER_ENGINE_VERSION,
        configIdentity: checker.configIdentity,
        allowListIdentity: checker.allowListIdentity,
        transformId: preview.transformId,
        transformCode: input.transformCode,
        safetyClass: preview.safetyClass,
        ruleCodes: preview.ruleCodes,
        changedParagraphCount: preview.changedParagraphCount,
        idempotent: preview.idempotent,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // IPE-058-D intentionally reuses the existing bulk_cleanup audit enum.
    // Adding a new editKind would require a schema migration, which this
    // milestone forbids. The exact Full Checker identity lives in the Draft
    // transform details while this event provides the existing idempotency
    // and from/to Draft audit boundary.
    const eventId = insertId(
      await tx.insert(workspaceEditorialDraftEditEvents).values({
        workItemId: input.workItemId,
        fromDraftId: current.id,
        toDraftId: persisted.draftId,
        editKind: "bulk_cleanup",
        paragraphKey: null,
        findingKey: null,
        startOffset: null,
        endOffset: null,
        expectedTextSha256: current.draftSha256,
        replacementTextSha256: persisted.afterSha256,
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
      })
    );

    await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: persisted.draftId,
      targetColumnKey: "editing",
      actorUserId: input.actorUserId,
      reason: "workspace_full_checker_transform",
      idempotencyKey: `full-checker-transform-${eventId}`,
    });

    return {
      draft: await draftById(tx, input.workItemId, persisted.draftId),
      editEvent: (
        await tx
          .select()
          .from(workspaceEditorialDraftEditEvents)
          .where(eq(workspaceEditorialDraftEditEvents.id, eventId))
          .limit(1)
      )[0],
      replayed: false,
      isCurrent: true,
      transformCode: input.transformCode,
      transformId: preview.transformId,
      changedParagraphCount: preview.changedParagraphCount,
      ruleCodes: preview.ruleCodes,
    };
  });
}

export async function excludeEditorialDraftTab(input: Omit<Parameters<typeof createTabRevision>[0], "action">) {
  return createTabRevision({ ...input, action: "exclude" });
}
export async function restoreEditorialDraftTab(input: Omit<Parameters<typeof createTabRevision>[0], "action">) {
  return createTabRevision({ ...input, action: "restore" });
}

export async function applyEditorialEditorEdit(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  findingId?: number;
  findingKey?: string;
  command: EditorialDraftEditCommand;
  idempotencyKey: string;
  /** IPE-PLUGIN-001D-R2: set by server/plugin wiring only - never client input. */
  accessPolicy?: EditorialAccessPolicy;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId,
    input.accessPolicy ?? "workspace_route"
  );
  if (Boolean(input.findingKey) !== Boolean(input.findingId)) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Finding id and finding key must be supplied together."
    );
  }
  if (input.command.kind === "replace_tab" && input.findingId) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Whole-tab edits cannot be bound to one finding."
    );
  }
  const payloadSha256 = editorialEditIdempotencyPayloadSha256({
    expectedDraftId: input.expectedDraftId,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedDraftSha256: input.expectedDraftSha256,
    command: input.command,
    findingKey: input.findingKey ?? null,
  });

  return db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new WorkspaceEditorialEditorError(
        "WORK_ITEM_NOT_FOUND",
        "Work item was removed before the edit started."
      );
    }

    const [replay] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(
        and(
          eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId),
          eq(
            workspaceEditorialDraftEditEvents.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.payloadSha256 !== payloadSha256 ||
        replay.actorUserId !== input.actorUserId
      ) {
        throw new WorkspaceEditorialEditorError(
          "EDIT_CONFLICT",
          "Editor idempotency key was reused with another payload."
        );
      }
      const replayDraft = await draftById(
        tx,
        input.workItemId,
        replay.toDraftId
      );
      const currentDraft = await latestDraft(tx, input.workItemId);
      return {
        draft: replayDraft,
        editEvent: replay,
        replayed: true,
        isCurrent: currentDraft?.id === replay.toDraftId,
      };
    }

    const current = await latestDraft(tx, input.workItemId);
    if (!current) {
      throw new WorkspaceEditorialEditorError(
        "DRAFT_NOT_FOUND",
        "Import a source before editing."
      );
    }
    if (
      current.id !== input.expectedDraftId ||
      current.version !== input.expectedDraftVersion ||
      current.draftSha256 !== input.expectedDraftSha256
    ) {
      throw new WorkspaceEditorialEditorError(
        "DRAFT_CONFLICT",
        "Draft changed before this edit could be applied."
      );
    }

    let findingKey = input.findingKey ?? null;
    if (input.findingId && input.command.kind !== "replace_tab") {
      const finding = await validateFinding(tx, {
        workItemId: input.workItemId,
        currentDraftId: current.id,
        findingId: input.findingId,
        command: input.command,
      });
      findingKey = finding.findingKey;
      if (input.findingKey && input.findingKey !== finding.findingKey) {
        throw new WorkspaceEditorialEditorError(
          "FINDING_CONFLICT",
          "Finding key does not match finding id."
        );
      }
    }

    const document = await loadDraftDocument(tx, current.id);
    let edited: ReturnType<typeof applyEditorialDraftEdit>;
    try {
      // IPE-058-C review fix: the edit idempotency payload SHA is the
      // mutation-identity seed for minted paragraph keys — identical for an
      // exact mutation retry, different across Draft revisions, so a freshly
      // recreated paragraph can never resurrect a deleted paragraph's key.
      edited = applyEditorialDraftEdit(document, input.command, {
        identitySeed: payloadSha256,
      });
    } catch (error) {
      mapDomainError(error);
    }

    const persisted = await persistManualDraft(tx, {
      workItemId: input.workItemId,
      sourceSnapshotId: current.sourceSnapshotId,
      parentDraftId: current.id,
      version: current.version + 1,
      actorUserId: input.actorUserId,
      transformCode: "manual_edit",
      beforeSha256: current.draftSha256,
      document: edited.document,
      presentationJson: current.presentationJson,
      details: {
        ...edited.details,
        findingKey,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const eventId = insertId(
      await tx.insert(workspaceEditorialDraftEditEvents).values({
        workItemId: input.workItemId,
        fromDraftId: current.id,
        toDraftId: persisted.draftId,
        editKind: input.command.kind,
        paragraphKey:
          input.command.kind === "replace_tab" ? null : input.command.paragraphKey,
        findingKey,
        startOffset:
          input.command.kind === "replace_sentence" ||
          input.command.kind === "replace_range"
            ? (input.command.startOffset ?? null)
            : null,
        endOffset:
          input.command.kind === "replace_sentence" ||
          input.command.kind === "replace_range"
            ? (input.command.endOffset ?? null)
            : null,
        expectedTextSha256: sha256(input.command.expectedText),
        replacementTextSha256: sha256(input.command.replacementText),
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
      })
    );

    await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: persisted.draftId,
      targetColumnKey: "editing",
      actorUserId: input.actorUserId,
      reason: "workspace_editor_manual_edit",
      idempotencyKey: `editor-edit-${eventId}`,
    });

    const draft = await draftById(tx, input.workItemId, persisted.draftId);
    const [editEvent] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(eq(workspaceEditorialDraftEditEvents.id, eventId))
      .limit(1);
    return { draft, editEvent, replayed: false, isCurrent: true };
  });
}

export async function applyEditorialBulkFindingCleanupRevision(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  expectedRunId: number;
  expectedFindingKeys: string[];
  action: EditorialBulkCleanupAction;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );

  const expectedFindingKeys = Array.from(new Set(input.expectedFindingKeys)).sort();
  if (!expectedFindingKeys.length) {
    throw new WorkspaceEditorialEditorError(
      "EDIT_INVALID",
      "Bulk cleanup requires at least one open finding."
    );
  }
  const payloadSha256 = sha256(
    JSON.stringify({
      version: "workspace-editorial-bulk-cleanup-v1",
      expectedDraftId: input.expectedDraftId,
      expectedDraftVersion: input.expectedDraftVersion,
      expectedDraftSha256: input.expectedDraftSha256,
      expectedRunId: input.expectedRunId,
      expectedFindingKeys,
      action: input.action,
    })
  );

  return db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new WorkspaceEditorialEditorError(
        "WORK_ITEM_NOT_FOUND",
        "Work item was removed before bulk cleanup started."
      );
    }

    const [replay] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(
        and(
          eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId),
          eq(
            workspaceEditorialDraftEditEvents.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.payloadSha256 !== payloadSha256 ||
        replay.actorUserId !== input.actorUserId ||
        replay.editKind !== "bulk_cleanup"
      ) {
        throw new WorkspaceEditorialEditorError(
          "EDIT_CONFLICT",
          "Bulk cleanup idempotency key was reused with another payload."
        );
      }
      const currentDraft = await latestDraft(tx, input.workItemId);
      return {
        draft: await draftById(tx, input.workItemId, replay.toDraftId),
        editEvent: replay,
        replayed: true,
        isCurrent: currentDraft?.id === replay.toDraftId,
        removedFindingCount: 0,
        removedParagraphCount: 0,
        changedParagraphCount: 0,
      };
    }

    const current = await latestDraft(tx, input.workItemId);
    if (
      !current ||
      current.id !== input.expectedDraftId ||
      current.version !== input.expectedDraftVersion ||
      current.draftSha256 !== input.expectedDraftSha256
    ) {
      throw new WorkspaceEditorialEditorError(
        "DRAFT_CONFLICT",
        "Draft changed before bulk cleanup could be applied."
      );
    }

    const [run] = await tx
      .select()
      .from(workspaceEditorialCheckerRuns)
      .where(
        and(
          eq(workspaceEditorialCheckerRuns.id, input.expectedRunId),
          eq(workspaceEditorialCheckerRuns.workItemId, input.workItemId),
          eq(workspaceEditorialCheckerRuns.draftId, current.id)
        )
      )
      .limit(1);
    if (
      !run ||
      run.engineVersion !== EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION
    ) {
      throw new WorkspaceEditorialEditorError(
        "FINDING_CONFLICT",
        "Checker run is stale. Run the current checker before bulk cleanup."
      );
    }

    const findings = await tx
      .select()
      .from(workspaceEditorialCheckerFindings)
      .where(eq(workspaceEditorialCheckerFindings.runId, run.id));
    const states = await tx
      .select()
      .from(workspaceEditorialCheckerFindingStates)
      .where(
        eq(workspaceEditorialCheckerFindingStates.workItemId, input.workItemId)
      );
    const stateByKey = new Map<string, any>(
      states.map((state: any) => [String(state.findingKey), state])
    );

    const matched: EditorialBulkCleanupFinding[] = findings
      .map((finding: any): EditorialBulkCleanupFinding => ({
        findingKey: finding.findingKey,
        ruleKey: finding.ruleKey,
        token: finding.token,
        normalizedToken: finding.normalizedToken,
        sourceTabId: finding.sourceTabId,
        paragraphKey: finding.paragraphKey,
        paragraphOrder: finding.paragraphOrder,
        paragraphFingerprint: finding.paragraphFingerprint,
        startOffset: finding.startOffset,
        endOffset: finding.endOffset,
        disposition: stateByKey.get(finding.findingKey)?.disposition ?? "open",
        resolutionVersion: stateByKey.get(finding.findingKey)?.version ?? 0,
      }))
      .filter((finding: EditorialBulkCleanupFinding) =>
        findingMatchesEditorialBulkCleanupAction(finding, input.action)
      );

    const actualFindingKeys: string[] = matched
      .map((finding: EditorialBulkCleanupFinding) => finding.findingKey)
      .sort();
    if (
      actualFindingKeys.length !== expectedFindingKeys.length ||
      actualFindingKeys.some(
        (findingKey: string, index: number) => findingKey !== expectedFindingKeys[index]
      )
    ) {
      throw new WorkspaceEditorialEditorError(
        "FINDING_CONFLICT",
        "Open findings changed after cleanup preview. Preview again."
      );
    }

    const document = await loadDraftDocument(tx, current.id);
    let cleaned;
    try {
      cleaned = applyEditorialBulkCleanupToDocument({
        document,
        findings: matched,
      });
    } catch (error) {
      throw new WorkspaceEditorialEditorError(
        "EDIT_CONFLICT",
        error instanceof Error ? error.message : "Bulk cleanup could not be applied."
      );
    }

    const persisted = await persistManualDraft(tx, {
      workItemId: input.workItemId,
      sourceSnapshotId: current.sourceSnapshotId,
      parentDraftId: current.id,
      version: current.version + 1,
      actorUserId: input.actorUserId,
      transformCode: "bulk_finding_cleanup",
      beforeSha256: current.draftSha256,
      document: cleaned.document,
      presentationJson: current.presentationJson,
      details: {
        version: "workspace-editorial-bulk-cleanup-v1",
        action: input.action,
        checkerRunId: run.id,
        findingCount: cleaned.removedFindingCount,
        changedParagraphCount: cleaned.changedParagraphCount,
        removedParagraphCount: cleaned.removedParagraphCount,
        findingKeysSha256: sha256(expectedFindingKeys.join("\n")),
        idempotencyKey: input.idempotencyKey,
      },
    });

    const eventId = insertId(
      await tx.insert(workspaceEditorialDraftEditEvents).values({
        workItemId: input.workItemId,
        fromDraftId: current.id,
        toDraftId: persisted.draftId,
        editKind: "bulk_cleanup",
        paragraphKey: null,
        findingKey: null,
        startOffset: null,
        endOffset: null,
        expectedTextSha256: current.draftSha256,
        replacementTextSha256: persisted.afterSha256,
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
      })
    );

    await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: persisted.draftId,
      targetColumnKey: "editing",
      actorUserId: input.actorUserId,
      reason: "workspace_editor_bulk_finding_cleanup",
      idempotencyKey: `editor-bulk-cleanup-${eventId}`,
    });

    return {
      draft: await draftById(tx, input.workItemId, persisted.draftId),
      editEvent: (
        await tx
          .select()
          .from(workspaceEditorialDraftEditEvents)
          .where(eq(workspaceEditorialDraftEditEvents.id, eventId))
          .limit(1)
      )[0],
      replayed: false,
      isCurrent: true,
      removedFindingCount: cleaned.removedFindingCount,
      removedParagraphCount: cleaned.removedParagraphCount,
      changedParagraphCount: cleaned.changedParagraphCount,
    };
  });
}

export async function undoEditorialEditorEdit(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const payloadSha256 = sha256(
    JSON.stringify({
      kind: "undo",
      expectedDraftId: input.expectedDraftId,
      expectedDraftVersion: input.expectedDraftVersion,
      expectedDraftSha256: input.expectedDraftSha256,
    })
  );

  return db.transaction(async (tx: any) => {
    await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);

    const [replay] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(
        and(
          eq(workspaceEditorialDraftEditEvents.workItemId, input.workItemId),
          eq(
            workspaceEditorialDraftEditEvents.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.payloadSha256 !== payloadSha256 ||
        replay.actorUserId !== input.actorUserId ||
        replay.editKind !== "undo"
      ) {
        throw new WorkspaceEditorialEditorError(
          "EDIT_CONFLICT",
          "Undo idempotency key was reused with another payload."
        );
      }
      const currentDraft = await latestDraft(tx, input.workItemId);
      return {
        draft: await draftById(tx, input.workItemId, replay.toDraftId),
        editEvent: replay,
        replayed: true,
        isCurrent: currentDraft?.id === replay.toDraftId,
      };
    }

    const current = await latestDraft(tx, input.workItemId);
    if (
      !current ||
      current.id !== input.expectedDraftId ||
      current.version !== input.expectedDraftVersion ||
      current.draftSha256 !== input.expectedDraftSha256
    ) {
      throw new WorkspaceEditorialEditorError(
        "DRAFT_CONFLICT",
        "Draft changed before undo could be applied."
      );
    }
    if (current.origin !== "manual" || !current.parentDraftId) {
      throw new WorkspaceEditorialEditorError(
        "UNDO_NOT_AVAILABLE",
        "The current Draft has no manual edit to undo."
      );
    }
    const [currentEdit] = await tx
      .select()
      .from(workspaceEditorialDraftEditEvents)
      .where(eq(workspaceEditorialDraftEditEvents.toDraftId, current.id))
      .limit(1);
    if (!currentEdit || currentEdit.editKind === "undo") {
      throw new WorkspaceEditorialEditorError(
        "UNDO_NOT_AVAILABLE",
        "The current Draft is not a direct manual edit that can be undone."
      );
    }

    const parent = await draftById(tx, input.workItemId, current.parentDraftId);
    if (!parent || parent.sourceSnapshotId !== current.sourceSnapshotId) {
      throw new WorkspaceEditorialEditorError(
        "UNDO_NOT_AVAILABLE",
        "Parent Draft cannot be restored safely."
      );
    }
    const parentDocument = await loadDraftDocument(tx, parent.id);
    const persisted = await persistManualDraft(tx, {
      workItemId: input.workItemId,
      sourceSnapshotId: current.sourceSnapshotId,
      parentDraftId: current.id,
      version: current.version + 1,
      actorUserId: input.actorUserId,
      transformCode: "manual_undo",
      beforeSha256: current.draftSha256,
      document: parentDocument,
      presentationJson: current.presentationJson,
      details: {
        editorVersion: "workspace-editor-v1",
        undoFromDraftId: current.id,
        restoredDraftId: parent.id,
        restoredDraftSha256: parent.draftSha256,
        idempotencyKey: input.idempotencyKey,
      },
    });

    const previousEdit = currentEdit;
    const eventId = insertId(
      await tx.insert(workspaceEditorialDraftEditEvents).values({
        workItemId: input.workItemId,
        fromDraftId: current.id,
        toDraftId: persisted.draftId,
        editKind: "undo",
        paragraphKey: previousEdit?.paragraphKey ?? null,
        findingKey: previousEdit?.findingKey ?? null,
        startOffset: previousEdit?.startOffset ?? null,
        endOffset: previousEdit?.endOffset ?? null,
        expectedTextSha256: current.draftSha256,
        replacementTextSha256: parent.draftSha256,
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
      })
    );

    await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: persisted.draftId,
      targetColumnKey: "editing",
      actorUserId: input.actorUserId,
      reason: "workspace_editor_undo",
      idempotencyKey: `editor-undo-${eventId}`,
    });

    return {
      draft: await draftById(tx, input.workItemId, persisted.draftId),
      editEvent: (
        await tx
          .select()
          .from(workspaceEditorialDraftEditEvents)
          .where(eq(workspaceEditorialDraftEditEvents.id, eventId))
          .limit(1)
      )[0],
      replayed: false,
      isCurrent: true,
    };
  });
}
