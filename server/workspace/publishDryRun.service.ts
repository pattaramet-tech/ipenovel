import { and, asc, eq } from "drizzle-orm";
import {
  workspaceAiArtifacts,
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceCheckerRuns,
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspacePublishingDestinations,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { WorkspaceRole } from "./domain";
import {
  buildPublishDryRunIdempotencyKey,
  buildPublishOutboxEnvelopeContract,
  derivePublishRetryPlan,
  type PublishDryRunItemInput,
  type PublishObservedItemResult,
} from "./publishDryRun.domain";

export class WorkspacePublishDryRunError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS"
      | "DESTINATION_NOT_FOUND"
      | "DESTINATION_CONFLICT"
      | "SNAPSHOT_NOT_BOUND"
      | "CHECKER_RUN_INVALID"
      | "STALE_PUBLISH_HASH"
      | "PUBLISH_RUN_NOT_FOUND"
      | "PUBLISH_PLAN_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishDryRunError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspacePublishDryRunError("DATABASE_UNAVAILABLE", "Workspace publish database is unavailable.");
  return db;
}

function isDuplicateKey(error: unknown) {
  const value = error as any;
  return value?.code === "ER_DUP_ENTRY" || value?.errno === 1062 || value?.cause?.code === "ER_DUP_ENTRY" || value?.cause?.errno === 1062;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) throw new WorkspacePublishDryRunError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  return membership as { role: WorkspaceRole };
}

function requireEditor(role: WorkspaceRole) {
  if (role !== "owner" && role !== "editor") {
    throw new WorkspacePublishDryRunError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required.");
  }
}

async function requireSheetsPublishOwnership(db: any, workspaceNovelId: number) {
  const rows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (rows.length !== 1 || rows[0].owner !== "sheets" || rows[0].cutoverEpoch !== 0) {
    throw new WorkspacePublishDryRunError(
      "PUBLISH_OWNERSHIP_AMBIGUOUS",
      "Publish dry-run requires exactly one Sheets-owned publish registry entry at cutover epoch 0."
    );
  }
  return rows[0];
}

function validateItems(items: PublishDryRunItemInput[]) {
  if (items.length === 0 || items.length > 500) {
    throw new WorkspacePublishDryRunError("PUBLISH_PLAN_INVALID", "Publish dry-run requires between 1 and 500 items.");
  }
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.itemKey.trim() || item.itemKey.length > 255 || !/^[a-f0-9]{64}$/i.test(item.sourceSha256)) {
      throw new WorkspacePublishDryRunError("PUBLISH_PLAN_INVALID", "Publish item identity or source hash is invalid.");
    }
    if (keys.has(item.itemKey)) throw new WorkspacePublishDryRunError("PUBLISH_PLAN_INVALID", "Publish item keys must be unique.");
    keys.add(item.itemKey);
  }
}

async function destinationContext(db: any, workspaceId: number, destinationId: number) {
  const [row] = await db.select({ destination: workspacePublishingDestinations, workspaceNovel: workspaceNovels })
    .from(workspacePublishingDestinations)
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(and(
      eq(workspacePublishingDestinations.id, destinationId),
      eq(workspaceNovels.workspaceId, workspaceId)
    )).limit(1);
  if (!row) throw new WorkspacePublishDryRunError("DESTINATION_NOT_FOUND", "Publish destination was not found in this workspace.");
  return row;
}

async function readAdvisoryInputs(db: any, snapshotId: number) {
  const checkerRuns = await db.select().from(workspaceCheckerRuns)
    .where(eq(workspaceCheckerRuns.snapshotId, snapshotId))
    .orderBy(asc(workspaceCheckerRuns.id));
  const aiRows = await db.select({ job: workspaceAiJobs, attempt: workspaceAiJobAttempts, artifact: workspaceAiArtifacts })
    .from(workspaceAiJobs)
    .innerJoin(workspaceAiJobAttempts, eq(workspaceAiJobAttempts.jobId, workspaceAiJobs.id))
    .innerJoin(workspaceAiArtifacts, eq(workspaceAiArtifacts.attemptId, workspaceAiJobAttempts.id))
    .where(and(
      eq(workspaceAiJobs.snapshotId, snapshotId),
      eq(workspaceAiJobs.status, "succeeded"),
      eq(workspaceAiJobAttempts.status, "succeeded"),
      eq(workspaceAiArtifacts.artifactType, "qc_findings_v1")
    ));
  return {
    checkerRuns: checkerRuns.map((run: any) => ({ id: run.id, status: run.status, engineVersion: run.engineVersion })),
    aiAdvisoryArtifacts: aiRows.map((row: any) => ({
      jobId: row.job.id,
      attemptId: row.attempt.id,
      artifactId: row.artifact.id,
      contentSha256: row.artifact.contentSha256,
      moderationStatus: row.artifact.moderationStatus,
    })),
  };
}

export async function createPublishDestination(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  targetType: string;
  targetId: number;
  policyVersion: string;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditor(membership.role);
  const [workspaceNovel] = await db.select().from(workspaceNovels).where(and(
    eq(workspaceNovels.id, input.workspaceNovelId),
    eq(workspaceNovels.workspaceId, input.workspaceId)
  )).limit(1);
  if (!workspaceNovel) throw new WorkspacePublishDryRunError("DESTINATION_NOT_FOUND", "Workspace novel was not found.");
  await requireSheetsPublishOwnership(db, workspaceNovel.id);
  if (
    input.targetType !== "novel" ||
    input.targetId !== workspaceNovel.novelId ||
    !input.policyVersion.trim() ||
    input.policyVersion.length > 120
  ) {
    throw new WorkspacePublishDryRunError(
      "DESTINATION_CONFLICT",
      "M05-A dry-run destinations must target the already-bound IpeNovel novel with a versioned policy."
    );
  }
  const existing = await db.select().from(workspacePublishingDestinations).where(and(
    eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovel.id),
    eq(workspacePublishingDestinations.targetType, input.targetType),
    eq(workspacePublishingDestinations.targetId, input.targetId)
  )).limit(1);
  if (existing[0]) return { destination: existing[0], created: false };
  let created = false;
  try {
    await db.insert(workspacePublishingDestinations).values({
      workspaceNovelId: workspaceNovel.id,
      targetType: input.targetType,
      targetId: input.targetId,
      policyVersion: input.policyVersion,
    });
    created = true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  const [destination] = await db.select().from(workspacePublishingDestinations).where(and(
    eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovel.id),
    eq(workspacePublishingDestinations.targetType, input.targetType),
    eq(workspacePublishingDestinations.targetId, input.targetId)
  )).limit(1);
  if (!destination) throw new WorkspacePublishDryRunError("DATABASE_UNAVAILABLE", "Publish destination could not be resolved after persistence.");
  return { destination, created };
}

export async function listPublishDestinations(input: { actorUserId: number; workspaceId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  return db.select({ destination: workspacePublishingDestinations, workspaceNovel: workspaceNovels })
    .from(workspacePublishingDestinations)
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(eq(workspaceNovels.workspaceId, input.workspaceId))
    .orderBy(asc(workspacePublishingDestinations.id));
}

export async function createPublishDryRun(input: {
  actorUserId: number;
  workspaceId: number;
  destinationId: number;
  snapshotId: number;
  checkerRunId?: number;
  expectedLastPublishedSha256?: string;
  items: PublishDryRunItemInput[];
}) {
  validateItems(input.items);
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditor(membership.role);
  const context = await destinationContext(db, input.workspaceId, input.destinationId);
  if (context.destination.status !== "active") throw new WorkspacePublishDryRunError("DESTINATION_CONFLICT", "Publish destination is not active.");
  await requireSheetsPublishOwnership(db, context.workspaceNovel.id);

  const [source] = await db.select({ snapshot: workspaceDocumentSnapshots, binding: workspaceDocumentBindings, fingerprint: workspaceDocumentFingerprints })
    .from(workspaceDocumentSnapshots)
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentBindings.documentId, workspaceDocumentSnapshots.documentId))
    .innerJoin(workspaceDocumentFingerprints, eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id))
    .where(and(
      eq(workspaceDocumentSnapshots.id, input.snapshotId),
      eq(workspaceDocumentBindings.workspaceNovelId, context.workspaceNovel.id),
      eq(workspaceDocumentBindings.status, "active")
    )).limit(1);
  if (!source) throw new WorkspacePublishDryRunError("SNAPSHOT_NOT_BOUND", "Snapshot is not actively bound to this publish destination.");

  const expectedHash = input.expectedLastPublishedSha256?.toLowerCase() ?? null;
  const actualHash = source.fingerprint.lastPublishedSha256?.toLowerCase() ?? null;
  if (expectedHash !== actualHash) {
    throw new WorkspacePublishDryRunError("STALE_PUBLISH_HASH", "Expected last-published hash does not match the current destination fingerprint.");
  }

  if (input.checkerRunId) {
    const [checker] = await db.select().from(workspaceCheckerRuns).where(and(
      eq(workspaceCheckerRuns.id, input.checkerRunId),
      eq(workspaceCheckerRuns.snapshotId, input.snapshotId)
    )).limit(1);
    if (!checker || checker.status !== "passed") {
      throw new WorkspacePublishDryRunError("CHECKER_RUN_INVALID", "Publish dry-run checker input must be a passed run for the same snapshot.");
    }
  }

  const idempotencyKey = buildPublishDryRunIdempotencyKey({
    destinationId: context.destination.id,
    snapshotId: input.snapshotId,
    checkerRunId: input.checkerRunId,
    policyVersion: context.destination.policyVersion,
    expectedLastPublishedSha256: input.expectedLastPublishedSha256,
    items: input.items,
  });
  const existing = await db.select().from(workspacePublishRuns).where(and(
    eq(workspacePublishRuns.destinationId, context.destination.id),
    eq(workspacePublishRuns.idempotencyKey, idempotencyKey)
  )).limit(1);
  if (existing[0]) return { ...(await getPublishRunDetail({ actorUserId: input.actorUserId, workspaceId: input.workspaceId, runId: existing[0].id })), created: false };

  const now = new Date();
  let runId: number | undefined;
  let created = false;
  try {
    runId = await db.transaction(async (tx: any) => {
      const result = await tx.insert(workspacePublishRuns).values({
        destinationId: context.destination.id,
        snapshotId: input.snapshotId,
        checkerRunId: input.checkerRunId,
        status: "ready",
        idempotencyKey,
        expectedLastPublishedSha256: input.expectedLastPublishedSha256?.toLowerCase(),
        startedAt: now,
        finishedAt: now,
      });
      const id = Number(result?.[0]?.insertId ?? result?.insertId);
      await tx.insert(workspacePublishItems).values(input.items.map(item => ({
        runId: id,
        itemKey: item.itemKey,
        episodeId: item.episodeId,
        sourceSha256: item.sourceSha256.toLowerCase(),
        status: "pending" as const,
      })));
      return id;
    });
    created = true;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  if (!runId) {
    const [resolved] = await db.select().from(workspacePublishRuns).where(and(
      eq(workspacePublishRuns.destinationId, context.destination.id),
      eq(workspacePublishRuns.idempotencyKey, idempotencyKey)
    )).limit(1);
    runId = resolved?.id;
  }
  if (!runId) throw new WorkspacePublishDryRunError("DATABASE_UNAVAILABLE", "Publish dry-run could not be resolved after persistence.");
  return { ...(await getPublishRunDetail({ actorUserId: input.actorUserId, workspaceId: input.workspaceId, runId })), created };
}

export async function getPublishRunDetail(input: { actorUserId: number; workspaceId: number; runId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const [row] = await db.select({ run: workspacePublishRuns, destination: workspacePublishingDestinations, workspaceNovel: workspaceNovels })
    .from(workspacePublishRuns)
    .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(and(eq(workspacePublishRuns.id, input.runId), eq(workspaceNovels.workspaceId, input.workspaceId))).limit(1);
  if (!row) throw new WorkspacePublishDryRunError("PUBLISH_RUN_NOT_FOUND", "Publish run was not found.");
  const items = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, row.run.id)).orderBy(asc(workspacePublishItems.id));
  const outbox = await db.select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, row.run.id)).orderBy(asc(workspaceOutbox.id));
  const advisoryInputs = await readAdvisoryInputs(db, row.run.snapshotId);
  return {
    ...row,
    items,
    outbox,
    advisoryInputs,
    outboxContract: buildPublishOutboxEnvelopeContract({
      workspaceId: input.workspaceId,
      publishRunId: row.run.id,
      destinationId: row.destination.id,
      idempotencyKey: row.run.idempotencyKey,
    }),
  };
}

export async function previewPublishReconciliation(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  observedResults: PublishObservedItemResult[];
}) {
  const detail = await getPublishRunDetail({ actorUserId: input.actorUserId, workspaceId: input.workspaceId, runId: input.runId });
  const plannedItems = detail.items.map(item => ({ itemKey: item.itemKey, episodeId: item.episodeId ?? undefined, sourceSha256: item.sourceSha256 }));
  return {
    runId: detail.run.id,
    ...derivePublishRetryPlan({ plannedItems, observedResults: input.observedResults }),
    sideEffectsApplied: false as const,
  };
}
