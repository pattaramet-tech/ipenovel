import { and, asc, eq } from "drizzle-orm";
import {
  workspaceAiArtifacts,
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceCheckerRuns,
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceMigrationRegistry,
  workspaceNovels,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspacePublishingDestinations,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { requireWorkspacePlatformAdmin } from "./adminAccess";
import {
  buildPublishCutoverRehearsal,
  buildPublishReadinessDigest,
  derivePublishCutoverItemPlan,
  type PublishCutoverBlocker,
} from "./publishCutover.domain";

export class WorkspacePublishCutoverError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "PUBLISH_RUN_NOT_FOUND"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishCutoverError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspacePublishCutoverError("DATABASE_UNAVAILABLE", "Workspace publish cutover database is unavailable.");
  return db;
}


async function loadRunContext(db: any, workspaceId: number, runId: number) {
  const [row] = await db.select({
    run: workspacePublishRuns,
    destination: workspacePublishingDestinations,
    workspaceNovel: workspaceNovels,
  })
    .from(workspacePublishRuns)
    .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(and(eq(workspacePublishRuns.id, runId), eq(workspaceNovels.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new WorkspacePublishCutoverError("PUBLISH_RUN_NOT_FOUND", "Publish run was not found in this workspace.");
  return row;
}

async function requireSheetsOwnership(db: any, workspaceNovelId: number) {
  const rows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (rows.length !== 1 || rows[0].owner !== "sheets" || rows[0].cutoverEpoch !== 0) {
    throw new WorkspacePublishCutoverError(
      "PUBLISH_OWNERSHIP_AMBIGUOUS",
      "Publish readiness requires exactly one Sheets-owned publish registry row at cutover epoch 0."
    );
  }
  return rows[0];
}

async function readAiAdvisory(db: any, snapshotId: number) {
  const rows = await db.select({ job: workspaceAiJobs, attempt: workspaceAiJobAttempts, artifact: workspaceAiArtifacts })
    .from(workspaceAiJobs)
    .innerJoin(workspaceAiJobAttempts, eq(workspaceAiJobAttempts.jobId, workspaceAiJobs.id))
    .innerJoin(workspaceAiArtifacts, eq(workspaceAiArtifacts.attemptId, workspaceAiJobAttempts.id))
    .where(and(
      eq(workspaceAiJobs.snapshotId, snapshotId),
      eq(workspaceAiJobs.status, "succeeded"),
      eq(workspaceAiJobAttempts.status, "succeeded"),
      eq(workspaceAiArtifacts.artifactType, "qc_findings_v1")
    ));
  return rows.map((row: any) => ({
    jobId: row.job.id,
    attemptId: row.attempt.id,
    artifactId: row.artifact.id,
    moderationStatus: row.artifact.moderationStatus,
    contentSha256: row.artifact.contentSha256,
  })).sort((a: any, b: any) => a.artifactId - b.artifactId);
}

export async function getPublishCutoverReadiness(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
}) {
  const db = await database();
  await requireWorkspacePlatformAdmin(db, input.actorUserId);
  const context = await loadRunContext(db, input.workspaceId, input.runId);
  const ownership = await requireSheetsOwnership(db, context.workspaceNovel.id);

  const [source] = await db.select({ snapshot: workspaceDocumentSnapshots, binding: workspaceDocumentBindings, fingerprint: workspaceDocumentFingerprints })
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
  const aiAdvisoryArtifacts = await readAiAdvisory(db, context.run.snapshotId);
  const items = await db.select().from(workspacePublishItems)
    .where(eq(workspacePublishItems.runId, context.run.id))
    .orderBy(asc(workspacePublishItems.id));
  const outbox = await db.select().from(workspaceOutbox)
    .where(eq(workspaceOutbox.publishRunId, context.run.id))
    .orderBy(asc(workspaceOutbox.id));

  const expectedHash = context.run.expectedLastPublishedSha256?.toLowerCase() ?? null;
  const currentHash = source?.fingerprint.lastPublishedSha256?.toLowerCase() ?? null;
  const staleHash = !source || expectedHash !== currentHash;
  const itemPlan = derivePublishCutoverItemPlan(items.map((item: any) => ({
    itemKey: item.itemKey,
    status: item.status,
    providerReceipt: item.providerReceipt,
    sourceSha256: item.sourceSha256,
  })));
  const backlog = outbox.filter((row: any) => row.status !== "delivered");

  const blockers: PublishCutoverBlocker[] = [];
  if (context.destination.status !== "active") blockers.push("DESTINATION_INACTIVE");
  if (!source) blockers.push("SNAPSHOT_NOT_BOUND");
  if (staleHash) blockers.push("STALE_LAST_PUBLISHED_HASH");
  if (context.run.checkerRunId && (!checker || checker.snapshotId !== context.run.snapshotId || checker.status !== "passed")) {
    blockers.push("CHECKER_NOT_PASSED");
  }
  if (items.length === 0) blockers.push("EMPTY_PUBLISH_RUN");
  if (itemPlan.retry.length > 0) blockers.push("UNRESOLVED_PUBLISH_ITEMS");
  if (itemPlan.publishedMissingReceipt.length > 0) blockers.push("PUBLISHED_ITEM_MISSING_RECEIPT");
  if (backlog.length > 0) blockers.push("OUTBOX_BACKLOG_PRESENT");

  const readinessDigest = buildPublishReadinessDigest({
    workspaceId: input.workspaceId,
    workspaceNovelId: context.workspaceNovel.id,
    runId: context.run.id,
    destination: {
      id: context.destination.id,
      status: context.destination.status,
      policyVersion: context.destination.policyVersion,
      targetType: context.destination.targetType,
      targetId: context.destination.targetId,
    },
    snapshotId: context.run.snapshotId,
    expectedHash,
    currentHash,
    checker: checker ? { id: checker.id, snapshotId: checker.snapshotId, status: checker.status, engineVersion: checker.engineVersion } : null,
    aiAdvisoryArtifacts,
    succeeded: itemPlan.succeeded,
    retry: itemPlan.retry,
    skipped: itemPlan.skipped,
    publishedMissingReceipt: itemPlan.publishedMissingReceipt,
    outbox: outbox.map((row: any) => ({ id: row.id, status: row.status, attempts: row.attempts })),
    blockers: [...blockers].sort(),
  });

  return {
    readOnly: true as const,
    readyForSyntheticCutover: blockers.length === 0,
    readinessDigest,
    blockers,
    ownership: {
      id: ownership.id,
      owner: ownership.owner,
      cutoverEpoch: ownership.cutoverEpoch,
      version: ownership.version,
    },
    workspaceNovel: context.workspaceNovel,
    destination: context.destination,
    run: context.run,
    snapshot: source?.snapshot ?? null,
    fingerprint: source?.fingerprint ?? null,
    staleHash,
    checker: checker ? {
      id: checker.id,
      snapshotId: checker.snapshotId,
      status: checker.status,
      engineVersion: checker.engineVersion,
    } : null,
    aiAdvisory: {
      blocking: false as const,
      acceptedCount: aiAdvisoryArtifacts.filter((artifact: any) => artifact.moderationStatus === "accepted").length,
      artifacts: aiAdvisoryArtifacts,
    },
    itemSummary: {
      total: items.length,
      succeededWithReceipt: itemPlan.succeeded.length,
      retryCandidates: itemPlan.retry.length,
      skipped: itemPlan.skipped.length,
      publishedMissingReceipt: itemPlan.publishedMissingReceipt.length,
    },
    items,
    outboxSummary: {
      total: outbox.length,
      backlog: backlog.length,
      statuses: outbox.map((row: any) => row.status),
    },
    outbox,
  };
}

export async function rehearsePublishCutoverRollback(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
}) {
  const readiness = await getPublishCutoverReadiness(input);
  const rehearsal = buildPublishCutoverRehearsal({
    workspaceId: input.workspaceId,
    workspaceNovelId: readiness.workspaceNovel.id,
    publishRunId: readiness.run.id,
    currentOwner: "sheets",
    currentEpoch: readiness.ownership.cutoverEpoch,
    readinessDigest: readiness.readinessDigest,
    blockers: readiness.blockers,
    items: readiness.items.map((item: any) => ({
      itemKey: item.itemKey,
      status: item.status,
      providerReceipt: item.providerReceipt,
      sourceSha256: item.sourceSha256,
    })),
  });
  return {
    readiness,
    rehearsal,
    registryMutationApplied: false as const,
    publishDeliveryApplied: false as const,
  };
}
