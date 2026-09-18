import { and, asc, desc, eq } from "drizzle-orm";
import {
  episodes,
  workspaceEditorialCheckerAllowWords,
  workspaceEditorialCheckerFindings,
  workspaceEditorialCheckerFindingStates,
  workspaceEditorialCheckerRuns,
  workspaceEditorialDraftApprovals,
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  buildEditorialEpisodeDraftPlan,
  editorialApprovalPayloadSha256,
  EditorialApprovalDomainError,
  editorialEpisodeStagePayloadSha256,
  editorialEpisodeStateSha256,
  editorialQcEvidenceSha256,
  type EditorialEpisodeDraftPlan,
} from "./editorialApproval.domain";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import { editorialAllowListSha256 } from "./editorialForeignChecker.domain";
import { projectEditorialQcColumn } from "./editorialQcProjection.service";

export class WorkspaceEditorialApprovalError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORK_ITEM_NOT_FOUND"
      | "DRAFT_NOT_FOUND"
      | "DRAFT_CONFLICT"
      | "CHECKER_REQUIRED"
      | "CHECKER_STALE"
      | "QC_UNRESOLVED"
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_CONFLICT"
      | "STAGE_INVALID"
      | "EPISODE_CONFLICT"
      | "EPISODE_PUBLISHED"
      | "KANBAN_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialApprovalError";
  }
}

function insertId(result: any) {
  const id = Number(result?.[0]?.insertId ?? result?.insertId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new WorkspaceEditorialApprovalError(
      "DATABASE_UNAVAILABLE",
      "Editorial approval/staging record was not persisted."
    );
  }
  return id;
}

function affectedRows(result: any) {
  return Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0);
}

function isDuplicateKey(error: unknown) {
  const value = error as any;
  return (
    value?.code === "ER_DUP_ENTRY" ||
    value?.errno === 1062 ||
    value?.cause?.code === "ER_DUP_ENTRY" ||
    value?.cause?.errno === 1062
  );
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialApprovalError(
      "DATABASE_UNAVAILABLE",
      "Workspace editorial approval database is unavailable."
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
      workspaceNovel: workspaceNovels,
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
    .innerJoin(
      workspaceNovels,
      eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id)
    )
    .where(
      and(
        eq(workspaceEditorialWorkItems.id, workItemId),
        eq(workspaceKanbanBoards.workspaceId, workspaceId),
        eq(workspaceKanbanBoards.slug, EDITORIAL_BOARD_SLUG),
        eq(workspaceKanbanBoards.status, "active"),
        eq(workspaceNovels.workspaceId, workspaceId),
        eq(workspaceNovels.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialApprovalError(
      "WORK_ITEM_NOT_FOUND",
      "Editorial work item was not found in this active Workspace."
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

async function loadDraftTabs(db: any, draftId: number) {
  const tabs = await db
    .select()
    .from(workspaceEditorialDraftTabs)
    .where(eq(workspaceEditorialDraftTabs.draftId, draftId))
    .orderBy(asc(workspaceEditorialDraftTabs.tabOrder));
  const result = [];
  for (const tab of tabs) {
    const paragraphs = await db
      .select({
        paragraphOrder: workspaceEditorialDraftParagraphs.paragraphOrder,
        text: workspaceEditorialDraftParagraphs.text,
      })
      .from(workspaceEditorialDraftParagraphs)
      .where(eq(workspaceEditorialDraftParagraphs.draftTabId, tab.id))
      .orderBy(asc(workspaceEditorialDraftParagraphs.paragraphOrder));
    result.push({
      sourceTabId: tab.sourceTabId,
      tabOrder: tab.tabOrder,
      title: tab.title,
      chapterNumber: tab.chapterNumber,
      chapterTitle: tab.chapterTitle,
      paragraphs,
    });
  }
  return result;
}

async function currentQcEvidence(
  db: any,
  workspaceId: number,
  workItemId: number,
  draftId: number
) {
  const [run] = await db
    .select()
    .from(workspaceEditorialCheckerRuns)
    .where(eq(workspaceEditorialCheckerRuns.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialCheckerRuns.createdAt),
      desc(workspaceEditorialCheckerRuns.id)
    )
    .limit(1);
  if (!run) {
    return {
      ready: false as const,
      reason: "CHECKER_REQUIRED" as const,
      run: null,
      qcEvidenceSha256: null,
      unresolvedCount: null,
      findings: [],
    };
  }
  if (run.draftId !== draftId) {
    return {
      ready: false as const,
      reason: "CHECKER_STALE" as const,
      run,
      qcEvidenceSha256: null,
      unresolvedCount: null,
      findings: [],
    };
  }

  const [allowRows, findings, states] = await Promise.all([
    db
      .select()
      .from(workspaceEditorialCheckerAllowWords)
      .where(
        and(
          eq(workspaceEditorialCheckerAllowWords.workspaceId, workspaceId),
          eq(workspaceEditorialCheckerAllowWords.status, "active")
        )
      )
      .orderBy(asc(workspaceEditorialCheckerAllowWords.normalizedWord)),
    db
      .select()
      .from(workspaceEditorialCheckerFindings)
      .where(eq(workspaceEditorialCheckerFindings.runId, run.id))
      .orderBy(
        asc(workspaceEditorialCheckerFindings.sourceTabId),
        asc(workspaceEditorialCheckerFindings.paragraphOrder),
        asc(workspaceEditorialCheckerFindings.startOffset),
        asc(workspaceEditorialCheckerFindings.id)
      ),
    db
      .select()
      .from(workspaceEditorialCheckerFindingStates)
      .where(eq(workspaceEditorialCheckerFindingStates.workItemId, workItemId)),
  ]);
  const activeAllow = new Set(allowRows.map((row: any) => row.normalizedWord));
  const currentAllowListSha256 = editorialAllowListSha256(
    allowRows.map((row: any) => row.normalizedWord)
  );
  if (currentAllowListSha256 !== run.allowListSha256) {
    return {
      ready: false as const,
      reason: "CHECKER_STALE" as const,
      run,
      qcEvidenceSha256: null,
      unresolvedCount: null,
      findings: [],
    };
  }

  const stateByKey = new Map(
    states.map((state: any) => [state.findingKey, state])
  );
  const projected = findings.map((finding: any) => {
    const state: any = stateByKey.get(finding.findingKey);
    const disposition =
      state?.disposition === "accepted" &&
      !activeAllow.has(finding.normalizedToken)
        ? "open"
        : (state?.disposition ?? "open");
    return {
      findingKey: finding.findingKey,
      disposition,
      resolutionVersion: Number(state?.version ?? 0),
    };
  });
  const unresolvedCount = projected.filter(
    (finding: any) => finding.disposition === "open"
  ).length;
  const qcEvidenceSha256 = editorialQcEvidenceSha256({
    runId: run.id,
    draftId,
    engineVersion: run.engineVersion,
    allowListSha256: currentAllowListSha256,
    findings: projected,
  });
  return {
    ready: unresolvedCount === 0,
    reason: unresolvedCount === 0 ? null : ("QC_UNRESOLVED" as const),
    run,
    qcEvidenceSha256,
    unresolvedCount,
    findings: projected,
  };
}

function stagePlanSummary(plan: EditorialEpisodeDraftPlan | null) {
  if (!plan) return null;
  return {
    episodeNumber: plan.episodeNumber,
    title: plan.title,
    contentFormat: plan.contentFormat,
    wordCount: plan.wordCount,
    sourceTabId: plan.sourceTabId,
    sourceTabTitle: plan.sourceTabTitle,
    sourceTitleLine: plan.sourceTitleLine,
    contentSha256: plan.contentSha256,
  };
}

async function latestApproval(db: any, workItemId: number) {
  const [approval] = await db
    .select()
    .from(workspaceEditorialDraftApprovals)
    .where(eq(workspaceEditorialDraftApprovals.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialDraftApprovals.createdAt),
      desc(workspaceEditorialDraftApprovals.id)
    )
    .limit(1);
  return approval ?? null;
}

async function latestStage(db: any, workItemId: number) {
  const [stage] = await db
    .select()
    .from(workspaceEditorialEpisodeStages)
    .where(eq(workspaceEditorialEpisodeStages.workItemId, workItemId))
    .orderBy(
      desc(workspaceEditorialEpisodeStages.createdAt),
      desc(workspaceEditorialEpisodeStages.id)
    )
    .limit(1);
  return stage ?? null;
}

function currentApprovalStatus(input: {
  approval: any;
  draft: any;
  qc: Awaited<ReturnType<typeof currentQcEvidence>>;
}) {
  if (!input.approval) {
    return { valid: false, reason: "APPROVAL_REQUIRED" as const };
  }
  if (
    !input.draft ||
    input.approval.draftId !== input.draft.id ||
    input.approval.draftVersion !== input.draft.version ||
    input.approval.approvedDraftSha256 !== input.draft.draftSha256
  ) {
    return { valid: false, reason: "DRAFT_CHANGED" as const };
  }
  if (
    !input.qc.ready ||
    !input.qc.run ||
    input.approval.checkerRunId !== input.qc.run.id ||
    input.approval.qcEvidenceSha256 !== input.qc.qcEvidenceSha256
  ) {
    return { valid: false, reason: "QC_CHANGED" as const };
  }
  return { valid: true, reason: null };
}

async function episodeForStage(db: any, stage: any) {
  if (!stage) return null;
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, stage.episodeId))
    .limit(1);
  return episode ?? null;
}

function currentStageStatus(input: {
  stage: any;
  approvalStatus: ReturnType<typeof currentApprovalStatus>;
  approval: any;
  episode: any;
}) {
  if (!input.stage) {
    return { valid: false, reason: "STAGE_REQUIRED" as const };
  }
  if (
    !input.approvalStatus.valid ||
    !input.approval ||
    input.stage.approvalId !== input.approval.id
  ) {
    return { valid: false, reason: "APPROVAL_CHANGED" as const };
  }
  if (!input.episode) {
    return { valid: false, reason: "EPISODE_MISSING" as const };
  }
  if (input.episode.isPublished) {
    return { valid: false, reason: "EPISODE_PUBLISHED" as const };
  }
  const currentState = editorialEpisodeStateSha256({
    novelId: input.episode.novelId,
    episodeNumber: input.episode.episodeNumber,
    title: input.episode.title,
    content: input.episode.content,
    contentFormat: input.episode.contentFormat,
    wordCount: input.episode.wordCount,
    isPublished: input.episode.isPublished,
  });
  if (currentState !== input.stage.episodeStateSha256) {
    return { valid: false, reason: "EPISODE_DRIFTED" as const };
  }
  return { valid: true, reason: null };
}

export async function getEditorialApprovalReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
}) {
  const db = await database();
  const context = await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );
  const draft = await latestDraft(db, input.workItemId);
  if (!draft) {
    return {
      latestDraft: null,
      qc: {
        ready: false,
        reason: "CHECKER_REQUIRED" as const,
        checkerRunId: null,
        qcEvidenceSha256: null,
        unresolvedCount: null,
      },
      approval: null,
      approvalStatus: { valid: false, reason: "APPROVAL_REQUIRED" as const },
      stage: null,
      stageStatus: { valid: false, reason: "STAGE_REQUIRED" as const },
      stagePlan: null,
      stagePlanError: "Import a Draft before approval/staging.",
      readyToPublish: false,
    };
  }

  const qc = await currentQcEvidence(
    db,
    input.workspaceId,
    input.workItemId,
    draft.id
  );
  const approval = await latestApproval(db, input.workItemId);
  const approvalStatus = currentApprovalStatus({ approval, draft, qc });
  const stage = await latestStage(db, input.workItemId);
  const episode = await episodeForStage(db, stage);
  const stageStatus = currentStageStatus({
    stage,
    approvalStatus,
    approval,
    episode,
  });

  let plan: EditorialEpisodeDraftPlan | null = null;
  let stagePlanError: string | null = null;
  try {
    const tabs = await loadDraftTabs(db, draft.id);
    plan = buildEditorialEpisodeDraftPlan({
      workItemType: context.workItem.workItemType,
      episodeNumber: context.workItem.episodeNumber,
      episodeTitle: context.workItem.episodeTitle,
      tabs,
    });
  } catch (error) {
    stagePlanError =
      error instanceof EditorialApprovalDomainError
        ? error.message
        : "Episode staging plan could not be derived.";
  }

  return {
    latestDraft: draft,
    qc: {
      ready: qc.ready,
      reason: qc.reason,
      checkerRunId: qc.run?.id ?? null,
      qcEvidenceSha256: qc.qcEvidenceSha256,
      unresolvedCount: qc.unresolvedCount,
    },
    approval,
    approvalStatus,
    stage,
    stageEpisode: episode
      ? {
          id: episode.id,
          novelId: episode.novelId,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          contentFormat: episode.contentFormat,
          wordCount: episode.wordCount,
          isPublished: episode.isPublished,
          publishedAt: episode.publishedAt,
        }
      : null,
    stageStatus,
    stagePlan: stagePlanSummary(plan),
    stagePlanError,
    readyToPublish: Boolean(stageStatus.valid),
  };
}

export async function approveEditorialDraft(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedDraftId: number;
  expectedDraftVersion: number;
  expectedDraftSha256: string;
  expectedCheckerRunId: number;
  expectedQcEvidenceSha256: string;
  idempotencyKey: string;
}) {
  const db = await database();
  await requireWorkItem(
    db,
    input.actorUserId,
    input.workspaceId,
    input.workItemId
  );

  const result = await db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new WorkspaceEditorialApprovalError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was removed before approval."
      );
    }

    const draft = await latestDraft(tx, input.workItemId);
    if (!draft) {
      throw new WorkspaceEditorialApprovalError(
        "DRAFT_NOT_FOUND",
        "Import a Draft before approval."
      );
    }
    if (
      draft.id !== input.expectedDraftId ||
      draft.version !== input.expectedDraftVersion ||
      draft.draftSha256 !== input.expectedDraftSha256.toLowerCase()
    ) {
      throw new WorkspaceEditorialApprovalError(
        "DRAFT_CONFLICT",
        "Draft changed before approval."
      );
    }

    const qc = await currentQcEvidence(
      tx,
      input.workspaceId,
      input.workItemId,
      draft.id
    );
    if (!qc.run) {
      throw new WorkspaceEditorialApprovalError(
        "CHECKER_REQUIRED",
        "Run the deterministic checker before approval."
      );
    }
    if (
      qc.reason === "CHECKER_STALE" ||
      qc.run.id !== input.expectedCheckerRunId ||
      qc.qcEvidenceSha256 !== input.expectedQcEvidenceSha256.toLowerCase()
    ) {
      throw new WorkspaceEditorialApprovalError(
        "CHECKER_STALE",
        "Checker/QC evidence changed before approval. Recheck the current Draft."
      );
    }
    if (!qc.ready || qc.unresolvedCount !== 0 || !qc.qcEvidenceSha256) {
      throw new WorkspaceEditorialApprovalError(
        "QC_UNRESOLVED",
        "All deterministic checker findings must be resolved before approval."
      );
    }

    const payloadSha256 = editorialApprovalPayloadSha256({
      workItemId: input.workItemId,
      draftId: draft.id,
      draftVersion: draft.version,
      draftSha256: draft.draftSha256,
      checkerRunId: qc.run.id,
      qcEvidenceSha256: qc.qcEvidenceSha256,
    });

    const [replay] = await tx
      .select()
      .from(workspaceEditorialDraftApprovals)
      .where(
        and(
          eq(workspaceEditorialDraftApprovals.workItemId, input.workItemId),
          eq(
            workspaceEditorialDraftApprovals.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    if (replay) {
      if (
        replay.payloadSha256 !== payloadSha256 ||
        replay.approvedByUserId !== input.actorUserId
      ) {
        throw new WorkspaceEditorialApprovalError(
          "APPROVAL_CONFLICT",
          "Approval idempotency key was reused with another payload."
        );
      }
      return { approval: replay, replayed: true };
    }

    const approvalId = insertId(
      await tx.insert(workspaceEditorialDraftApprovals).values({
        workItemId: input.workItemId,
        draftId: draft.id,
        draftVersion: draft.version,
        approvedDraftSha256: draft.draftSha256,
        checkerRunId: qc.run.id,
        qcEvidenceSha256: qc.qcEvidenceSha256,
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        approvedByUserId: input.actorUserId,
      })
    );
    const [approval] = await tx
      .select()
      .from(workspaceEditorialDraftApprovals)
      .where(eq(workspaceEditorialDraftApprovals.id, approvalId))
      .limit(1);
    return { approval, replayed: false };
  });

  return {
    ...result,
    readModel: await getEditorialApprovalReadModel(input),
  };
}

export async function stageEditorialEpisodeDraft(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  approvalId: number;
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

  const result = await db.transaction(async (tx: any) => {
    const [locked] = await tx
      .select({ id: workspaceEditorialWorkItems.id })
      .from(workspaceEditorialWorkItems)
      .where(eq(workspaceEditorialWorkItems.id, input.workItemId))
      .for("update")
      .limit(1);
    if (!locked) {
      throw new WorkspaceEditorialApprovalError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item was removed before Episode staging."
      );
    }

    const context = await requireWorkItem(
      tx,
      input.actorUserId,
      input.workspaceId,
      input.workItemId
    );
    const draft = await latestDraft(tx, input.workItemId);
    if (!draft) {
      throw new WorkspaceEditorialApprovalError(
        "DRAFT_NOT_FOUND",
        "Import a Draft before Episode staging."
      );
    }
    if (
      draft.id !== input.expectedDraftId ||
      draft.version !== input.expectedDraftVersion ||
      draft.draftSha256 !== input.expectedDraftSha256.toLowerCase()
    ) {
      throw new WorkspaceEditorialApprovalError(
        "DRAFT_CONFLICT",
        "Draft changed before Episode staging."
      );
    }

    const [approval] = await tx
      .select()
      .from(workspaceEditorialDraftApprovals)
      .where(
        and(
          eq(workspaceEditorialDraftApprovals.id, input.approvalId),
          eq(workspaceEditorialDraftApprovals.workItemId, input.workItemId)
        )
      )
      .limit(1);
    if (!approval) {
      throw new WorkspaceEditorialApprovalError(
        "APPROVAL_NOT_FOUND",
        "Draft approval was not found in this work item."
      );
    }

    const qc = await currentQcEvidence(
      tx,
      input.workspaceId,
      input.workItemId,
      draft.id
    );
    const approvalStatus = currentApprovalStatus({ approval, draft, qc });
    if (!approvalStatus.valid || !qc.qcEvidenceSha256) {
      throw new WorkspaceEditorialApprovalError(
        "APPROVAL_CONFLICT",
        "Approval no longer matches the current Draft/QC evidence."
      );
    }

    const tabs = await loadDraftTabs(tx, draft.id);
    let plan: EditorialEpisodeDraftPlan;
    try {
      plan = buildEditorialEpisodeDraftPlan({
        workItemType: context.workItem.workItemType,
        episodeNumber: context.workItem.episodeNumber,
        episodeTitle: context.workItem.episodeTitle,
        tabs,
      });
    } catch (error) {
      if (error instanceof EditorialApprovalDomainError) {
        throw new WorkspaceEditorialApprovalError(
          "STAGE_INVALID",
          error.message
        );
      }
      throw error;
    }

    const novelId = context.workspaceNovel.novelId;
    const payloadSha256 = editorialEpisodeStagePayloadSha256({
      workItemId: input.workItemId,
      approvalId: approval.id,
      draftId: draft.id,
      draftSha256: draft.draftSha256,
      qcEvidenceSha256: qc.qcEvidenceSha256,
      novelId,
      plan,
    });

    const [replayByKey] = await tx
      .select()
      .from(workspaceEditorialEpisodeStages)
      .where(
        and(
          eq(workspaceEditorialEpisodeStages.workItemId, input.workItemId),
          eq(
            workspaceEditorialEpisodeStages.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1);
    const replayStage = async (stage: any) => {
      const [episode] = await tx
        .select()
        .from(episodes)
        .where(eq(episodes.id, stage.episodeId))
        .limit(1)
        .for("update");
      if (!episode) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "Previously staged Episode no longer exists."
        );
      }
      const currentState = editorialEpisodeStateSha256({
        novelId: episode.novelId,
        episodeNumber: episode.episodeNumber,
        title: episode.title,
        content: episode.content,
        contentFormat: episode.contentFormat,
        wordCount: episode.wordCount,
        isPublished: episode.isPublished,
      });
      if (currentState !== stage.episodeStateSha256) {
        throw new WorkspaceEditorialApprovalError(
          episode.isPublished ? "EPISODE_PUBLISHED" : "EPISODE_CONFLICT",
          episode.isPublished
            ? "Episode is already published."
            : "Previously staged Episode changed outside this Workspace stage."
        );
      }
      const projection = await projectEditorialQcColumn(tx, {
        workItemId: input.workItemId,
        expectedDraftId: draft.id,
        targetColumnKey: "ready_to_publish",
        actorUserId: input.actorUserId,
        reason: "editorial_episode_stage_reconciled",
        idempotencyKey: `editorial-stage-${stage.id}-ready`,
      });
      if ((projection as any).reason) {
        throw new WorkspaceEditorialApprovalError(
          "KANBAN_CONFLICT",
          "Episode stage is valid but the ready-to-publish Kanban projection could not be reconciled."
        );
      }
      return { stage, episode, replayed: true };
    };

    if (replayByKey) {
      if (
        replayByKey.payloadSha256 !== payloadSha256 ||
        replayByKey.stagedByUserId !== input.actorUserId
      ) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "Episode staging idempotency key was reused with another payload."
        );
      }
      return replayStage(replayByKey);
    }

    const [stageForApproval] = await tx
      .select()
      .from(workspaceEditorialEpisodeStages)
      .where(eq(workspaceEditorialEpisodeStages.approvalId, approval.id))
      .limit(1);
    if (stageForApproval) {
      if (stageForApproval.payloadSha256 !== payloadSha256) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "This approval was already staged with different Episode metadata."
        );
      }
      return replayStage(stageForApproval);
    }

    const [existingEpisode] = await tx
      .select()
      .from(episodes)
      .where(
        and(
          eq(episodes.novelId, novelId),
          eq(episodes.episodeNumber, plan.episodeNumber)
        )
      )
      .limit(1)
      .for("update");

    let episodeId: number;
    if (!existingEpisode) {
      try {
        episodeId = insertId(
          await tx.insert(episodes).values({
            novelId,
            episodeNumber: plan.episodeNumber,
            title: plan.title,
            content: plan.content,
            contentFormat: plan.contentFormat,
            saleMode: "chapter",
            isPublished: false,
            publishedAt: null,
            wordCount: plan.wordCount,
          })
        );
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new WorkspaceEditorialApprovalError(
            "EPISODE_CONFLICT",
            "Another Episode with this novel/episode number was staged concurrently."
          );
        }
        throw error;
      }
    } else {
      if (existingEpisode.isPublished) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_PUBLISHED",
          "A published Episode already uses this novel/episode number."
        );
      }
      const [previousStage] = await tx
        .select()
        .from(workspaceEditorialEpisodeStages)
        .where(
          and(
            eq(workspaceEditorialEpisodeStages.workItemId, input.workItemId),
            eq(workspaceEditorialEpisodeStages.episodeId, existingEpisode.id)
          )
        )
        .orderBy(
          desc(workspaceEditorialEpisodeStages.createdAt),
          desc(workspaceEditorialEpisodeStages.id)
        )
        .limit(1);
      if (!previousStage) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "An unpublished Episode already uses this episode number but is not owned by this editorial work item."
        );
      }
      const existingState = editorialEpisodeStateSha256({
        novelId: existingEpisode.novelId,
        episodeNumber: existingEpisode.episodeNumber,
        title: existingEpisode.title,
        content: existingEpisode.content,
        contentFormat: existingEpisode.contentFormat,
        wordCount: existingEpisode.wordCount,
        isPublished: existingEpisode.isPublished,
      });
      if (existingState !== previousStage.episodeStateSha256) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "Unpublished Episode changed after the previous Workspace stage; refusing to overwrite it."
        );
      }
      const update = await tx
        .update(episodes)
        .set({
          title: plan.title,
          content: plan.content,
          contentFormat: plan.contentFormat,
          wordCount: plan.wordCount,
          isPublished: false,
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(episodes.id, existingEpisode.id),
            eq(episodes.novelId, novelId),
            eq(episodes.isPublished, false)
          )
        );
      if (affectedRows(update) !== 1) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          "Episode changed concurrently during staging."
        );
      }
      episodeId = existingEpisode.id;
    }

    const [episode] = await tx
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);
    if (!episode || episode.novelId !== novelId || episode.isPublished) {
      throw new WorkspaceEditorialApprovalError(
        "EPISODE_CONFLICT",
        "Staged Episode could not be verified as unpublished."
      );
    }
    const episodeStateSha256 = editorialEpisodeStateSha256({
      novelId: episode.novelId,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      content: episode.content,
      contentFormat: episode.contentFormat,
      wordCount: episode.wordCount,
      isPublished: episode.isPublished,
    });

    const stageId = insertId(
      await tx.insert(workspaceEditorialEpisodeStages).values({
        workItemId: input.workItemId,
        approvalId: approval.id,
        draftId: draft.id,
        stagedDraftSha256: draft.draftSha256,
        qcEvidenceSha256: qc.qcEvidenceSha256,
        episodeId,
        novelId,
        episodeNumber: plan.episodeNumber,
        episodeTitle: plan.title,
        contentSha256: plan.contentSha256,
        episodeStateSha256,
        payloadSha256,
        idempotencyKey: input.idempotencyKey,
        stagedByUserId: input.actorUserId,
      })
    );
    const [stage] = await tx
      .select()
      .from(workspaceEditorialEpisodeStages)
      .where(eq(workspaceEditorialEpisodeStages.id, stageId))
      .limit(1);

    const projection = await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: draft.id,
      targetColumnKey: "ready_to_publish",
      actorUserId: input.actorUserId,
      reason: "editorial_episode_staged_from_approved_draft",
      idempotencyKey: `editorial-stage-${stageId}-ready`,
    });
    if ((projection as any).reason) {
      throw new WorkspaceEditorialApprovalError(
        "KANBAN_CONFLICT",
        "Episode was staged but the ready-to-publish Kanban projection could not be validated."
      );
    }

    return { stage, episode, replayed: false };
  });

  return {
    ...result,
    readModel: await getEditorialApprovalReadModel(input),
  };
}
