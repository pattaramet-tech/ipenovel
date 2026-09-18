import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  workspaceEditorialCheckerAllowWords,
  workspaceEditorialCheckerFindings,
  workspaceEditorialCheckerFindingStates,
  workspaceEditorialCheckerResolutionEvents,
  workspaceEditorialCheckerRuns,
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import { projectEditorialQcColumn } from "./editorialQcProjection.service";
import {
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
  EDITORIAL_FOREIGN_CHECKER_RULES,
  editorialAllowListSha256,
  evaluateEditorialForeignDraft,
  normalizeEditorialAllowedWord,
  type EditorialCheckerParagraphInput,
} from "./editorialForeignChecker.domain";

export class WorkspaceEditorialForeignCheckerError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORK_ITEM_NOT_FOUND"
      | "DRAFT_NOT_FOUND"
      | "DRAFT_CONFLICT"
      | "FINDING_NOT_FOUND"
      | "FINDING_CONFLICT"
      | "ALLOW_WORD_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialForeignCheckerError";
  }
}

type FindingDisposition = "open" | "accepted" | "fixed" | "ignored";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function insertId(result: any) {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new WorkspaceEditorialForeignCheckerError(
      "DATABASE_UNAVAILABLE",
      "Editorial checker record was not persisted."
    );
  }
  return id;
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialForeignCheckerError(
      "DATABASE_UNAVAILABLE",
      "Workspace editorial checker database is unavailable."
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
    throw new WorkspaceEditorialForeignCheckerError(
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

async function loadDraftParagraphs(db: any, draftId: number) {
  const rows = await db
    .select({
      tab: workspaceEditorialDraftTabs,
      paragraph: workspaceEditorialDraftParagraphs,
    })
    .from(workspaceEditorialDraftParagraphs)
    .innerJoin(
      workspaceEditorialDraftTabs,
      eq(
        workspaceEditorialDraftParagraphs.draftTabId,
        workspaceEditorialDraftTabs.id
      )
    )
    .where(eq(workspaceEditorialDraftTabs.draftId, draftId))
    .orderBy(
      asc(workspaceEditorialDraftTabs.tabOrder),
      asc(workspaceEditorialDraftParagraphs.paragraphOrder)
    );
  return rows.map(
    (row: any) =>
      ({
        sourceTabId: row.tab.sourceTabId,
        tabTitle: row.tab.title,
        paragraphKey: row.paragraph.paragraphKey,
        paragraphOrder: row.paragraph.paragraphOrder,
        paragraphFingerprint: row.paragraph.paragraphFingerprint,
        text: row.paragraph.text,
      }) satisfies EditorialCheckerParagraphInput
  );
}

async function loadAllowWords(db: any, workspaceId: number) {
  const rows = await db
    .select()
    .from(workspaceEditorialCheckerAllowWords)
    .where(
      and(
        eq(workspaceEditorialCheckerAllowWords.workspaceId, workspaceId),
        eq(workspaceEditorialCheckerAllowWords.status, "active")
      )
    )
    .orderBy(asc(workspaceEditorialCheckerAllowWords.normalizedWord));
  return rows;
}

async function latestRun(db: any, workItemId: number) {
  const [run] = await db
    .select()
    .from(workspaceEditorialCheckerRuns)
    .where(eq(workspaceEditorialCheckerRuns.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialCheckerRuns.createdAt),
      desc(workspaceEditorialCheckerRuns.id)
    )
    .limit(1);
  return run ?? null;
}

async function findingInWorkItem(
  db: any,
  workItemId: number,
  findingId: number
) {
  const [row] = await db
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
        eq(workspaceEditorialCheckerFindings.id, findingId),
        eq(workspaceEditorialCheckerRuns.workItemId, workItemId)
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialForeignCheckerError(
      "FINDING_NOT_FOUND",
      "Editorial checker finding was not found in this work item."
    );
  }
  return row;
}

async function currentFindingState(
  db: any,
  workItemId: number,
  findingKey: string
) {
  const [state] = await db
    .select()
    .from(workspaceEditorialCheckerFindingStates)
    .where(
      and(
        eq(workspaceEditorialCheckerFindingStates.workItemId, workItemId),
        eq(workspaceEditorialCheckerFindingStates.findingKey, findingKey)
      )
    )
    .limit(1);
  return state ?? null;
}

async function persistFindingState(
  tx: any,
  input: {
    actorUserId: number;
    workItemId: number;
    findingKey: string;
    disposition: FindingDisposition;
    note: string;
    expectedVersion: number;
    idempotencyKey: string;
  }
) {
  const [replay] = await tx
    .select()
    .from(workspaceEditorialCheckerResolutionEvents)
    .where(
      and(
        eq(
          workspaceEditorialCheckerResolutionEvents.workItemId,
          input.workItemId
        ),
        eq(
          workspaceEditorialCheckerResolutionEvents.idempotencyKey,
          input.idempotencyKey
        )
      )
    )
    .limit(1);

  if (replay) {
    if (
      replay.findingKey !== input.findingKey ||
      replay.toDisposition !== input.disposition ||
      replay.note !== input.note ||
      replay.actorUserId !== input.actorUserId
    ) {
      throw new WorkspaceEditorialForeignCheckerError(
        "FINDING_CONFLICT",
        "Finding resolution idempotency key was reused with another payload."
      );
    }
    return {
      state: await currentFindingState(tx, input.workItemId, input.findingKey),
      replayed: true,
    };
  }

  const state = await currentFindingState(
    tx,
    input.workItemId,
    input.findingKey
  );
  const currentVersion = state?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    throw new WorkspaceEditorialForeignCheckerError(
      "FINDING_CONFLICT",
      "Finding resolution version conflict."
    );
  }

  if (!state) {
    await tx.insert(workspaceEditorialCheckerFindingStates).values({
      workItemId: input.workItemId,
      findingKey: input.findingKey,
      disposition: input.disposition,
      note: input.note,
      actorUserId: input.actorUserId,
      version: 1,
    });
  } else {
    const result = await tx
      .update(workspaceEditorialCheckerFindingStates)
      .set({
        disposition: input.disposition,
        note: input.note,
        actorUserId: input.actorUserId,
        version: sql`${workspaceEditorialCheckerFindingStates.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceEditorialCheckerFindingStates.id, state.id),
          eq(
            workspaceEditorialCheckerFindingStates.version,
            input.expectedVersion
          )
        )
      );
    const affected = Number(
      (result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0
    );
    if (affected !== 1) {
      throw new WorkspaceEditorialForeignCheckerError(
        "FINDING_CONFLICT",
        "Finding resolution changed concurrently."
      );
    }
  }

  await tx.insert(workspaceEditorialCheckerResolutionEvents).values({
    workItemId: input.workItemId,
    findingKey: input.findingKey,
    fromDisposition: state?.disposition ?? "open",
    toDisposition: input.disposition,
    note: input.note,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    state: await currentFindingState(tx, input.workItemId, input.findingKey),
    replayed: false,
  };
}

export async function getEditorialForeignCheckerReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  runId?: number;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const draft = await latestDraft(db, input.workItemId);
  const allowWords = await loadAllowWords(db, input.workspaceId);

  let run: any = null;
  if (input.runId) {
    [run] = await db
      .select()
      .from(workspaceEditorialCheckerRuns)
      .where(
        and(
          eq(workspaceEditorialCheckerRuns.id, input.runId),
          eq(workspaceEditorialCheckerRuns.workItemId, input.workItemId)
        )
      )
      .limit(1);
  } else {
    run = await latestRun(db, input.workItemId);
  }

  if (!run) {
    return {
      engineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
      latestDraft: draft,
      run: null,
      findings: [],
      allowWords,
      unresolvedCount: 0,
      effectiveStatus: null,
    };
  }

  const findings = await db
    .select()
    .from(workspaceEditorialCheckerFindings)
    .where(eq(workspaceEditorialCheckerFindings.runId, run.id))
    .orderBy(
      asc(workspaceEditorialCheckerFindings.sourceTabId),
      asc(workspaceEditorialCheckerFindings.paragraphOrder),
      asc(workspaceEditorialCheckerFindings.startOffset),
      asc(workspaceEditorialCheckerFindings.id)
    );
  const states = await db
    .select()
    .from(workspaceEditorialCheckerFindingStates)
    .where(
      eq(workspaceEditorialCheckerFindingStates.workItemId, input.workItemId)
    );
  const stateByKey = new Map(
    states.map((state: any) => [state.findingKey, state])
  );
  const activeAllowed = new Set(
    allowWords.map((word: any) => word.normalizedWord)
  );
  const projected = findings.map((finding: any) => {
    const state = stateByKey.get(finding.findingKey);
    const disposition =
      state?.disposition === "accepted" &&
      !activeAllowed.has(finding.normalizedToken)
        ? "open"
        : (state?.disposition ?? "open");
    return {
      ...finding,
      disposition,
      resolutionNote: state?.note ?? "",
      resolutionVersion: state?.version ?? 0,
      resolutionActorUserId: state?.actorUserId ?? null,
      resolutionUpdatedAt: state?.updatedAt ?? null,
    };
  });
  const unresolvedCount = projected.filter(
    (finding: any) => finding.disposition === "open"
  ).length;

  return {
    engineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
    latestDraft: draft,
    run,
    findings: projected,
    allowWords,
    unresolvedCount,
    effectiveStatus: unresolvedCount === 0 ? "passed" : "failed",
  };
}

export async function runEditorialForeignChecker(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId?: number;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );

  const result = await db.transaction(async (tx: any) => {
    const [lockedWorkItem] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!lockedWorkItem) {
      throw new WorkspaceEditorialForeignCheckerError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was removed before the checker started."
      );
    }

    const draft = await latestDraft(tx, input.workItemId);
    if (!draft) {
      throw new WorkspaceEditorialForeignCheckerError(
        "DRAFT_NOT_FOUND",
        "Import a source and create a Workspace Draft before checking."
      );
    }
    if (input.expectedDraftId && input.expectedDraftId !== draft.id) {
      throw new WorkspaceEditorialForeignCheckerError(
        "DRAFT_CONFLICT",
        "Workspace Draft changed before the checker started."
      );
    }

    const allowRows = await loadAllowWords(tx, input.workspaceId);
    const allowWords = allowRows.map((row: any) => row.normalizedWord);
    const allowListSha256 = editorialAllowListSha256(allowWords);
    const idempotencyKey = sha256(
      [
        "workspace-editorial-foreign-run-v1",
        String(input.workItemId),
        String(draft.id),
        draft.draftSha256,
        EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
        allowListSha256,
      ].join("\0")
    );

    const [existing] = await tx
      .select()
      .from(workspaceEditorialCheckerRuns)
      .where(eq(workspaceEditorialCheckerRuns.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) {
      return { runId: existing.id, draftId: existing.draftId, created: false };
    }

    const paragraphs = await loadDraftParagraphs(tx, draft.id);
    const evaluated = evaluateEditorialForeignDraft({
      paragraphs,
      allowWords,
    });
    const runId = insertId(
      await tx.insert(workspaceEditorialCheckerRuns).values({
        workItemId: input.workItemId,
        draftId: draft.id,
        engineVersion: EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
        allowListSha256,
        idempotencyKey,
        status: evaluated.status,
        findingCount: evaluated.findings.length,
        createdByUserId: input.actorUserId,
      })
    );

    if (evaluated.findings.length) {
      await tx.insert(workspaceEditorialCheckerFindings).values(
        evaluated.findings.map(finding => ({
          runId,
          findingKey: finding.findingKey,
          ruleKey: finding.ruleKey,
          severity: finding.severity,
          sourceTabId: finding.sourceTabId,
          tabTitle: finding.tabTitle,
          paragraphKey: finding.paragraphKey,
          paragraphOrder: finding.paragraphOrder,
          paragraphFingerprint: finding.paragraphFingerprint,
          offsetEncoding: finding.offsetEncoding,
          startOffset: finding.startOffset,
          endOffset: finding.endOffset,
          token: finding.token,
          normalizedToken: finding.normalizedToken,
          sentenceStartOffset: finding.sentenceStartOffset,
          sentenceEndOffset: finding.sentenceEndOffset,
          sentenceText: finding.sentenceText,
          contextText: finding.contextText,
          message: finding.message,
        }))
      );
    }
    return { runId, draftId: draft.id, created: true };
  });

  const readModel = await getEditorialForeignCheckerReadModel({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workItemId: input.workItemId,
    runId: result.runId,
  });
  const targetColumnKey =
    readModel.unresolvedCount > 0 ? "needs_fix" : "pending_confirm";
  const kanbanProjection = await db.transaction((tx: any) =>
    projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: result.draftId,
      targetColumnKey,
      actorUserId: input.actorUserId,
      reason:
        targetColumnKey === "needs_fix"
          ? "editorial_checker_findings_open"
          : "editorial_checker_clean",
      idempotencyKey: `editorial-qc-${result.runId}-${targetColumnKey}`,
    })
  );

  return {
    created: result.created,
    ...readModel,
    kanbanProjection,
  };
}

export async function setEditorialFindingDisposition(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  findingId: number;
  disposition: "open" | "fixed" | "ignored";
  note?: string;
  expectedVersion: number;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const located = await findingInWorkItem(
    db,
    input.workItemId,
    input.findingId
  );
  const note = input.note?.trim() ?? "";

  return db.transaction(async (tx: any) => {
    await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    const currentDraft = await latestDraft(tx, input.workItemId);
    if (!currentDraft || located.run.draftId !== currentDraft.id) {
      throw new WorkspaceEditorialForeignCheckerError(
        "DRAFT_CONFLICT",
        "This finding belongs to an older Draft. Run the checker against the current Draft before resolving it."
      );
    }
    return persistFindingState(tx, {
      actorUserId: input.actorUserId,
      workItemId: input.workItemId,
      findingKey: located.finding.findingKey,
      disposition: input.disposition,
      note,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function allowEditorialFindingWord(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  findingId: number;
  expectedVersion: number;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const located = await findingInWorkItem(
    db,
    input.workItemId,
    input.findingId
  );
  if (located.finding.ruleKey === EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish) {
    throw new WorkspaceEditorialForeignCheckerError(
      "ALLOW_WORD_INVALID",
      "Long-English findings must be fixed or ignored; they cannot be added as one allowed word."
    );
  }
  const normalizedWord = normalizeEditorialAllowedWord(
    located.finding.normalizedToken || located.finding.token
  );
  if (!normalizedWord || normalizedWord.length > 500) {
    throw new WorkspaceEditorialForeignCheckerError(
      "ALLOW_WORD_INVALID",
      "Finding token cannot be added to the Workspace allowlist."
    );
  }

  return db.transaction(async (tx: any) => {
    await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);

    const currentDraft = await latestDraft(tx, input.workItemId);
    if (!currentDraft || located.run.draftId !== currentDraft.id) {
      throw new WorkspaceEditorialForeignCheckerError(
        "DRAFT_CONFLICT",
        "This finding belongs to an older Draft. Run the checker against the current Draft before allowing it."
      );
    }

    const state = await persistFindingState(tx, {
      actorUserId: input.actorUserId,
      workItemId: input.workItemId,
      findingKey: located.finding.findingKey,
      disposition: "accepted",
      note: "Allowed in Workspace foreign-word checker.",
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    });

    // A replay proves the original transaction already committed both the
    // finding state and allow-word write. Do not resurrect a word that an
    // operator intentionally removed after that commit.
    if (!state.replayed) {
      await tx
        .insert(workspaceEditorialCheckerAllowWords)
        .values({
          workspaceId: input.workspaceId,
          normalizedWord,
          displayWord: located.finding.token.slice(0, 500),
          status: "active",
          createdByUserId: input.actorUserId,
        })
        .onDuplicateKeyUpdate({
          set: {
            displayWord: located.finding.token.slice(0, 500),
            status: "active",
            updatedAt: new Date(),
          },
        });
    }

    return { normalizedWord, ...state };
  });
}

export async function removeEditorialAllowedWord(input: {
  actorUserId: number;
  workspaceId: number;
  normalizedWord: string;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const normalizedWord = normalizeEditorialAllowedWord(input.normalizedWord);
  if (!normalizedWord) {
    throw new WorkspaceEditorialForeignCheckerError(
      "ALLOW_WORD_INVALID",
      "Allowed word is empty."
    );
  }
  await db
    .update(workspaceEditorialCheckerAllowWords)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(workspaceEditorialCheckerAllowWords.workspaceId, input.workspaceId),
        eq(workspaceEditorialCheckerAllowWords.normalizedWord, normalizedWord)
      )
    );
  return { normalizedWord, status: "removed" as const };
}

export async function listEditorialFindingResolutionEvents(input: {
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
  return db
    .select()
    .from(workspaceEditorialCheckerResolutionEvents)
    .where(
      eq(workspaceEditorialCheckerResolutionEvents.workItemId, input.workItemId)
    )
    .orderBy(
      desc(workspaceEditorialCheckerResolutionEvents.createdAt),
      desc(workspaceEditorialCheckerResolutionEvents.id)
    );
}
