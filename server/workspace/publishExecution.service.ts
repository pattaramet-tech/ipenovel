import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceNovels,
  workspaceOutbox,
  workspacePublishItems,
  workspacePublishRuns,
  workspacePublishingDestinations,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { WorkspaceRole } from "./domain";
import {
  buildPublishItemRequestKey,
  buildPublishOutboxIdempotencyKey,
  buildPublishOutboxObjectKey,
  WORKSPACE_PUBLISH_OUTBOX_EVENT,
  type WorkspacePublishProvider,
  type WorkspacePublishProviderRequest,
  type WorkspacePublishProviderResult,
} from "./publishExecution.domain";

export class WorkspacePublishExecutionError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "EXECUTION_DISABLED"
      | "EXTERNAL_PROVIDER_DISABLED"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS"
      | "PUBLISH_RUN_NOT_FOUND"
      | "PUBLISH_RUN_CONFLICT"
      | "STALE_PUBLISH_HASH"
      | "OUTBOX_NOT_FOUND"
      | "OUTBOX_CONFLICT"
      | "OUTBOX_LEASE_INVALID"
      | "PROVIDER_CONTRACT_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishExecutionError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspacePublishExecutionError("DATABASE_UNAVAILABLE", "Workspace publish database is unavailable.");
  return db;
}

function affectedRows(result: any): number {
  return Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0);
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) throw new WorkspacePublishExecutionError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  return membership as { role: WorkspaceRole };
}

function requireEditor(role: WorkspaceRole) {
  if (role !== "owner" && role !== "editor") {
    throw new WorkspacePublishExecutionError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required.");
  }
}

async function requireSheetsPublishOwnership(db: any, workspaceNovelId: number) {
  const rows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (rows.length !== 1 || rows[0].owner !== "sheets" || rows[0].cutoverEpoch !== 0) {
    throw new WorkspacePublishExecutionError(
      "PUBLISH_OWNERSHIP_AMBIGUOUS",
      "Publish execution requires exactly one Sheets-owned publish registry entry at cutover epoch 0."
    );
  }
}

async function loadRunContext(db: any, workspaceId: number, runId: number, forUpdate = false) {
  let query = db.select({
    run: workspacePublishRuns,
    destination: workspacePublishingDestinations,
    workspaceNovel: workspaceNovels,
  })
    .from(workspacePublishRuns)
    .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
    .innerJoin(workspaceNovels, eq(workspacePublishingDestinations.workspaceNovelId, workspaceNovels.id))
    .where(and(eq(workspacePublishRuns.id, runId), eq(workspaceNovels.workspaceId, workspaceId)))
    .limit(1);
  if (forUpdate) query = query.for("update");
  const [row] = await query;
  if (!row) throw new WorkspacePublishExecutionError("PUBLISH_RUN_NOT_FOUND", "Publish run was not found.");
  return row;
}

async function assertCurrentPublishHash(db: any, workspaceNovelId: number, snapshotId: number, expectedLastPublishedSha256: string | null) {
  const [source] = await db.select({ fingerprint: workspaceDocumentFingerprints })
    .from(workspaceDocumentSnapshots)
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentBindings.documentId, workspaceDocumentSnapshots.documentId))
    .innerJoin(workspaceDocumentFingerprints, eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id))
    .where(and(
      eq(workspaceDocumentSnapshots.id, snapshotId),
      eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovelId),
      eq(workspaceDocumentBindings.status, "active")
    )).limit(1);
  const current = source?.fingerprint.lastPublishedSha256?.toLowerCase() ?? null;
  const expected = expectedLastPublishedSha256?.toLowerCase() ?? null;
  if (!source || current !== expected) {
    throw new WorkspacePublishExecutionError("STALE_PUBLISH_HASH", "Expected last-published hash is stale at execution time.");
  }
}

export async function requestPublishExecution(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  executionEnabled: boolean;
}) {
  if (!input.executionEnabled) {
    throw new WorkspacePublishExecutionError("EXECUTION_DISABLED", "Workspace publish execution is not enabled by server configuration.");
  }
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditor(membership.role);

  return db.transaction(async (tx: any) => {
    const context = await loadRunContext(tx, input.workspaceId, input.runId, true);
    await requireSheetsPublishOwnership(tx, context.workspaceNovel.id);
    if (context.destination.status !== "active") {
      throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish destination is not active.");
    }
    await assertCurrentPublishHash(tx, context.workspaceNovel.id, context.run.snapshotId, context.run.expectedLastPublishedSha256 ?? null);

    if (context.run.status !== "ready" && context.run.status !== "partially_failed" && context.run.status !== "failed" && context.run.status !== "publishing") {
      throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", `Publish run cannot execute from status ${context.run.status}.`);
    }

    const outboxIdempotencyKey = buildPublishOutboxIdempotencyKey(context.run.id, context.run.idempotencyKey);
    const [existing] = await tx.select().from(workspaceOutbox).where(and(
      eq(workspaceOutbox.eventType, WORKSPACE_PUBLISH_OUTBOX_EVENT),
      eq(workspaceOutbox.idempotencyKey, outboxIdempotencyKey)
    )).limit(1).for("update");

    if (!existing) {
      const runUpdate = await tx.update(workspacePublishRuns).set({
        status: "publishing",
        finishedAt: null,
        version: sql`${workspacePublishRuns.version} + 1`,
      }).where(and(
        eq(workspacePublishRuns.id, context.run.id),
        eq(workspacePublishRuns.version, context.run.version)
      ));
      if (affectedRows(runUpdate) !== 1) {
        throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish run changed while execution was being enqueued.");
      }
      await tx.insert(workspaceOutbox).values({
        workspaceId: input.workspaceId,
        publishRunId: context.run.id,
        eventType: WORKSPACE_PUBLISH_OUTBOX_EVENT,
        payloadObjectKey: buildPublishOutboxObjectKey(input.workspaceId, context.run.id),
        idempotencyKey: outboxIdempotencyKey,
        status: "pending",
        availableAt: new Date(),
      });
    } else if (
      existing.status === "failed" &&
      (context.run.status === "partially_failed" || context.run.status === "failed")
    ) {
      const retryRunUpdate = await tx.update(workspacePublishRuns).set({
        status: "publishing",
        finishedAt: null,
        version: sql`${workspacePublishRuns.version} + 1`,
      }).where(and(
        eq(workspacePublishRuns.id, context.run.id),
        eq(workspacePublishRuns.version, context.run.version)
      ));
      if (affectedRows(retryRunUpdate) !== 1) {
        throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish run changed while retry execution was being requested.");
      }
    }

    const [outbox] = await tx.select().from(workspaceOutbox).where(and(
      eq(workspaceOutbox.eventType, WORKSPACE_PUBLISH_OUTBOX_EVENT),
      eq(workspaceOutbox.idempotencyKey, outboxIdempotencyKey)
    )).limit(1);
    const [run] = await tx.select().from(workspacePublishRuns).where(eq(workspacePublishRuns.id, context.run.id)).limit(1);
    return { run, outbox, created: !existing };
  });
}

export async function claimPublishOutbox(input: {
  workspaceId: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}) {
  const db = await database();
  const now = new Date();
  const leaseMs = input.leaseExpiresAt.getTime() - now.getTime();
  if (!input.leaseOwner.trim() || leaseMs <= 0 || leaseMs > 5 * 60_000) {
    throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Outbox lease must be future-dated and no longer than five minutes.");
  }
  return db.transaction(async (tx: any) => {
    const [candidate] = await tx.select().from(workspaceOutbox).where(and(
      eq(workspaceOutbox.workspaceId, input.workspaceId),
      eq(workspaceOutbox.eventType, WORKSPACE_PUBLISH_OUTBOX_EVENT),
      sql`${workspaceOutbox.availableAt} <= NOW()`,
      or(
        eq(workspaceOutbox.status, "pending"),
        eq(workspaceOutbox.status, "failed"),
        and(eq(workspaceOutbox.status, "claimed"), sql`${workspaceOutbox.leaseExpiresAt} <= NOW()`)
      )
    )).orderBy(asc(workspaceOutbox.availableAt), asc(workspaceOutbox.id)).limit(1).for("update");
    if (!candidate) return undefined;

    const update = await tx.update(workspaceOutbox).set({
      status: "claimed",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      attempts: sql`${workspaceOutbox.attempts} + 1`,
    }).where(eq(workspaceOutbox.id, candidate.id));
    if (affectedRows(update) !== 1) throw new WorkspacePublishExecutionError("OUTBOX_CONFLICT", "Outbox claim was lost.");
    const [claimed] = await tx.select().from(workspaceOutbox).where(eq(workspaceOutbox.id, candidate.id)).limit(1);
    return claimed;
  });
}

async function persistItemResult(input: {
  db: any;
  itemId: number;
  expectedVersion: number;
  result: WorkspacePublishProviderResult;
}) {
  if (input.result.status === "published") {
    const receipt = input.result.providerReceipt?.trim();
    if (!receipt) {
      throw new WorkspacePublishExecutionError("PROVIDER_CONTRACT_INVALID", "Published provider results require a receipt.");
    }
    const receiptUpdate = await input.db.update(workspacePublishItems).set({
      providerReceipt: receipt,
      errorClass: null,
      version: sql`${workspacePublishItems.version} + 1`,
    }).where(and(
      eq(workspacePublishItems.id, input.itemId),
      eq(workspacePublishItems.version, input.expectedVersion),
      eq(workspacePublishItems.status, "publishing")
    ));
    if (affectedRows(receiptUpdate) !== 1) {
      throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish item changed while recording the provider receipt.");
    }
    const successUpdate = await input.db.update(workspacePublishItems).set({
      status: "published",
      finishedAt: new Date(),
      version: sql`${workspacePublishItems.version} + 1`,
    }).where(and(
      eq(workspacePublishItems.id, input.itemId),
      eq(workspacePublishItems.version, input.expectedVersion + 1),
      eq(workspacePublishItems.providerReceipt, receipt),
      eq(workspacePublishItems.status, "publishing")
    ));
    if (affectedRows(successUpdate) !== 1) {
      throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish item changed after its provider receipt was recorded.");
    }
    return;
  }

  const failureUpdate = await input.db.update(workspacePublishItems).set({
    status: "failed",
    providerReceipt: input.result.providerReceipt?.trim() ?? null,
    errorClass: input.result.errorClass?.trim() ?? "PROVIDER_FAILED",
    finishedAt: new Date(),
    version: sql`${workspacePublishItems.version} + 1`,
  }).where(and(
    eq(workspacePublishItems.id, input.itemId),
    eq(workspacePublishItems.version, input.expectedVersion),
    eq(workspacePublishItems.status, "publishing")
  ));
  if (affectedRows(failureUpdate) !== 1) {
    throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish item changed while recording provider failure.");
  }
}

export async function processClaimedPublishOutbox(input: {
  workspaceId: number;
  outboxId: number;
  leaseOwner: string;
  provider: WorkspacePublishProvider;
  executionEnabled: boolean;
  allowExternalProvider?: boolean;
}) {
  if (!input.executionEnabled) throw new WorkspacePublishExecutionError("EXECUTION_DISABLED", "Workspace publish execution is disabled.");
  if (input.provider.mode === "external" && input.allowExternalProvider !== true) {
    throw new WorkspacePublishExecutionError("EXTERNAL_PROVIDER_DISABLED", "External publish provider requires explicit configuration opt-in.");
  }
  const db = await database();
  const now = new Date();
  const [outbox] = await db.select().from(workspaceOutbox).where(and(
    eq(workspaceOutbox.id, input.outboxId),
    eq(workspaceOutbox.workspaceId, input.workspaceId)
  )).limit(1);
  if (!outbox) throw new WorkspacePublishExecutionError("OUTBOX_NOT_FOUND", "Publish outbox row was not found.");
  if (outbox.status !== "claimed" || outbox.leaseOwner !== input.leaseOwner || !outbox.leaseExpiresAt || outbox.leaseExpiresAt <= now) {
    throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Publish outbox requires the active worker lease.");
  }

  const context = await loadRunContext(db, input.workspaceId, outbox.publishRunId);
  await requireSheetsPublishOwnership(db, context.workspaceNovel.id);
  await assertCurrentPublishHash(db, context.workspaceNovel.id, context.run.snapshotId, context.run.expectedLastPublishedSha256 ?? null);

  const items = await db.select().from(workspacePublishItems)
    .where(eq(workspacePublishItems.runId, context.run.id))
    .orderBy(asc(workspacePublishItems.id));

  try {
    for (const initialItem of items) {
      if (initialItem.status === "published" && initialItem.providerReceipt) continue;
      const [item] = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.id, initialItem.id)).limit(1);
      if (!item || (item.status === "published" && item.providerReceipt)) continue;
      if (item.status === "publishing" && item.providerReceipt) {
        const recovered = await db.update(workspacePublishItems).set({
          status: "published",
          errorClass: null,
          finishedAt: new Date(),
          version: sql`${workspacePublishItems.version} + 1`,
        }).where(and(
          eq(workspacePublishItems.id, item.id),
          eq(workspacePublishItems.version, item.version),
          eq(workspacePublishItems.status, "publishing"),
          eq(workspacePublishItems.providerReceipt, item.providerReceipt)
        ));
        if (affectedRows(recovered) !== 1) {
          throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish item changed while recovering its persisted provider receipt.");
        }
        continue;
      }

      let executionVersion = item.version;
      if (item.status !== "publishing") {
        const publishingUpdate = await db.update(workspacePublishItems).set({
          status: "publishing",
          errorClass: null,
          finishedAt: null,
          version: sql`${workspacePublishItems.version} + 1`,
        }).where(and(
          eq(workspacePublishItems.id, item.id),
          eq(workspacePublishItems.version, item.version)
        ));
        if (affectedRows(publishingUpdate) !== 1) {
          throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish item changed before provider execution.");
        }
        executionVersion += 1;
      }

      const request: WorkspacePublishProviderRequest = {
        requestKey: buildPublishItemRequestKey({
          publishRunId: context.run.id,
          destinationId: context.destination.id,
          policyVersion: context.destination.policyVersion,
          itemKey: item.itemKey,
          episodeId: item.episodeId ?? undefined,
          sourceSha256: item.sourceSha256,
        }),
        workspaceId: input.workspaceId,
        publishRunId: context.run.id,
        destinationId: context.destination.id,
        targetType: context.destination.targetType,
        targetId: context.destination.targetId,
        itemKey: item.itemKey,
        episodeId: item.episodeId ?? undefined,
        sourceSha256: item.sourceSha256,
      };

      const reconciled = await input.provider.reconcile(request);
      const result = reconciled ?? await input.provider.execute(request);
      await persistItemResult({ db, itemId: item.id, expectedVersion: executionVersion, result });
    }

    return await finalizePublishExecution({ workspaceId: input.workspaceId, runId: context.run.id, outboxId: outbox.id, leaseOwner: input.leaseOwner });
  } catch (error) {
    await db.update(workspaceOutbox).set({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: new Date(Date.now() + 1_000),
    }).where(and(
      eq(workspaceOutbox.id, outbox.id),
      eq(workspaceOutbox.status, "claimed"),
      eq(workspaceOutbox.leaseOwner, input.leaseOwner)
    ));
    throw error;
  }
}

export async function finalizePublishExecution(input: {
  workspaceId: number;
  runId: number;
  outboxId: number;
  leaseOwner: string;
}) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    const context = await loadRunContext(tx, input.workspaceId, input.runId, true);
    const [outbox] = await tx.select().from(workspaceOutbox).where(eq(workspaceOutbox.id, input.outboxId)).limit(1).for("update");
    if (!outbox || outbox.status !== "claimed" || outbox.leaseOwner !== input.leaseOwner || !outbox.leaseExpiresAt || outbox.leaseExpiresAt <= new Date()) {
      throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Cannot finalize without the active outbox lease.");
    }
    await requireSheetsPublishOwnership(tx, context.workspaceNovel.id);
    await assertCurrentPublishHash(tx, context.workspaceNovel.id, context.run.snapshotId, context.run.expectedLastPublishedSha256 ?? null);
    const items = await tx.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, input.runId));
    const published = items.filter((item: any) => item.status === "published" && item.providerReceipt).length;
    const failed = items.filter((item: any) => item.status === "failed").length;
    const pending = items.length - published - failed;
    const status = published === items.length && items.length > 0
      ? "published"
      : published > 0
        ? "partially_failed"
        : failed > 0
          ? "failed"
          : "publishing";

    const runUpdate = await tx.update(workspacePublishRuns).set({
      status,
      finishedAt: status === "publishing" ? null : new Date(),
      version: sql`${workspacePublishRuns.version} + 1`,
    }).where(and(eq(workspacePublishRuns.id, context.run.id), eq(workspacePublishRuns.version, context.run.version)));
    if (affectedRows(runUpdate) !== 1) throw new WorkspacePublishExecutionError("PUBLISH_RUN_CONFLICT", "Publish run changed during finalization.");

    await tx.update(workspaceOutbox).set({
      status: status === "published" ? "delivered" : "failed",
      deliveredAt: status === "published" ? new Date() : null,
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: status === "published" ? outbox.availableAt : new Date(Date.now() + 1_000),
    }).where(and(eq(workspaceOutbox.id, outbox.id), eq(workspaceOutbox.status, "claimed"), eq(workspaceOutbox.leaseOwner, input.leaseOwner)));

    return { status, published, failed, pending };
  });
}
