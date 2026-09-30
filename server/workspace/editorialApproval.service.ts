import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  episodes,
  workspaceEditorialCheckerAllowWords,
  workspaceEditorialCheckerAnomalies,
  workspaceEditorialCheckerFindings,
  workspaceEditorialCheckerFindingStates,
  workspaceEditorialCheckerRuns,
  workspaceEditorialStructuralConfirmations,
  workspaceEditorialDraftApprovals,
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceKanbanBoards,
  novels,
  workspaceKanbanCards,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { normalizeEpisodeRange } from "../services/readerService";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  analyzeEditorialEpisodeDraftBatch,
  buildEditorialEpisodeDraftPlan,
  buildEditorialEpisodePackPlan,
  defaultEditorialEpisodePackSaleFromRange,
  editorialApprovalPayloadSha256,
  EditorialApprovalDomainError,
  EDITORIAL_EPISODE_STAGE_CONTRACT,
  EDITORIAL_EPISODE_STAGE_CONTRACT_V2,
  EDITORIAL_EPISODE_STAGE_CONTRACT_V3,
  editorialEpisodeReplacementTargetStateSha256,
  editorialEpisodeStagePayloadSha256,
  editorialEpisodeStagePayloadSha256V2,
  editorialEpisodeStagePayloadSha256V3,
  editorialEpisodeStateSha256,
  editorialEpisodeStateSha256V2,
  editorialQcEvidenceSha256,
  type EditorialEpisodeDraftBatchPlan,
  type EditorialEpisodeDraftPlan,
} from "./editorialApproval.domain";
import { EDITORIAL_BOARD_SLUG } from "./editorialBoard.domain";
import {
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
  editorialAllowListSha256,
} from "./editorialForeignChecker.domain";
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

async function lockEpisodeByCanonicalIdentity(
  tx: any,
  novelId: number,
  episodeNumber: string
) {
  const canonicalIdentity = normalizeEpisodeRange(episodeNumber);
  if (!canonicalIdentity) {
    throw new WorkspaceEditorialApprovalError(
      "EPISODE_CONFLICT",
      `Episode ${episodeNumber} does not have a canonical identity.`
    );
  }

  // Serialize Stage identity resolution per novel. The database uniqueness
  // constraint is on the raw episodeNumber string, so formatting variants
  // such as "001-030" and "001 - 030" would otherwise be able to race each
  // other and create two rows that represent the same commercial package.
  const [lockedNovel] = await tx
    .select({ id: novels.id })
    .from(novels)
    .where(eq(novels.id, novelId))
    .limit(1)
    .for("update");
  if (!lockedNovel) {
    throw new WorkspaceEditorialApprovalError(
      "EPISODE_CONFLICT",
      `Novel ${novelId} disappeared before Episode staging.`
    );
  }

  const candidateRows = await tx
    .select()
    .from(episodes)
    .where(eq(episodes.novelId, novelId))
    .orderBy(asc(episodes.id))
    .for("update");
  const canonicalMatches = candidateRows.filter(
    (episode: any) =>
      normalizeEpisodeRange(episode.episodeNumber) === canonicalIdentity
  );

  if (canonicalMatches.length > 1) {
    throw new WorkspaceEditorialApprovalError(
      "EPISODE_CONFLICT",
      `Multiple Episodes already match canonical identity ${canonicalIdentity}; reconcile duplicates before staging.`
    );
  }
  return canonicalMatches[0] ?? null;
}

function stageItemIdempotencyKey(base: string, episodeNumber: string) {
  const digest = createHash("sha256")
    .update(`${base}\n${episodeNumber}`, "utf8")
    .digest("hex");
  return `editorial-stage-item:${digest}`;
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
  if (
    run.draftId !== draftId ||
    run.engineVersion !== EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION
  ) {
    return {
      ready: false as const,
      reason: "CHECKER_STALE" as const,
      run,
      qcEvidenceSha256: null,
      unresolvedCount: null,
      findings: [],
    };
  }

  const [allowRows, findings, states, anomalies, confirmations] = await Promise.all([
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
    db
      .select()
      .from(workspaceEditorialCheckerAnomalies)
      .where(eq(workspaceEditorialCheckerAnomalies.runId, run.id))
      .orderBy(
        asc(workspaceEditorialCheckerAnomalies.severity),
        asc(workspaceEditorialCheckerAnomalies.anomalyType),
        asc(workspaceEditorialCheckerAnomalies.id)
      ),
    db
      .select()
      .from(workspaceEditorialStructuralConfirmations)
      .where(
        and(
          eq(workspaceEditorialStructuralConfirmations.workItemId, workItemId),
          eq(workspaceEditorialStructuralConfirmations.draftId, draftId)
        )
      ),
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
  const confirmationByKey = new Map(
    confirmations.map((confirmation: any) => [
      confirmation.anomalyKey,
      confirmation,
    ])
  );
  const projectedAnomalies = anomalies.map((anomaly: any) => {
    const confirmation: any = confirmationByKey.get(anomaly.anomalyKey);
    const disposition =
      anomaly.anomalyType === "source_note_only" &&
      confirmation?.status === "confirmed"
        ? "confirmed_source_note"
        : "open";
    return {
      anomalyKey: anomaly.anomalyKey,
      anomalyType: anomaly.anomalyType,
      severity: anomaly.severity,
      sourceTabId: anomaly.sourceTabId ?? null,
      disposition,
      resolutionVersion: Number(confirmation?.version ?? 0),
    };
  });
  const blockingAnomalyCount = projectedAnomalies.filter(
    (anomaly: any) =>
      anomaly.severity === "error" &&
      anomaly.disposition !== "confirmed_source_note"
  ).length;
  const qcEvidenceSha256 = editorialQcEvidenceSha256({
    runId: run.id,
    draftId,
    engineVersion: run.engineVersion,
    allowListSha256: currentAllowListSha256,
    findings: projected,
    anomalies: projectedAnomalies,
  });
  const ready = unresolvedCount === 0 && blockingAnomalyCount === 0;
  return {
    ready,
    reason: ready ? null : ("QC_UNRESOLVED" as const),
    run,
    qcEvidenceSha256,
    unresolvedCount,
    blockingAnomalyCount,
    anomalies: projectedAnomalies,
    findings: projected,
  };
}

function confirmedSourceNoteTabIds(qc: Awaited<ReturnType<typeof currentQcEvidence>>) {
  return (qc.anomalies ?? [])
    .filter(
      (anomaly: any) =>
        anomaly.anomalyType === "source_note_only" &&
        anomaly.disposition === "confirmed_source_note" &&
        anomaly.sourceTabId
    )
    .map((anomaly: any) => String(anomaly.sourceTabId));
}

function resolveEditorialEpisodePackSale(
  plan: EditorialEpisodeDraftBatchPlan,
  sale?: {
    saleMode: "chapter" | "package" | null;
    price: string | null;
    isFree: boolean | null;
  }
) {
  if (!plan.ready || plan.items.length === 0) return null;
  const pack = buildEditorialEpisodePackPlan(plan);
  const baseDefault = defaultEditorialEpisodePackSaleFromRange(
    plan.requestedEpisodeNumber
  );
  const pending =
    (sale?.saleMode ?? null) === null &&
    (sale?.price ?? null) === null &&
    (sale?.isFree ?? null) === null;
  const matchesBaseDefault =
    sale?.saleMode === baseDefault.saleMode &&
    sale?.price === baseDefault.price &&
    sale?.isFree === baseDefault.isFree;
  if (pending || matchesBaseDefault) {
    return {
      saleMode: pack.saleMode,
      price: pack.price,
      isFree: pack.isFree,
      usesDefault: true,
    } as const;
  }
  if (
    (sale?.saleMode !== "chapter" && sale?.saleMode !== "package") ||
    sale.price === null ||
    typeof sale.isFree !== "boolean"
  ) {
    return null;
  }
  return {
    saleMode: sale.saleMode,
    price: sale.price,
    isFree: sale.isFree,
    usesDefault: false,
  } as const;
}

function stagePlanItemSummary(plan: EditorialEpisodeDraftPlan) {
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

function stagePlanSummary(
  plan: EditorialEpisodeDraftBatchPlan | null,
  sale?: { saleMode: "chapter" | "package" | null; price: string | null; isFree: boolean | null }
) {
  if (!plan) return null;
  const first = plan.items[0] ?? null;
  const pack = plan.ready && plan.items.length > 0
    ? buildEditorialEpisodePackPlan(plan)
    : null;
  const effectiveSale = pack
    ? resolveEditorialEpisodePackSale(plan, sale)
    : null;
  return {
    mode: plan.mode,
    requestedEpisodeNumber: plan.requestedEpisodeNumber,
    itemCount: plan.items.length,
    expectedCount: plan.expectedEpisodeNumbers.length,
    expectedEpisodeNumbers: plan.expectedEpisodeNumbers,
    items: plan.items.map(stagePlanItemSummary),
    excludedTabs: plan.excludedTabs,
    excludedCount: plan.excludedTabs.length,
    draftTabCount: plan.items.length + plan.excludedTabs.length,
    commerce: pack ? {
      saleMode: effectiveSale?.saleMode ?? sale?.saleMode ?? pack.saleMode,
      episodeNumber: pack.episodeNumber,
      title: pack.title,
      billableTabCount: pack.billableTabCount,
      excludedTabCount: pack.excludedTabCount,
      price: effectiveSale?.price ?? sale?.price ?? pack.price,
      isFree: effectiveSale?.isFree ?? sale?.isFree ?? pack.isFree,
    } : null,
    anomalies: plan.anomalies,
    blockers: plan.blockers,
    // Deterministic coverage diagnostics (IPE-058-B): which episodes are
    // missing/duplicated/out-of-range and which tabs are unreadable.
    reconciliation: plan.reconciliation,
    ready: plan.ready,
    ...(first ? stagePlanItemSummary(first) : {}),
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

async function stagesForApproval(
  db: any,
  workItemId: number,
  approvalId: number | null
) {
  if (!approvalId) return [];
  return db
    .select()
    .from(workspaceEditorialEpisodeStages)
    .where(
      and(
        eq(workspaceEditorialEpisodeStages.workItemId, workItemId),
        eq(workspaceEditorialEpisodeStages.approvalId, approvalId)
      )
    )
    .orderBy(
      asc(workspaceEditorialEpisodeStages.episodeNumber),
      asc(workspaceEditorialEpisodeStages.id)
    );
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

async function episodesForStages(db: any, stages: any[]) {
  const result = [];
  for (const stage of stages) {
    const [episode] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, stage.episodeId))
      .limit(1);
    result.push(episode ?? null);
  }
  return result;
}

function currentStageBatchStatus(input: {
  stages: any[];
  approvalStatus: ReturnType<typeof currentApprovalStatus>;
  approval: any;
  episodes: any[];
  plan: EditorialEpisodeDraftBatchPlan | null;
}) {
  if (!input.approvalStatus.valid || !input.approval) {
    return { valid: false, reason: "APPROVAL_CHANGED" as const };
  }
  if (!input.plan?.ready) {
    return { valid: false, reason: "STAGE_PLAN_INVALID" as const };
  }
  if (input.stages.length === 0) {
    return { valid: false, reason: "STAGE_REQUIRED" as const };
  }
  // Q writes one package stage per Docs work item. Keep the legacy per-tab
  // shape readable so already-published acceptance evidence is not orphaned.
  const expectedPlans = input.stages.length === 1
    ? [buildEditorialEpisodePackPlan(input.plan)]
    : input.plan.items;
  if (
    input.stages.length !== expectedPlans.length ||
    input.episodes.length !== expectedPlans.length
  ) {
    return { valid: false, reason: "STAGE_BATCH_INCOMPLETE" as const };
  }

  const planByEpisode = new Map(
    expectedPlans.map(plan => [plan.episodeNumber, plan] as const)
  );
  for (let index = 0; index < input.stages.length; index += 1) {
    const stage = input.stages[index];
    const episode = input.episodes[index];
    const plan = planByEpisode.get(stage.episodeNumber);
    if (!plan || stage.approvalId !== input.approval.id) {
      return { valid: false, reason: "APPROVAL_CHANGED" as const };
    }
    if (!episode) {
      return { valid: false, reason: "EPISODE_MISSING" as const };
    }
    const replacementStage =
      stage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V3;
    if (replacementStage ? !episode.isPublished : episode.isPublished) {
      return {
        valid: false,
        reason: replacementStage
          ? ("EPISODE_DRIFTED" as const)
          : ("EPISODE_PUBLISHED" as const),
      };
    }
    const currentState = replacementStage
      ? editorialEpisodeReplacementTargetStateSha256({
          novelId: episode.novelId,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          content: episode.content,
          contentFormat: episode.contentFormat,
          wordCount: episode.wordCount,
          isPublished: episode.isPublished,
          saleMode: episode.saleMode,
          price: episode.price,
          isFree: episode.isFree,
          fileUrl: episode.fileUrl,
          fileSize: episode.fileSize,
          fileMimeType: episode.fileMimeType,
        })
      : stage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2
        ? editorialEpisodeStateSha256V2({
            novelId: episode.novelId,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            content: episode.content,
            contentFormat: episode.contentFormat,
            wordCount: episode.wordCount,
            isPublished: episode.isPublished,
            saleMode: episode.saleMode,
            price: episode.price,
            isFree: episode.isFree,
          })
        : editorialEpisodeStateSha256({
            novelId: episode.novelId,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            content: episode.content,
            contentFormat: episode.contentFormat,
            wordCount: episode.wordCount,
            isPublished: episode.isPublished,
          });
    if (
      currentState !== stage.episodeStateSha256 ||
      stage.contentSha256 !== plan.contentSha256 ||
      stage.episodeId !== episode.id ||
      (stage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2 &&
        (stage.saleMode !== episode.saleMode ||
          stage.price !== episode.price ||
          stage.isFree !== episode.isFree))
    ) {
      return { valid: false, reason: "EPISODE_DRIFTED" as const };
    }
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
  const tabs = await loadDraftTabs(db, draft.id);
  const batchPlan = analyzeEditorialEpisodeDraftBatch({
    workItemType: context.workItem.workItemType,
    episodeNumber: context.workItem.episodeNumber,
    episodeTitle: context.workItem.episodeTitle,
    confirmedSourceNoteTabIds: confirmedSourceNoteTabIds(qc),
    tabs,
  });
  const stages = await stagesForApproval(
    db,
    input.workItemId,
    approval?.id ?? null
  );
  const stageEpisodesRaw = await episodesForStages(db, stages);
  const stageStatus = currentStageBatchStatus({
    stages,
    approvalStatus,
    approval,
    episodes: stageEpisodesRaw,
    plan: batchPlan,
  });
  const stageEpisodes = stageEpisodesRaw.map((episode: any) =>
    episode
      ? {
          id: episode.id,
          novelId: episode.novelId,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          contentFormat: episode.contentFormat,
          wordCount: episode.wordCount,
          saleMode: episode.saleMode,
          price: episode.price,
          isFree: episode.isFree,
          isPublished: episode.isPublished,
          publishedAt: episode.publishedAt,
        }
      : null
  );
  const stagePlanError = batchPlan.ready
    ? null
    : batchPlan.blockers.map(item => item.message).join(" · ");

  return {
    latestDraft: draft,
    qc: {
      ready: qc.ready,
      reason: qc.reason,
      checkerRunId: qc.run?.id ?? null,
      qcEvidenceSha256: qc.qcEvidenceSha256,
      unresolvedCount: qc.unresolvedCount,
      blockingAnomalyCount: qc.blockingAnomalyCount ?? 0,
      anomalyCount: Number(qc.run?.anomalyCount ?? 0),
      tabCount: Number(qc.run?.tabCount ?? 0),
      expectedTabCount:
        qc.run?.expectedTabCount === null || qc.run?.expectedTabCount === undefined
          ? null
          : Number(qc.run.expectedTabCount),
    },
    approval,
    approvalStatus,
    stages,
    stageEpisodes,
    stage: stages[0] ?? null,
    stageEpisode: stageEpisodes[0] ?? null,
    stageStatus,
    stagePlan: stagePlanSummary(batchPlan, {
      saleMode: context.workItem.saleMode,
      price: context.workItem.price,
      isFree: context.workItem.isFree,
    }),
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
    if (
      !qc.ready ||
      qc.unresolvedCount !== 0 ||
      Number(qc.blockingAnomalyCount ?? 0) !== 0 ||
      !qc.qcEvidenceSha256
    ) {
      throw new WorkspaceEditorialApprovalError(
        "QC_UNRESOLVED",
        "All deterministic checker findings and blocking structural anomalies must be resolved before approval."
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
    const batchPlan = analyzeEditorialEpisodeDraftBatch({
      workItemType: context.workItem.workItemType,
      episodeNumber: context.workItem.episodeNumber,
      episodeTitle: context.workItem.episodeTitle,
      confirmedSourceNoteTabIds: confirmedSourceNoteTabIds(qc),
      tabs,
    });
    if (!batchPlan.ready) {
      throw new WorkspaceEditorialApprovalError(
        "STAGE_INVALID",
        batchPlan.blockers.map(item => item.message).join(" · ") ||
          "Episode range mapping is ambiguous."
      );
    }

    const novelId = context.workspaceNovel.novelId;
    const packPlan = buildEditorialEpisodePackPlan(batchPlan);
    const effectiveSale = resolveEditorialEpisodePackSale(batchPlan, {
      saleMode: context.workItem.saleMode,
      price: context.workItem.price,
      isFree: context.workItem.isFree,
    });
    if (!effectiveSale) {
      throw new WorkspaceEditorialApprovalError(
        "STAGE_INVALID",
        "Episode sale metadata is incomplete or invalid."
      );
    }
    const { saleMode, price, isFree } = effectiveSale;
    const numericPrice = Number(price);
    if (
      !Number.isFinite(numericPrice) ||
      (isFree ? price !== "0.00" : numericPrice <= 0)
    ) {
      throw new WorkspaceEditorialApprovalError(
        "STAGE_INVALID",
        "Episode sale metadata is invalid."
      );
    }
    if (
      effectiveSale.usesDefault &&
      (context.workItem.saleMode !== saleMode ||
        context.workItem.price !== price ||
        context.workItem.isFree !== isFree)
    ) {
      await tx
        .update(workspaceEditorialWorkItems)
        .set({
          saleMode,
          price,
          isFree,
          version: sql`${workspaceEditorialWorkItems.version} + 1`,
        })
        .where(eq(workspaceEditorialWorkItems.id, input.workItemId));
    }
    const staged: Array<{ stage: any; episode: any; replayed: boolean }> = [];
    // A Workspace Google Docs work item is one commercial Episode Pack. Tabs
    // are chapters inside that package. Confirmed source-note Episodes remain
    // visible but are excluded from the default billable tab count.

    for (const plan of [packPlan]) {
      const legacyPayloadSha256 = editorialEpisodeStagePayloadSha256({
        workItemId: input.workItemId,
        approvalId: approval.id,
        draftId: draft.id,
        draftSha256: draft.draftSha256,
        qcEvidenceSha256: qc.qcEvidenceSha256,
        novelId,
        plan,
      });
      const payloadSha256 = editorialEpisodeStagePayloadSha256V2({
        workItemId: input.workItemId,
        approvalId: approval.id,
        draftId: draft.id,
        draftSha256: draft.draftSha256,
        qcEvidenceSha256: qc.qcEvidenceSha256,
        novelId,
        plan,
        saleMode,
        price,
        isFree,
      });
      const itemIdempotencyKey = stageItemIdempotencyKey(
        input.idempotencyKey,
        plan.episodeNumber
      );

      const [existingStage] = await tx
        .select()
        .from(workspaceEditorialEpisodeStages)
        .where(
          and(
            eq(workspaceEditorialEpisodeStages.approvalId, approval.id),
            eq(workspaceEditorialEpisodeStages.episodeNumber, plan.episodeNumber)
          )
        )
        .limit(1)
        .for("update");

      if (existingStage) {
        const expectedPayloadSha256 =
          existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V3
            ? editorialEpisodeStagePayloadSha256V3({
                workItemId: input.workItemId,
                approvalId: approval.id,
                draftId: draft.id,
                draftSha256: draft.draftSha256,
                qcEvidenceSha256: qc.qcEvidenceSha256,
                novelId,
                plan,
                saleMode,
                price,
                isFree,
                replacementTargetStateSha256: existingStage.episodeStateSha256,
              })
            : existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2
              ? payloadSha256
              : existingStage.stageContract === null ||
                  existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT
                ? legacyPayloadSha256
                : null;
        if (
          expectedPayloadSha256 === null ||
          existingStage.payloadSha256 !== expectedPayloadSha256 ||
          existingStage.stagedByUserId !== input.actorUserId ||
          existingStage.stagedDraftSha256 !== draft.draftSha256 ||
          existingStage.qcEvidenceSha256 !== qc.qcEvidenceSha256
        ) {
          throw new WorkspaceEditorialApprovalError(
            "EPISODE_CONFLICT",
            `Episode ${plan.episodeNumber} was already staged from different evidence.`
          );
        }
        const [episode] = await tx
          .select()
          .from(episodes)
          .where(eq(episodes.id, existingStage.episodeId))
          .limit(1)
          .for("update");
        if (!episode) {
          throw new WorkspaceEditorialApprovalError(
            "EPISODE_CONFLICT",
            `Previously staged Episode ${plan.episodeNumber} no longer exists.`
          );
        }
        const replacementStage =
          existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V3;
        const currentState = replacementStage
          ? editorialEpisodeReplacementTargetStateSha256({
              novelId: episode.novelId,
              episodeNumber: episode.episodeNumber,
              title: episode.title,
              content: episode.content,
              contentFormat: episode.contentFormat,
              wordCount: episode.wordCount,
              isPublished: episode.isPublished,
              saleMode: episode.saleMode,
              price: episode.price,
              isFree: episode.isFree,
              fileUrl: episode.fileUrl,
              fileSize: episode.fileSize,
              fileMimeType: episode.fileMimeType,
            })
          : existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2
            ? editorialEpisodeStateSha256V2({
                novelId: episode.novelId,
                episodeNumber: episode.episodeNumber,
                title: episode.title,
                content: episode.content,
                contentFormat: episode.contentFormat,
                wordCount: episode.wordCount,
                isPublished: episode.isPublished,
                saleMode: episode.saleMode,
                price: episode.price,
                isFree: episode.isFree,
              })
            : editorialEpisodeStateSha256({
                novelId: episode.novelId,
                episodeNumber: episode.episodeNumber,
                title: episode.title,
                content: episode.content,
                contentFormat: episode.contentFormat,
                wordCount: episode.wordCount,
                isPublished: episode.isPublished,
              });
        if (
          (replacementStage ? !episode.isPublished : episode.isPublished) ||
          currentState !== existingStage.episodeStateSha256 ||
          existingStage.contentSha256 !== plan.contentSha256
        ) {
          throw new WorkspaceEditorialApprovalError(
            "EPISODE_CONFLICT",
            `Previously staged Episode ${plan.episodeNumber} is no longer safe to replay.`
          );
        }
        staged.push({ stage: existingStage, episode, replayed: true });
        continue;
      }

      const existingEpisode = await lockEpisodeByCanonicalIdentity(
        tx,
        novelId,
        plan.episodeNumber
      );

      let episodeId: number;
      let stageContract: string = EDITORIAL_EPISODE_STAGE_CONTRACT_V2;
      let stagePayloadSha256 = payloadSha256;
      let stagedEpisodeStateSha256: string | null = null;
      if (!existingEpisode) {
        try {
          episodeId = insertId(
            await tx.insert(episodes).values({
              novelId,
              episodeNumber: plan.episodeNumber,
              title: plan.title,
              content: plan.content,
              contentFormat: plan.contentFormat,
              saleMode,
              price,
              isFree,
              isPublished: false,
              publishedAt: null,
              wordCount: plan.wordCount,
            })
          );
        } catch (error) {
          if (isDuplicateKey(error)) {
            throw new WorkspaceEditorialApprovalError(
              "EPISODE_CONFLICT",
              `Episode ${plan.episodeNumber} was staged concurrently.`
            );
          }
          throw error;
        }
      } else {
        if (existingEpisode.isPublished) {
          // Preserve the live Episode row and stable id until Controlled Publish.
          episodeId = existingEpisode.id;
          stageContract = EDITORIAL_EPISODE_STAGE_CONTRACT_V3;
          stagedEpisodeStateSha256 =
            editorialEpisodeReplacementTargetStateSha256({
              novelId: existingEpisode.novelId,
              episodeNumber: existingEpisode.episodeNumber,
              title: existingEpisode.title,
              content: existingEpisode.content,
              contentFormat: existingEpisode.contentFormat,
              wordCount: existingEpisode.wordCount,
              isPublished: existingEpisode.isPublished,
              saleMode: existingEpisode.saleMode,
              price: existingEpisode.price,
              isFree: existingEpisode.isFree,
              fileUrl: existingEpisode.fileUrl,
              fileSize: existingEpisode.fileSize,
              fileMimeType: existingEpisode.fileMimeType,
            });
          stagePayloadSha256 = editorialEpisodeStagePayloadSha256V3({
            workItemId: input.workItemId,
            approvalId: approval.id,
            draftId: draft.id,
            draftSha256: draft.draftSha256,
            qcEvidenceSha256: qc.qcEvidenceSha256,
            novelId,
            plan,
            saleMode,
            price,
            isFree,
            replacementTargetStateSha256: stagedEpisodeStateSha256,
          });
        } else {
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
            `Unpublished Episode ${plan.episodeNumber} is not owned by this Editorial work item.`
          );
        }
        const existingState = previousStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2
          ? editorialEpisodeStateSha256V2({
              novelId: existingEpisode.novelId,
              episodeNumber: existingEpisode.episodeNumber,
              title: existingEpisode.title,
              content: existingEpisode.content,
              contentFormat: existingEpisode.contentFormat,
              wordCount: existingEpisode.wordCount,
              isPublished: existingEpisode.isPublished,
              saleMode: existingEpisode.saleMode,
              price: existingEpisode.price,
              isFree: existingEpisode.isFree,
            })
          : editorialEpisodeStateSha256({
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
            `Unpublished Episode ${plan.episodeNumber} drifted after its previous Workspace stage.`
          );
        }
        const update = await tx
          .update(episodes)
          .set({
            title: plan.title,
            content: plan.content,
            contentFormat: plan.contentFormat,
            wordCount: plan.wordCount,
            saleMode,
            price,
            isFree,
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
            `Episode ${plan.episodeNumber} changed concurrently during staging.`
          );
        }
        episodeId = existingEpisode.id;
        }
      }

      const [episode] = await tx
        .select()
        .from(episodes)
        .where(eq(episodes.id, episodeId))
        .limit(1);
      const replacementStage =
        stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V3;
      if (
        !episode ||
        episode.novelId !== novelId ||
        (replacementStage ? !episode.isPublished : episode.isPublished)
      ) {
        throw new WorkspaceEditorialApprovalError(
          "EPISODE_CONFLICT",
          replacementStage
            ? `Replacement target Episode ${plan.episodeNumber} is no longer published/current.`
            : `Staged Episode ${plan.episodeNumber} could not be verified as unpublished.`
        );
      }
      if (!stagedEpisodeStateSha256) {
        stagedEpisodeStateSha256 = editorialEpisodeStateSha256V2({
          novelId: episode.novelId,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          content: episode.content,
          contentFormat: episode.contentFormat,
          wordCount: episode.wordCount,
          isPublished: episode.isPublished,
          saleMode: episode.saleMode,
          price: episode.price,
          isFree: episode.isFree,
        });
      }

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
          stageContract,
          saleMode,
          price,
          isFree,
          contentSha256: plan.contentSha256,
          episodeStateSha256: stagedEpisodeStateSha256,
          payloadSha256: stagePayloadSha256,
          idempotencyKey: itemIdempotencyKey,
          stagedByUserId: input.actorUserId,
        })
      );
      const [stage] = await tx
        .select()
        .from(workspaceEditorialEpisodeStages)
        .where(eq(workspaceEditorialEpisodeStages.id, stageId))
        .limit(1);
      staged.push({ stage, episode, replayed: false });
    }

    if (staged.length !== 1) {
      throw new WorkspaceEditorialApprovalError(
        "EPISODE_CONFLICT",
        "Episode Pack staging was not persisted completely."
      );
    }

    const projection = await projectEditorialQcColumn(tx, {
      workItemId: input.workItemId,
      expectedDraftId: draft.id,
      targetColumnKey: "ready_to_publish",
      actorUserId: input.actorUserId,
      reason:
        batchPlan.items.length === 1
          ? "editorial_episode_staged_from_approved_draft"
          : "editorial_episode_range_staged_from_approved_draft",
      idempotencyKey: `editorial-stage-batch:${approval.id}:${draft.id}:${draft.draftSha256.slice(0, 24)}`,
    });
    if ((projection as any).reason) {
      throw new WorkspaceEditorialApprovalError(
        "KANBAN_CONFLICT",
        "Episode batch was staged but ready-to-publish Kanban projection could not be validated."
      );
    }

    return {
      stages: staged.map(row => row.stage),
      episodes: staged.map(row => row.episode),
      stage: staged[0]?.stage ?? null,
      episode: staged[0]?.episode ?? null,
      replayed: staged.every(row => row.replayed),
      batchCount: staged.length,
    };
  });

  return {
    ...result,
    readModel: await getEditorialApprovalReadModel(input),
  };
}
