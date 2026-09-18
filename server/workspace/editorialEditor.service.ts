import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import {
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
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import {
  editorialDraftSha256,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";
import {
  applyEditorialDraftEdit,
  editorialEditIdempotencyPayloadSha256,
  EditorialEditorDomainError,
  type EditorialDraftEditCommand,
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
  workItemId: number
) {
  await requireWorkspacePlatformAdmin(db, actorUserId);
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
    transformCode: "manual_edit" | "manual_undo";
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
    command: EditorialDraftEditCommand;
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

  return {
    latestDraft: draft,
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
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  if (Boolean(input.findingKey) !== Boolean(input.findingId)) {
    throw new WorkspaceEditorialEditorError(
      "FINDING_CONFLICT",
      "Finding id and finding key must be supplied together."
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
    if (input.findingId) {
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
      edited = applyEditorialDraftEdit(document, input.command);
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
        paragraphKey: input.command.paragraphKey,
        findingKey,
        startOffset:
          input.command.kind === "replace_paragraph"
            ? null
            : (input.command.startOffset ?? null),
        endOffset:
          input.command.kind === "replace_paragraph"
            ? null
            : (input.command.endOffset ?? null),
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
