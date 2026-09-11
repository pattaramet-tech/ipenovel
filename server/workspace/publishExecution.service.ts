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
  WORKSPACE_PUBLISH_MAX_ATTEMPTS,
  WORKSPACE_PUBLISH_OUTBOX_EVENT,
  type WorkspacePublishExecutionScope,
  type WorkspacePublishObserver,
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
      | "EXECUTION_SCOPE_MISMATCH"
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

async function requireWorkspacePublishOwnership(
  db: any,
  workspaceNovelId: number,
  expectedEpoch?: number,
  expectedVersion?: number,
  forUpdate = false
) {
  let query = db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (forUpdate) query = query.for("update");
  const rows = await query;
  if (
    rows.length !== 1 ||
    rows[0].owner !== "workspace" ||
    rows[0].cutoverEpoch < 1 ||
    (expectedEpoch !== undefined && rows[0].cutoverEpoch !== expectedEpoch) ||
    (expectedVersion !== undefined && rows[0].version !== expectedVersion)
  ) {
    throw new WorkspacePublishExecutionError(
      "PUBLISH_OWNERSHIP_AMBIGUOUS",
      "Publish execution requires exactly one Workspace-owned publish registry entry at the expected cutover epoch."
    );
  }
  return rows[0];
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

async function assertCurrentPublishHash(
  db: any,
  workspaceNovelId: number,
  snapshotId: number,
  expectedLastPublishedSha256: string | null,
  forUpdate = false
) {
  let query = db.select({ fingerprint: workspaceDocumentFingerprints, snapshot: workspaceDocumentSnapshots })
    .from(workspaceDocumentSnapshots)
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentBindings.documentId, workspaceDocumentSnapshots.documentId))
    .innerJoin(workspaceDocumentFingerprints, eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id))
    .where(and(
      eq(workspaceDocumentSnapshots.id, snapshotId),
      eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovelId),
      eq(workspaceDocumentBindings.status, "active")
    )).limit(1);
  if (forUpdate) query = query.for("update");
  const [source] = await query;
  const current = source?.fingerprint.lastPublishedSha256?.toLowerCase() ?? null;
  const expected = expectedLastPublishedSha256?.toLowerCase() ?? null;
  if (!source || current !== expected) {
    throw new WorkspacePublishExecutionError("STALE_PUBLISH_HASH", "Expected last-published hash is stale at execution time.");
  }
  return source;
}

export async function requestPublishExecution(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  expectedCutoverEpoch: number;
  expectedOwnershipVersion?: number;
  executionScope?: WorkspacePublishExecutionScope;
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
    const scope = input.executionScope;
    if (
      scope && (
        scope.workspaceId !== input.workspaceId ||
        scope.workspaceNovelId !== context.workspaceNovel.id ||
        scope.runId !== input.runId ||
        scope.expectedCutoverEpoch !== input.expectedCutoverEpoch ||
        scope.expectedOwnershipVersion !== input.expectedOwnershipVersion
      )
    ) {
      throw new WorkspacePublishExecutionError("EXECUTION_SCOPE_MISMATCH", "Publish execution is outside the exact configured Workspace/run ownership scope.");
    }
    await requireWorkspacePublishOwnership(
      tx,
      context.workspaceNovel.id,
      input.expectedCutoverEpoch,
      input.expectedOwnershipVersion,
      true
    );
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
        ownershipEpoch: input.expectedCutoverEpoch,
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
  publishRunId?: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  expectedCutoverEpoch?: number;
  expectedOwnershipVersion?: number;
  maxAttempts?: number;
}) {
  const db = await database();
  const now = new Date();
  const leaseMs = input.leaseExpiresAt.getTime() - now.getTime();
  const maxAttempts = input.maxAttempts ?? WORKSPACE_PUBLISH_MAX_ATTEMPTS;
  if (!input.leaseOwner.trim() || leaseMs <= 0 || leaseMs > 5 * 60_000 || maxAttempts < 1 || maxAttempts > 10) {
    throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Outbox lease must be future-dated, no longer than five minutes, with a bounded attempt limit.");
  }
  return db.transaction(async (tx: any) => {
    await tx.update(workspaceOutbox).set({
      status: "dead_letter",
      leaseOwner: null,
      leaseExpiresAt: null,
    }).where(and(
      eq(workspaceOutbox.workspaceId, input.workspaceId),
      input.publishRunId !== undefined ? eq(workspaceOutbox.publishRunId, input.publishRunId) : undefined,
      eq(workspaceOutbox.eventType, WORKSPACE_PUBLISH_OUTBOX_EVENT),
      sql`${workspaceOutbox.attempts} >= ${maxAttempts}`,
      or(
        eq(workspaceOutbox.status, "failed"),
        and(eq(workspaceOutbox.status, "claimed"), sql`${workspaceOutbox.leaseExpiresAt} <= NOW()`)
      )
    ));

    const [candidate] = await tx.select().from(workspaceOutbox).where(and(
      eq(workspaceOutbox.workspaceId, input.workspaceId),
      input.publishRunId !== undefined ? eq(workspaceOutbox.publishRunId, input.publishRunId) : undefined,
      eq(workspaceOutbox.eventType, WORKSPACE_PUBLISH_OUTBOX_EVENT),
      input.expectedCutoverEpoch !== undefined ? eq(workspaceOutbox.ownershipEpoch, input.expectedCutoverEpoch) : undefined,
      sql`${workspaceOutbox.attempts} < ${maxAttempts}`,
      sql`${workspaceOutbox.availableAt} <= NOW()`,
      or(
        eq(workspaceOutbox.status, "pending"),
        eq(workspaceOutbox.status, "failed"),
        and(eq(workspaceOutbox.status, "claimed"), sql`${workspaceOutbox.leaseExpiresAt} <= NOW()`)
      )
    )).orderBy(asc(workspaceOutbox.availableAt), asc(workspaceOutbox.id)).limit(1);
    if (!candidate || candidate.ownershipEpoch === null) return undefined;

    const context = await loadRunContext(tx, input.workspaceId, candidate.publishRunId);
    await requireWorkspacePublishOwnership(
      tx,
      context.workspaceNovel.id,
      input.expectedCutoverEpoch ?? candidate.ownershipEpoch,
      input.expectedOwnershipVersion,
      true
    );

    const update = await tx.update(workspaceOutbox).set({
      status: "claimed",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      attempts: sql`${workspaceOutbox.attempts} + 1`,
    }).where(and(
      eq(workspaceOutbox.id, candidate.id),
      sql`${workspaceOutbox.attempts} < ${maxAttempts}`,
      sql`${workspaceOutbox.availableAt} <= NOW()`,
      or(
        eq(workspaceOutbox.status, "pending"),
        eq(workspaceOutbox.status, "failed"),
        and(eq(workspaceOutbox.status, "claimed"), sql`${workspaceOutbox.leaseExpiresAt} <= NOW()`)
      )
    ));
    if (affectedRows(update) !== 1) return undefined;
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
  expectedCutoverEpoch: number;
  expectedOwnershipVersion?: number;
  executionEnabled: boolean;
  allowExternalProvider?: boolean;
  maxAttempts?: number;
  observer?: WorkspacePublishObserver;
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
  if (outbox.ownershipEpoch === null || outbox.ownershipEpoch !== input.expectedCutoverEpoch) {
    throw new WorkspacePublishExecutionError("PUBLISH_OWNERSHIP_AMBIGUOUS", "Publish outbox is not bound to the worker's expected cutover epoch.");
  }
  if (outbox.status !== "claimed" || outbox.leaseOwner !== input.leaseOwner || !outbox.leaseExpiresAt || outbox.leaseExpiresAt <= now) {
    throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Publish outbox requires the active worker lease.");
  }

  const context = await loadRunContext(db, input.workspaceId, outbox.publishRunId);
  await requireWorkspacePublishOwnership(
    db,
    context.workspaceNovel.id,
    outbox.ownershipEpoch,
    input.expectedOwnershipVersion
  );
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
        input.observer?.({ type: "item_recovered", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, attempt: outbox.attempts, status: "published" });
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

      await requireWorkspacePublishOwnership(db, context.workspaceNovel.id, outbox.ownershipEpoch, input.expectedOwnershipVersion);
      input.observer?.({ type: "reconcile_start", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, requestKey: request.requestKey, attempt: outbox.attempts });
      const reconciled = await input.provider.reconcile(request);
      input.observer?.({ type: reconciled ? "reconcile_hit" : "reconcile_miss", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, requestKey: request.requestKey, attempt: outbox.attempts });
      await requireWorkspacePublishOwnership(db, context.workspaceNovel.id, outbox.ownershipEpoch, input.expectedOwnershipVersion);
      let result: WorkspacePublishProviderResult;
      if (reconciled) {
        result = reconciled;
      } else {
        const executeStartedAt = Date.now();
        input.observer?.({ type: "execute_start", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, requestKey: request.requestKey, attempt: outbox.attempts });
        result = await input.provider.execute(request);
        input.observer?.({ type: "execute_result", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, requestKey: request.requestKey, attempt: outbox.attempts, status: result.status, errorClass: result.errorClass, durationMs: Date.now() - executeStartedAt });
      }
      await persistItemResult({ db, itemId: item.id, expectedVersion: executionVersion, result });
      if (result.status === "published") {
        input.observer?.({ type: "receipt_persisted", at: new Date().toISOString(), workspaceId: input.workspaceId, publishRunId: context.run.id, outboxId: outbox.id, itemId: item.id, itemKey: item.itemKey, requestKey: request.requestKey, attempt: outbox.attempts, status: "published" });
      }
    }

    return await finalizePublishExecution({
      workspaceId: input.workspaceId,
      runId: context.run.id,
      outboxId: outbox.id,
      leaseOwner: input.leaseOwner,
      expectedOwnershipVersion: input.expectedOwnershipVersion,
      maxAttempts: input.maxAttempts,
      observer: input.observer,
    });
  } catch (error) {
    const maxAttempts = input.maxAttempts ?? WORKSPACE_PUBLISH_MAX_ATTEMPTS;
    const deadLetter = outbox.attempts >= maxAttempts;
    await db.update(workspaceOutbox).set({
      status: deadLetter ? "dead_letter" : "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: deadLetter ? outbox.availableAt : new Date(Date.now() + 1_000),
    }).where(and(
      eq(workspaceOutbox.id, outbox.id),
      eq(workspaceOutbox.status, "claimed"),
      eq(workspaceOutbox.leaseOwner, input.leaseOwner)
    ));
    input.observer?.({
      type: deadLetter ? "outbox_dead_letter" : "outbox_failed",
      at: new Date().toISOString(),
      workspaceId: input.workspaceId,
      publishRunId: context.run.id,
      outboxId: outbox.id,
      attempt: outbox.attempts,
      status: deadLetter ? "dead_letter" : "failed",
      errorClass: error instanceof Error ? error.name : "UNKNOWN",
    });
    throw error;
  }
}

export async function finalizePublishExecution(input: {
  workspaceId: number;
  runId: number;
  outboxId: number;
  leaseOwner: string;
  expectedOwnershipVersion?: number;
  maxAttempts?: number;
  observer?: WorkspacePublishObserver;
}) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    const context = await loadRunContext(tx, input.workspaceId, input.runId, true);
    const [outbox] = await tx.select().from(workspaceOutbox).where(eq(workspaceOutbox.id, input.outboxId)).limit(1).for("update");
    if (!outbox || outbox.status !== "claimed" || outbox.leaseOwner !== input.leaseOwner || !outbox.leaseExpiresAt || outbox.leaseExpiresAt <= new Date()) {
      throw new WorkspacePublishExecutionError("OUTBOX_LEASE_INVALID", "Cannot finalize without the active outbox lease.");
    }
    if (outbox.ownershipEpoch === null) {
      throw new WorkspacePublishExecutionError("PUBLISH_OWNERSHIP_AMBIGUOUS", "Publish outbox is not bound to a cutover epoch.");
    }
    await requireWorkspacePublishOwnership(
      tx,
      context.workspaceNovel.id,
      outbox.ownershipEpoch,
      input.expectedOwnershipVersion,
      true
    );
    const source = await assertCurrentPublishHash(
      tx,
      context.workspaceNovel.id,
      context.run.snapshotId,
      context.run.expectedLastPublishedSha256 ?? null,
      true
    );
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

    if (status === "published") {
      const fingerprintUpdate = await tx.update(workspaceDocumentFingerprints).set({
        lastPublishedSha256: source.snapshot.normalizedSha256.toLowerCase(),
        version: sql`${workspaceDocumentFingerprints.version} + 1`,
      }).where(and(
        eq(workspaceDocumentFingerprints.id, source.fingerprint.id),
        eq(workspaceDocumentFingerprints.version, source.fingerprint.version)
      ));
      if (affectedRows(fingerprintUpdate) !== 1) {
        throw new WorkspacePublishExecutionError("STALE_PUBLISH_HASH", "Publish fingerprint changed while advancing the successful last-published hash.");
      }
    }

    const maxAttempts = input.maxAttempts ?? WORKSPACE_PUBLISH_MAX_ATTEMPTS;
    const deadLetter = status !== "published" && outbox.attempts >= maxAttempts;
    const outboxStatus = status === "published" ? "delivered" : deadLetter ? "dead_letter" : "failed";
    await tx.update(workspaceOutbox).set({
      status: outboxStatus,
      deliveredAt: status === "published" ? new Date() : null,
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: status === "published" || deadLetter ? outbox.availableAt : new Date(Date.now() + 1_000),
    }).where(and(eq(workspaceOutbox.id, outbox.id), eq(workspaceOutbox.status, "claimed"), eq(workspaceOutbox.leaseOwner, input.leaseOwner)));

    input.observer?.({
      type: deadLetter ? "outbox_dead_letter" : "finalized",
      at: new Date().toISOString(),
      workspaceId: input.workspaceId,
      publishRunId: input.runId,
      outboxId: outbox.id,
      attempt: outbox.attempts,
      status: outboxStatus,
    });
    return { status, published, failed, pending, outboxStatus };
  });
}
