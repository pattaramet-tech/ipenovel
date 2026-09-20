import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  episodes,
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceEditorialEpisodeStages,
  workspaceEditorialWorkItems,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspacePublishingDestinations,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import { EDITORIAL_EPISODE_STAGE_CONTRACT_V2 } from "./editorialApproval.domain";
import { getEditorialApprovalReadModel } from "./editorialApproval.service";
import { projectEditorialQcColumn } from "./editorialQcProjection.service";
import { createPublishDestination, createPublishDryRun } from "./publishDryRun.service";
import { requestPublishExecution } from "./publishExecution.service";
import type {
  WorkspacePublishExecutionScope,
  WorkspacePublishProviderRequest,
} from "./publishExecution.domain";

export const EDITORIAL_PUBLISH_ITEM_PREFIX = "editorial-stage" as const;
export const EDITORIAL_PUBLISH_POLICY_VERSION = "workspace-editorial-publish-v1" as const;

export class WorkspaceEditorialPublishError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "WORK_ITEM_NOT_FOUND"
      | "STAGE_NOT_READY"
      | "STAGE_CONFLICT"
      | "PUBLISH_ANCHOR_AMBIGUOUS"
      | "PUBLISH_OWNERSHIP_CONFLICT"
      | "PUBLISH_STATE_CONFLICT"
      | "KANBAN_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceEditorialPublishError";
  }
}

function editorialItemKey(stageId: number, episodeId: number) {
  return `${EDITORIAL_PUBLISH_ITEM_PREFIX}:${stageId}:episode:${episodeId}`;
}

function parseEditorialItemKey(value: string) {
  const match = value.match(/^editorial-stage:(\d+):episode:(\d+)$/);
  if (!match) return null;
  const stageId = Number(match[1]);
  const episodeId = Number(match[2]);
  return Number.isSafeInteger(stageId) && stageId > 0 &&
    Number.isSafeInteger(episodeId) && episodeId > 0
    ? { stageId, episodeId }
    : null;
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceEditorialPublishError(
      "DATABASE_UNAVAILABLE",
      "Workspace editorial publish database is unavailable."
    );
  }
  return db;
}

async function loadContext(db: any, workspaceId: number, workItemId: number) {
  const [row] = await db
    .select({
      workItem: workspaceEditorialWorkItems,
      workspaceNovel: workspaceNovels,
      card: workspaceKanbanCards,
      column: workspaceKanbanColumns,
    })
    .from(workspaceEditorialWorkItems)
    .innerJoin(workspaceNovels, eq(workspaceEditorialWorkItems.workspaceNovelId, workspaceNovels.id))
    .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
    .where(and(
      eq(workspaceEditorialWorkItems.id, workItemId),
      eq(workspaceNovels.workspaceId, workspaceId)
    ))
    .limit(1);
  if (!row) {
    throw new WorkspaceEditorialPublishError(
      "WORK_ITEM_NOT_FOUND",
      "Editorial work item was not found in this Workspace."
    );
  }
  return row;
}

async function loadOwnership(db: any, workspaceNovelId: number) {
  const rows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  return rows.length === 1 ? rows[0] : null;
}

async function loadDestination(db: any, workspaceNovelId: number, novelId: number) {
  const [destination] = await db.select().from(workspacePublishingDestinations).where(and(
    eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovelId),
    eq(workspacePublishingDestinations.targetType, "novel"),
    eq(workspacePublishingDestinations.targetId, novelId),
    eq(workspacePublishingDestinations.status, "active")
  )).limit(1);
  return destination ?? null;
}

async function loadAnchor(db: any, workspaceNovelId: number) {
  const rows = await db
    .select({ binding: workspaceDocumentBindings, fingerprint: workspaceDocumentFingerprints })
    .from(workspaceDocumentBindings)
    .innerJoin(
      workspaceDocumentFingerprints,
      eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id)
    )
    .where(and(
      eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovelId),
      eq(workspaceDocumentBindings.status, "active")
    ));
  return rows.length === 1 ? rows[0] : null;
}

function editorialStageSetSha256(stages: any[]) {
  const payload = stages
    .map(stage => ({
      id: Number(stage.id),
      episodeId: Number(stage.episodeId),
      episodeNumber: String(stage.episodeNumber),
      stagedDraftSha256: String(stage.stagedDraftSha256).toLowerCase(),
      contentSha256: String(stage.contentSha256).toLowerCase(),
      episodeStateSha256: String(stage.episodeStateSha256).toLowerCase(),
    }))
    .sort((a, b) =>
      a.episodeNumber.localeCompare(b.episodeNumber, "en", { numeric: true }) ||
      a.id - b.id
    );
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

async function loadMatchingRunBatch(
  db: any,
  workspaceNovelId: number,
  stages: any[]
) {
  if (stages.length === 0) return null;
  const expected = stages
    .map(stage => ({
      itemKey: editorialItemKey(stage.id, stage.episodeId),
      episodeId: stage.episodeId,
      sourceSha256: stage.contentSha256.toLowerCase(),
    }))
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey));

  const candidates = await db
    .select({
      run: workspacePublishRuns,
      destination: workspacePublishingDestinations,
    })
    .from(workspacePublishRuns)
    .innerJoin(
      workspacePublishingDestinations,
      eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id)
    )
    .where(eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovelId))
    .orderBy(desc(workspacePublishRuns.id));

  for (const candidate of candidates) {
    const items = await db
      .select()
      .from(workspacePublishItems)
      .where(eq(workspacePublishItems.runId, candidate.run.id));
    if (items.length !== expected.length) continue;
    const actual = items
      .map((item: any) => ({
        itemKey: item.itemKey,
        episodeId: item.episodeId,
        sourceSha256: item.sourceSha256.toLowerCase(),
      }))
      .sort((a: any, b: any) => a.itemKey.localeCompare(b.itemKey));
    const matches = expected.every(
      (item, index) =>
        actual[index]?.itemKey === item.itemKey &&
        actual[index]?.episodeId === item.episodeId &&
        actual[index]?.sourceSha256 === item.sourceSha256
    );
    if (matches) {
      return { ...candidate, items };
    }
  }
  return null;
}

export async function getEditorialPublishReadModel(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const context = await loadContext(db, input.workspaceId, input.workItemId);
  const approval = await getEditorialApprovalReadModel(input);
  const ownership = await loadOwnership(db, context.workspaceNovel.id);
  const destination = await loadDestination(
    db,
    context.workspaceNovel.id,
    context.workspaceNovel.novelId
  );
  const anchor = await loadAnchor(db, context.workspaceNovel.id);
  const stages = (approval.stages ?? []).filter(Boolean);
  const stageEpisodes = (approval.stageEpisodes ?? []).filter(Boolean);
  const matching =
    approval.readyToPublish && stages.length > 0
      ? await loadMatchingRunBatch(db, context.workspaceNovel.id, stages)
      : null;
  const outbox = matching
    ? await db.select().from(workspaceOutbox)
        .where(eq(workspaceOutbox.publishRunId, matching.run.id))
        .orderBy(desc(workspaceOutbox.id))
    : [];

  const stageReady = Boolean(
    approval.readyToPublish &&
    stages.length > 0 &&
    stageEpisodes.length === stages.length &&
    context.column.key === "ready_to_publish"
  );
  const ownershipReady = Boolean(
    ownership && ownership.owner === "workspace" && ownership.cutoverEpoch >= 1
  );

  return {
    workItem: context.workItem,
    workspaceNovel: context.workspaceNovel,
    kanbanColumnKey: context.column.key,
    stages,
    stageEpisodes,
    stage: stages[0] ?? null,
    stageStatus: approval.stageStatus,
    stageEpisode: stageEpisodes[0] ?? null,
    stageSetSha256: stages.length > 0 ? editorialStageSetSha256(stages) : null,
    approvalStatus: approval.approvalStatus,
    qc: approval.qc,
    readyToPublish: approval.readyToPublish,
    ownership,
    destination,
    anchor: anchor ? {
      bindingId: anchor.binding.id,
      snapshotId: anchor.fingerprint.snapshotId,
      normalizedSha256: anchor.fingerprint.normalizedSha256,
      lastPublishedSha256: anchor.fingerprint.lastPublishedSha256 ?? null,
    } : null,
    publishRun: matching?.run ?? null,
    publishItems: matching?.items ?? [],
    publishItem: matching?.items?.[0] ?? null,
    outbox,
    requestReady: stageReady && ownershipReady && Boolean(anchor),
    blocker: !stageReady
      ? "STAGE_NOT_READY"
      : !ownershipReady
        ? "PUBLISH_OWNERSHIP_CONFLICT"
        : !anchor
          ? "PUBLISH_ANCHOR_AMBIGUOUS"
          : null,
  };
}

export async function requestEditorialPublish(input: {
  actorUserId: number;
  workspaceId: number;
  workItemId: number;
  expectedStageSetSha256: string;
  expectedStagedDraftSha256: string;
  expectedCutoverEpoch: number;
  expectedOwnershipVersion: number;
  executionEnabled: boolean;
  executionScope?: WorkspacePublishExecutionScope;
}) {
  const state = await getEditorialPublishReadModel({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    workItemId: input.workItemId,
  });
  if (
    state.stages.length === 0 ||
    state.stageEpisodes.length !== state.stages.length ||
    !state.readyToPublish ||
    state.kanbanColumnKey !== "ready_to_publish"
  ) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_NOT_READY",
      "Controlled Publish requires the complete current approved Episode stage batch in ready_to_publish."
    );
  }
  if (
    state.stageSetSha256 !== input.expectedStageSetSha256.toLowerCase() ||
    state.stages.some(
      (stage: any) =>
        stage.stagedDraftSha256 !==
        input.expectedStagedDraftSha256.toLowerCase()
    )
  ) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_CONFLICT",
      "Editorial stage batch changed before Controlled Publish was requested."
    );
  }
  if (
    !state.ownership ||
    state.ownership.owner !== "workspace" ||
    state.ownership.cutoverEpoch !== input.expectedCutoverEpoch ||
    state.ownership.version !== input.expectedOwnershipVersion
  ) {
    throw new WorkspaceEditorialPublishError(
      "PUBLISH_OWNERSHIP_CONFLICT",
      "Controlled Publish requires the current Workspace-owned publish epoch/version."
    );
  }
  if (!state.anchor) {
    throw new WorkspaceEditorialPublishError(
      "PUBLISH_ANCHOR_AMBIGUOUS",
      "Controlled Publish requires exactly one current active document fingerprint."
    );
  }

  let destination = state.destination;
  if (!destination) {
    destination = (await createPublishDestination({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      workspaceNovelId: state.workspaceNovel.id,
      targetType: "novel",
      targetId: state.workspaceNovel.novelId,
      policyVersion: EDITORIAL_PUBLISH_POLICY_VERSION,
    })).destination;
  }

  const plan = state.publishRun
    ? { run: state.publishRun, created: false }
    : await createPublishDryRun({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
        destinationId: destination.id,
        snapshotId: state.anchor.snapshotId,
        expectedLastPublishedSha256:
          state.anchor.lastPublishedSha256 ?? undefined,
        items: state.stages.map((stage: any) => ({
          itemKey: editorialItemKey(stage.id, stage.episodeId),
          episodeId: stage.episodeId,
          sourceSha256: stage.contentSha256,
        })),
      });

  const execution = await requestPublishExecution({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    runId: plan.run.id,
    expectedCutoverEpoch: input.expectedCutoverEpoch,
    expectedOwnershipVersion: input.expectedOwnershipVersion,
    executionScope: input.executionScope,
    executionEnabled: input.executionEnabled,
  });

  return {
    plan,
    execution,
    scope: {
      workspaceId: input.workspaceId,
      workspaceNovelId: state.workspaceNovel.id,
      runId: plan.run.id,
      expectedCutoverEpoch: input.expectedCutoverEpoch,
      expectedOwnershipVersion: input.expectedOwnershipVersion,
    },
  };
}

export async function assertEditorialPublishRequestCurrent(
  request: WorkspacePublishProviderRequest
) {
  const identity = parseEditorialItemKey(request.itemKey);
  if (!identity) return { editorial: false as const };
  if (identity.episodeId !== request.episodeId) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_CONFLICT",
      "Editorial publish item episode identity is inconsistent."
    );
  }
  const db = await database();
  const [stage] = await db.select().from(workspaceEditorialEpisodeStages)
    .where(eq(workspaceEditorialEpisodeStages.id, identity.stageId)).limit(1);
  if (!stage || stage.episodeId !== request.episodeId ||
      stage.contentSha256 !== request.sourceSha256.toLowerCase()) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_CONFLICT",
      "Editorial publish item no longer matches its immutable stage evidence."
    );
  }
  const state = await getEditorialApprovalReadModel({
    actorUserId: stage.stagedByUserId,
    workspaceId: request.workspaceId,
    workItemId: stage.workItemId,
  });
  const context = await loadContext(db, request.workspaceId, stage.workItemId);
  const stageCurrent = (state.stages ?? []).some(
    (candidate: any) =>
      candidate.id === stage.id &&
      candidate.episodeId === stage.episodeId &&
      candidate.contentSha256 === stage.contentSha256
  );
  const currentEpisode = (state.stageEpisodes ?? []).find(
    (episode: any) => episode?.id === stage.episodeId
  );
  if (
    stage.novelId !== request.targetId ||
    context.workspaceNovel.novelId !== request.targetId ||
    context.column.key !== "ready_to_publish" ||
    !state.approvalStatus?.valid ||
    !state.stagePlan?.ready ||
    !stageCurrent ||
    !currentEpisode ||
    currentEpisode.isPublished ||
    (stage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2 &&
      (stage.saleMode !== currentEpisode.saleMode ||
        stage.price !== currentEpisode.price ||
        stage.isFree !== currentEpisode.isFree))
  ) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_NOT_READY",
      "Editorial approval, QC, Draft, or Episode changed before provider execution."
    );
  }
  return { editorial: true as const, stage };
}

export async function reconcileEditorialPublishRun(input: {
  workspaceId: number;
  runId: number;
}) {
  const db = await database();
  const [runContext] = await db
    .select({
      run: workspacePublishRuns,
      destination: workspacePublishingDestinations,
      workspaceNovel: workspaceNovels,
    })
    .from(workspacePublishRuns)
    .innerJoin(
      workspacePublishingDestinations,
      eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id)
    )
    .innerJoin(
      workspaceNovels,
      eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id)
    )
    .where(and(
      eq(workspacePublishRuns.id, input.runId),
      eq(workspaceNovels.workspaceId, input.workspaceId)
    ))
    .limit(1);
  if (!runContext) return { matched: false as const, reason: "RUN_NOT_FOUND" as const };

  const items = await db.select().from(workspacePublishItems)
    .where(eq(workspacePublishItems.runId, input.runId));
  const editorial = items
    .map((item: any) => ({ item, identity: parseEditorialItemKey(item.itemKey) }))
    .filter((row: any) => row.identity);
  if (editorial.length === 0) return { matched: false as const, reason: "NOT_EDITORIAL" as const };
  if (editorial.length !== items.length) {
    throw new WorkspaceEditorialPublishError(
      "PUBLISH_STATE_CONFLICT",
      "Editorial Controlled Publish cannot mix Editorial and non-Editorial items in one run."
    );
  }

  const resolved: Array<{ item: any; stage: any; episode: any }> = [];
  for (const row of editorial as any[]) {
    const { item, identity } = row;
    const [stage] = await db
      .select()
      .from(workspaceEditorialEpisodeStages)
      .where(eq(workspaceEditorialEpisodeStages.id, identity.stageId))
      .limit(1);
    if (
      !stage ||
      stage.episodeId !== item.episodeId ||
      stage.contentSha256 !== item.sourceSha256
    ) {
      throw new WorkspaceEditorialPublishError(
        "STAGE_CONFLICT",
        "Published run no longer resolves to its exact Editorial stage evidence."
      );
    }
    const [episode] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, stage.episodeId))
      .limit(1);
    if (!episode) {
      throw new WorkspaceEditorialPublishError(
        "STAGE_CONFLICT",
        "Published run references an Editorial Episode that no longer exists."
      );
    }
    if (
      stage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2 &&
      (stage.saleMode !== episode.saleMode ||
        stage.price !== episode.price ||
        stage.isFree !== episode.isFree)
    ) {
      throw new WorkspaceEditorialPublishError(
        "STAGE_CONFLICT",
        "Published run Episode sale metadata no longer matches immutable stage evidence."
      );
    }
    resolved.push({ item, stage, episode });
  }

  const first = resolved[0];
  if (
    !first ||
    resolved.some(
      row =>
        row.stage.workItemId !== first.stage.workItemId ||
        row.stage.draftId !== first.stage.draftId ||
        row.stage.approvalId !== first.stage.approvalId
    )
  ) {
    throw new WorkspaceEditorialPublishError(
      "PUBLISH_STATE_CONFLICT",
      "Editorial publish batch must resolve to one work item, Draft, and approval."
    );
  }

  const [outbox] = await db
    .select()
    .from(workspaceOutbox)
    .where(eq(workspaceOutbox.publishRunId, input.runId))
    .orderBy(desc(workspaceOutbox.id))
    .limit(1);

  const allDurable =
    runContext.run.status === "published" &&
    outbox?.status === "delivered" &&
    resolved.every(
      row =>
        row.item.status === "published" &&
        Boolean(row.item.providerReceipt) &&
        row.episode.isPublished === true
    );
  if (!allDurable) {
    return {
      matched: true as const,
      projected: false as const,
      reason: "PUBLISH_NOT_DURABLE" as const,
      itemCount: resolved.length,
      durableItemCount: resolved.filter(
        row =>
          row.item.status === "published" &&
          Boolean(row.item.providerReceipt) &&
          row.episode.isPublished === true
      ).length,
    };
  }

  const projection = await db.transaction(async (tx: any) => {
    const [context] = await tx
      .select({ card: workspaceKanbanCards, column: workspaceKanbanColumns })
      .from(workspaceEditorialWorkItems)
      .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
      .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
      .where(eq(workspaceEditorialWorkItems.id, first.stage.workItemId))
      .for("update")
      .limit(1);
    if (!context) {
      throw new WorkspaceEditorialPublishError(
        "WORK_ITEM_NOT_FOUND",
        "Editorial work item disappeared before publish projection."
      );
    }
    if (context.column.key === "published") {
      return { changed: false, replayed: true, columnId: context.column.id };
    }
    if (context.column.key !== "ready_to_publish") {
      throw new WorkspaceEditorialPublishError(
        "KANBAN_CONFLICT",
        `Durable publish succeeded while Editorial card is in ${context.column.key}, not ready_to_publish.`
      );
    }
    const projected = await projectEditorialQcColumn(tx, {
      workItemId: first.stage.workItemId,
      expectedDraftId: first.stage.draftId,
      targetColumnKey: "published",
      actorUserId: first.stage.stagedByUserId,
      reason: `Durable Controlled Publish run #${input.runId} delivered ${resolved.length} provider receipt(s).`,
      idempotencyKey: `editorial-published:${input.runId}:${first.stage.workItemId}`,
    });
    if ((projected as any).reason) {
      throw new WorkspaceEditorialPublishError(
        "KANBAN_CONFLICT",
        `Published projection refused: ${String((projected as any).reason)}.`
      );
    }
    return projected;
  });

  return {
    matched: true as const,
    projected: true as const,
    projection,
    stageId: first.stage.id,
    stageIds: resolved.map(row => row.stage.id),
    workItemId: first.stage.workItemId,
    episodeId: first.stage.episodeId,
    episodeIds: resolved.map(row => row.stage.episodeId),
    publishRunId: input.runId,
    providerReceipt: first.item.providerReceipt,
    providerReceipts: resolved.map(row => row.item.providerReceipt),
    itemCount: resolved.length,
  };
}
