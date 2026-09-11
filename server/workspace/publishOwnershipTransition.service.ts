import { and, asc, eq, sql } from "drizzle-orm";
import {
  workspaceAuditEvents,
  workspaceCheckerRuns,
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceNovels,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishOwnershipTransitions,
  workspacePublishRuns,
  workspacePublishingDestinations,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { WorkspaceRole } from "./domain";
import { buildPublishReadinessDigest } from "./publishCutover.domain";
import { getPublishCutoverReadiness } from "./publishCutover.service";
import {
  buildPublishOwnershipTransitionIdempotencyKey,
  transitionTarget,
  type PublishOwnershipDirection,
  type PublishOwnershipOwner,
} from "./publishOwnershipTransition.domain";

export class WorkspacePublishOwnershipTransitionError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "PUBLISH_RUN_NOT_FOUND"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS"
      | "PUBLISH_OWNERSHIP_CONFLICT"
      | "PUBLISH_READINESS_BLOCKED"
      | "STALE_PUBLISH_HASH",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishOwnershipTransitionError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspacePublishOwnershipTransitionError("DATABASE_UNAVAILABLE", "Workspace publish ownership database is unavailable.");
  return db;
}

async function requireEditor(db: any, workspaceId: number, userId: number) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) throw new WorkspacePublishOwnershipTransitionError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  if (membership.role !== "owner" && membership.role !== "editor") {
    throw new WorkspacePublishOwnershipTransitionError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required for publish ownership changes.");
  }
  return membership as { role: WorkspaceRole };
}

async function loadRunContext(db: any, workspaceId: number, runId: number) {
  const [row] = await db.select({
    run: workspacePublishRuns,
    destination: workspacePublishingDestinations,
    workspaceNovel: workspaceNovels,
  }).from(workspacePublishRuns)
    .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(and(eq(workspacePublishRuns.id, runId), eq(workspaceNovels.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new WorkspacePublishOwnershipTransitionError("PUBLISH_RUN_NOT_FOUND", "Publish run was not found in this workspace.");
  return row;
}

async function readCriticalReadiness(db: any, context: any) {
  const [source] = await db.select({ fingerprint: workspaceDocumentFingerprints })
    .from(workspaceDocumentSnapshots)
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentBindings.documentId, workspaceDocumentSnapshots.documentId))
    .innerJoin(workspaceDocumentFingerprints, eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id))
    .where(and(
      eq(workspaceDocumentSnapshots.id, context.run.snapshotId),
      eq(workspaceDocumentBindings.workspaceNovelId, context.workspaceNovel.id),
      eq(workspaceDocumentBindings.status, "active")
    )).limit(1);
  const checker = context.run.checkerRunId
    ? (await db.select().from(workspaceCheckerRuns).where(eq(workspaceCheckerRuns.id, context.run.checkerRunId)).limit(1))[0]
    : undefined;
  const items = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, context.run.id)).orderBy(asc(workspacePublishItems.id));
  const outbox = await db.select().from(workspaceOutbox).where(eq(workspaceOutbox.publishRunId, context.run.id)).orderBy(asc(workspaceOutbox.id));
  const expectedHash = context.run.expectedLastPublishedSha256?.toLowerCase() ?? null;
  const currentHash = source?.fingerprint.lastPublishedSha256?.toLowerCase() ?? null;
  const unresolvedItems = items.filter((item: any) => item.status !== "published" && item.status !== "skipped");
  const publishedMissingReceipt = items.filter((item: any) => item.status === "published" && !item.providerReceipt?.trim());
  const backlog = outbox.filter((row: any) => row.status !== "delivered");
  const blockers: string[] = [];
  if (context.destination.status !== "active") blockers.push("DESTINATION_INACTIVE");
  if (!source) blockers.push("SNAPSHOT_NOT_BOUND");
  if (!source || expectedHash !== currentHash) blockers.push("STALE_LAST_PUBLISHED_HASH");
  if (context.run.checkerRunId && (!checker || checker.snapshotId !== context.run.snapshotId || checker.status !== "passed")) blockers.push("CHECKER_NOT_PASSED");
  if (items.length === 0) blockers.push("EMPTY_PUBLISH_RUN");
  if (unresolvedItems.length > 0) blockers.push("UNRESOLVED_PUBLISH_ITEMS");
  if (publishedMissingReceipt.length > 0) blockers.push("PUBLISHED_ITEM_MISSING_RECEIPT");
  if (backlog.length > 0) blockers.push("OUTBOX_BACKLOG_PRESENT");
  const digest = buildPublishReadinessDigest({
    workspaceNovelId: context.workspaceNovel.id,
    publishRunId: context.run.id,
    destinationId: context.destination.id,
    destinationStatus: context.destination.status,
    snapshotId: context.run.snapshotId,
    checkerRunId: context.run.checkerRunId ?? null,
    expectedHash,
    currentHash,
    items: items.map((item: any) => ({ itemKey: item.itemKey, status: item.status, providerReceipt: item.providerReceipt ?? null, sourceSha256: item.sourceSha256 })),
    outbox: outbox.map((row: any) => ({ id: row.id, status: row.status, attempts: row.attempts })),
    blockers: [...blockers].sort(),
  });
  return { blockers, digest, items, outbox };
}

async function performTransition(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  direction: PublishOwnershipDirection;
  expectedOwner: PublishOwnershipOwner;
  expectedCutoverEpoch: number;
  expectedVersion: number;
}) {
  const db = await database();
  await requireEditor(db, input.workspaceId, input.actorUserId);
  const context = await loadRunContext(db, input.workspaceId, input.runId);
  const [replayed] = await db.select().from(workspacePublishOwnershipTransitions).where(and(
    eq(workspacePublishOwnershipTransitions.workspaceNovelId, context.workspaceNovel.id),
    eq(workspacePublishOwnershipTransitions.publishRunId, context.run.id),
    eq(workspacePublishOwnershipTransitions.direction, input.direction),
    eq(workspacePublishOwnershipTransitions.fromOwner, input.expectedOwner),
    eq(workspacePublishOwnershipTransitions.fromEpoch, input.expectedCutoverEpoch),
    eq(workspacePublishOwnershipTransitions.fromVersion, input.expectedVersion)
  )).limit(1);
  if (replayed) {
    const [ownership] = await db.select().from(workspaceMigrationRegistry).where(and(
      eq(workspaceMigrationRegistry.workspaceNovelId, context.workspaceNovel.id),
      eq(workspaceMigrationRegistry.capability, "publish")
    )).limit(1);
    return { transition: replayed, ownership, created: false };
  }

  let m05cDigest: string | undefined;
  if (input.direction === "cutover") {
    const readiness = await getPublishCutoverReadiness({ actorUserId: input.actorUserId, workspaceId: input.workspaceId, runId: input.runId });
    if (!readiness.readyForSyntheticCutover) {
      throw new WorkspacePublishOwnershipTransitionError("PUBLISH_READINESS_BLOCKED", `Publish cutover readiness is blocked: ${readiness.blockers.join(", ")}`);
    }
    m05cDigest = readiness.readinessDigest;
  }

  return db.transaction(async (tx: any) => {
    const rows = await tx.select().from(workspaceMigrationRegistry).where(and(
      eq(workspaceMigrationRegistry.workspaceNovelId, context.workspaceNovel.id),
      eq(workspaceMigrationRegistry.capability, "publish")
    )).for("update");
    if (rows.length !== 1) {
      throw new WorkspacePublishOwnershipTransitionError("PUBLISH_OWNERSHIP_AMBIGUOUS", "Publish ownership requires exactly one migration registry row.");
    }
    const ownership = rows[0];
    const target = transitionTarget(input.direction, input.expectedCutoverEpoch);
    const readiness = await readCriticalReadiness(tx, context);
    if (readiness.blockers.length > 0) {
      throw new WorkspacePublishOwnershipTransitionError("PUBLISH_READINESS_BLOCKED", `Publish ownership transition is blocked: ${readiness.blockers.join(", ")}`);
    }
    const readinessDigest = input.direction === "cutover" ? m05cDigest! : readiness.digest;
    const idempotencyKey = buildPublishOwnershipTransitionIdempotencyKey({
      workspaceId: input.workspaceId,
      workspaceNovelId: context.workspaceNovel.id,
      publishRunId: context.run.id,
      direction: input.direction,
      fromOwner: input.expectedOwner,
      toOwner: target.toOwner,
      fromEpoch: input.expectedCutoverEpoch,
      toEpoch: target.toEpoch,
      fromVersion: input.expectedVersion,
      readinessDigest,
    });
    const [existing] = await tx.select().from(workspacePublishOwnershipTransitions).where(and(
      eq(workspacePublishOwnershipTransitions.workspaceNovelId, context.workspaceNovel.id),
      eq(workspacePublishOwnershipTransitions.idempotencyKey, idempotencyKey)
    )).limit(1);
    if (existing) return { transition: existing, ownership, created: false };

    if (
      ownership.owner !== input.expectedOwner ||
      ownership.cutoverEpoch !== input.expectedCutoverEpoch ||
      ownership.version !== input.expectedVersion ||
      ownership.owner !== target.fromOwner
    ) {
      throw new WorkspacePublishOwnershipTransitionError("PUBLISH_OWNERSHIP_CONFLICT", "Publish ownership changed from the caller's expected owner/epoch/version.");
    }
    if (input.direction === "cutover" && (ownership.owner !== "sheets" || ownership.cutoverEpoch !== 0)) {
      throw new WorkspacePublishOwnershipTransitionError("PUBLISH_OWNERSHIP_CONFLICT", "Initial publish cutover must transition Sheets epoch 0 to Workspace epoch 1.");
    }

    const updated = await tx.update(workspaceMigrationRegistry).set({
      owner: target.toOwner,
      cutoverEpoch: target.toEpoch,
      version: sql`${workspaceMigrationRegistry.version} + 1`,
      changedBy: input.actorUserId,
      changedAt: new Date(),
    }).where(and(
      eq(workspaceMigrationRegistry.id, ownership.id),
      eq(workspaceMigrationRegistry.owner, input.expectedOwner),
      eq(workspaceMigrationRegistry.cutoverEpoch, input.expectedCutoverEpoch),
      eq(workspaceMigrationRegistry.version, input.expectedVersion)
    ));
    const affected = Number(updated?.[0]?.affectedRows ?? updated?.affectedRows ?? 0);
    if (affected !== 1) throw new WorkspacePublishOwnershipTransitionError("PUBLISH_OWNERSHIP_CONFLICT", "Publish ownership CAS was lost.");

    const insert = await tx.insert(workspacePublishOwnershipTransitions).values({
      workspaceId: input.workspaceId,
      workspaceNovelId: context.workspaceNovel.id,
      publishRunId: context.run.id,
      direction: input.direction,
      fromOwner: input.expectedOwner,
      toOwner: target.toOwner,
      fromEpoch: input.expectedCutoverEpoch,
      toEpoch: target.toEpoch,
      fromVersion: input.expectedVersion,
      toVersion: input.expectedVersion + 1,
      readinessDigest,
      idempotencyKey,
      actorUserId: input.actorUserId,
    });
    const transitionId = Number(insert?.[0]?.insertId ?? insert?.insertId);
    await tx.insert(workspaceAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: input.direction === "cutover" ? "publish.ownership.cutover" : "publish.ownership.rollback",
      entityType: "workspaceNovel",
      entityId: String(context.workspaceNovel.id),
      correlationId: idempotencyKey,
      metadataJson: JSON.stringify({
        contract: "workspace-publish-ownership-transition-v1",
        publishRunId: context.run.id,
        fromOwner: input.expectedOwner,
        toOwner: target.toOwner,
        fromEpoch: input.expectedCutoverEpoch,
        toEpoch: target.toEpoch,
        fromVersion: input.expectedVersion,
        toVersion: input.expectedVersion + 1,
        readinessDigest,
      }),
    });
    const [transition] = await tx.select().from(workspacePublishOwnershipTransitions).where(eq(workspacePublishOwnershipTransitions.id, transitionId)).limit(1);
    const [nextOwnership] = await tx.select().from(workspaceMigrationRegistry).where(eq(workspaceMigrationRegistry.id, ownership.id)).limit(1);
    return { transition, ownership: nextOwnership, created: true };
  });
}

export function cutoverPublishOwnership(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  expectedOwner: "sheets";
  expectedCutoverEpoch: 0;
  expectedVersion: number;
}) {
  return performTransition({ ...input, direction: "cutover" });
}

export function rollbackPublishOwnership(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  expectedOwner: "workspace";
  expectedCutoverEpoch: number;
  expectedVersion: number;
}) {
  return performTransition({ ...input, direction: "rollback" });
}
