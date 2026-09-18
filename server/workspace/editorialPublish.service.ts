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

async function loadMatchingRun(
  db: any,
  workspaceNovelId: number,
  stageId: number,
  episodeId: number,
  sourceSha256: string
) {
  const rows = await db
    .select({
      run: workspacePublishRuns,
      item: workspacePublishItems,
      destination: workspacePublishingDestinations,
    })
    .from(workspacePublishItems)
    .innerJoin(workspacePublishRuns, eq(workspacePublishItems.runId, workspacePublishRuns.id))
    .innerJoin(
      workspacePublishingDestinations,
      eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id)
    )
    .where(and(
      eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovelId),
      eq(workspacePublishItems.episodeId, episodeId),
      eq(workspacePublishItems.sourceSha256, sourceSha256.toLowerCase())
    ))
    .orderBy(desc(workspacePublishRuns.id));
  const expectedItemKey = editorialItemKey(stageId, episodeId);
  return rows.find((row: any) => row.item.itemKey === expectedItemKey) ?? null;
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
  const matching = approval.stage && approval.stageEpisode
    ? await loadMatchingRun(
        db,
        context.workspaceNovel.id,
        approval.stage.id,
        approval.stageEpisode.id,
        approval.stage.contentSha256
      )
    : null;
  const outbox = matching
    ? await db.select().from(workspaceOutbox)
        .where(eq(workspaceOutbox.publishRunId, matching.run.id))
        .orderBy(desc(workspaceOutbox.id))
    : [];

  const stageReady = Boolean(
    approval.readyToPublish &&
    approval.stage &&
    approval.stageEpisode &&
    context.column.key === "ready_to_publish"
  );
  const ownershipReady = Boolean(
    ownership && ownership.owner === "workspace" && ownership.cutoverEpoch >= 1
  );

  return {
    workItem: context.workItem,
    workspaceNovel: context.workspaceNovel,
    kanbanColumnKey: context.column.key,
    stage: approval.stage,
    stageStatus: approval.stageStatus,
    stageEpisode: approval.stageEpisode,
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
    publishItem: matching?.item ?? null,
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
  expectedStageId: number;
  expectedStagedDraftSha256: string;
  expectedEpisodeStateSha256: string;
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
  if (!state.stage || !state.stageEpisode || !state.readyToPublish ||
      state.kanbanColumnKey !== "ready_to_publish") {
    throw new WorkspaceEditorialPublishError(
      "STAGE_NOT_READY",
      "Controlled Publish requires the current approved staged Episode in ready_to_publish."
    );
  }
  if (
    state.stage.id !== input.expectedStageId ||
    state.stage.stagedDraftSha256 !== input.expectedStagedDraftSha256.toLowerCase() ||
    state.stage.episodeStateSha256 !== input.expectedEpisodeStateSha256.toLowerCase()
  ) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_CONFLICT",
      "Editorial stage changed before Controlled Publish was requested."
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
        expectedLastPublishedSha256: state.anchor.lastPublishedSha256 ?? undefined,
        items: [{
          itemKey: editorialItemKey(state.stage.id, state.stageEpisode.id),
          episodeId: state.stageEpisode.id,
          sourceSha256: state.stage.contentSha256,
        }],
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
  if (
    stage.novelId !== request.targetId ||
    context.workspaceNovel.novelId !== request.targetId ||
    context.column.key !== "ready_to_publish" ||
    !state.readyToPublish ||
    state.stage?.id !== stage.id ||
    state.stageEpisode?.id !== stage.episodeId
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
  if (editorial.length !== 1 || items.length !== 1) {
    throw new WorkspaceEditorialPublishError(
      "PUBLISH_STATE_CONFLICT",
      "Editorial Controlled Publish requires exactly one staged Episode item per run."
    );
  }

  const { item, identity } = editorial[0] as any;
  const [stage] = await db.select().from(workspaceEditorialEpisodeStages)
    .where(eq(workspaceEditorialEpisodeStages.id, identity.stageId)).limit(1);
  if (!stage || stage.episodeId !== item.episodeId ||
      stage.contentSha256 !== item.sourceSha256) {
    throw new WorkspaceEditorialPublishError(
      "STAGE_CONFLICT",
      "Published run no longer resolves to its exact Editorial stage evidence."
    );
  }
  const [episode] = await db.select().from(episodes)
    .where(eq(episodes.id, stage.episodeId)).limit(1);
  const [outbox] = await db.select().from(workspaceOutbox)
    .where(eq(workspaceOutbox.publishRunId, input.runId))
    .orderBy(desc(workspaceOutbox.id)).limit(1);

  if (
    runContext.run.status !== "published" ||
    item.status !== "published" ||
    !item.providerReceipt ||
    outbox?.status !== "delivered" ||
    episode?.isPublished !== true
  ) {
    return {
      matched: true as const,
      projected: false as const,
      reason: "PUBLISH_NOT_DURABLE" as const,
    };
  }

  const projection = await db.transaction(async (tx: any) => {
    const [context] = await tx
      .select({ card: workspaceKanbanCards, column: workspaceKanbanColumns })
      .from(workspaceEditorialWorkItems)
      .innerJoin(workspaceKanbanCards, eq(workspaceEditorialWorkItems.cardId, workspaceKanbanCards.id))
      .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
      .where(eq(workspaceEditorialWorkItems.id, stage.workItemId))
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
      workItemId: stage.workItemId,
      expectedDraftId: stage.draftId,
      targetColumnKey: "published",
      actorUserId: stage.stagedByUserId,
      reason: `Durable Controlled Publish run #${input.runId} delivered a provider receipt.`,
      idempotencyKey: `editorial-published:${input.runId}:${stage.id}`,
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
    stageId: stage.id,
    workItemId: stage.workItemId,
    episodeId: stage.episodeId,
    publishRunId: input.runId,
    providerReceipt: item.providerReceipt,
  };
}
