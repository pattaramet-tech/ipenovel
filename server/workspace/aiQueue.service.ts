import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import {
  workspaceAiArtifacts,
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceDocumentBindings,
  workspaceDocumentSnapshots,
  workspaceMembers,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { WorkspaceRole } from "./domain";

export class WorkspaceAiQueueError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "SNAPSHOT_NOT_BOUND"
      | "AI_JOB_NOT_FOUND"
      | "AI_JOB_CONFLICT"
      | "AI_ATTEMPT_NOT_FOUND"
      | "AI_ATTEMPT_CONFLICT"
      | "AI_LEASE_INVALID",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceAiQueueError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceAiQueueError("DATABASE_UNAVAILABLE", "Workspace database is unavailable.");
  }
  return db;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active")
    ))
    .limit(1);
  if (!rows[0]) {
    throw new WorkspaceAiQueueError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  }
  return rows[0] as { role: WorkspaceRole };
}

function requireEditorRole(role: WorkspaceRole) {
  if (role !== "owner" && role !== "editor") {
    throw new WorkspaceAiQueueError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required.");
  }
}

async function assertSnapshotInWorkspace(db: any, workspaceId: number, snapshotId: number) {
  const rows = await db
    .select({ snapshotId: workspaceDocumentSnapshots.id })
    .from(workspaceDocumentSnapshots)
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentSnapshots.documentId, workspaceDocumentBindings.documentId))
    .innerJoin(workspaceNovels, eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id))
    .where(and(
      eq(workspaceDocumentSnapshots.id, snapshotId),
      eq(workspaceNovels.workspaceId, workspaceId)
    ))
    .limit(1);
  if (!rows[0]) {
    throw new WorkspaceAiQueueError("SNAPSHOT_NOT_BOUND", "Snapshot is not bound to a document in this workspace.");
  }
}

function affectedRows(result: unknown) {
  const value = result as any;
  return Number(value?.[0]?.affectedRows ?? value?.affectedRows ?? 0);
}

function insertId(result: unknown) {
  const value = result as any;
  return Number(value?.[0]?.insertId ?? value?.insertId);
}

function aiIdempotencyKey(input: {
  snapshotId: number;
  operation: string;
  promptVersion: string;
  modelPolicyVersion: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      contract: "workspace-ai-job-v1",
      snapshotId: input.snapshotId,
      operation: input.operation,
      promptVersion: input.promptVersion,
      modelPolicyVersion: input.modelPolicyVersion,
    }))
    .digest("hex");
}

export async function queueAiJob(input: {
  actorUserId: number;
  workspaceId: number;
  snapshotId: number;
  operation: string;
  promptVersion: string;
  modelPolicyVersion: string;
  priority?: number;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  await assertSnapshotInWorkspace(db, input.workspaceId, input.snapshotId);

  const idempotencyKey = aiIdempotencyKey(input);
  const existing = await db.select().from(workspaceAiJobs).where(and(
    eq(workspaceAiJobs.workspaceId, input.workspaceId),
    eq(workspaceAiJobs.idempotencyKey, idempotencyKey)
  )).limit(1);
  if (existing[0]) return { job: existing[0], created: false };

  let created = false;
  try {
    await db.insert(workspaceAiJobs).values({
      workspaceId: input.workspaceId,
      snapshotId: input.snapshotId,
      operation: input.operation,
      promptVersion: input.promptVersion,
      modelPolicyVersion: input.modelPolicyVersion,
      priority: input.priority ?? 0,
      status: "queued",
      idempotencyKey,
    });
    created = true;
  } catch (error) {
    const value = error as any;
    const duplicateKey = value?.code === "ER_DUP_ENTRY" || value?.errno === 1062 || value?.cause?.code === "ER_DUP_ENTRY" || value?.cause?.errno === 1062;
    if (!duplicateKey) throw error;
  }
  const [job] = await db.select().from(workspaceAiJobs).where(and(
    eq(workspaceAiJobs.workspaceId, input.workspaceId),
    eq(workspaceAiJobs.idempotencyKey, idempotencyKey)
  )).limit(1);
  return { job, created };
}

export async function claimAiJob(input: {
  workspaceId: number;
  jobId: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}) {
  const db = await database();
  const now = new Date();
  if (input.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new WorkspaceAiQueueError("AI_LEASE_INVALID", "AI attempt lease must expire in the future.");
  }

  return db.transaction(async (tx: any) => {
    const rows = await tx.select().from(workspaceAiJobs).where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId)
    )).limit(1).for("update");
    const job = rows[0];
    if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");

    const attempts = await tx.select().from(workspaceAiJobAttempts)
      .where(eq(workspaceAiJobAttempts.jobId, job.id))
      .orderBy(desc(workspaceAiJobAttempts.attemptNo))
      .limit(1);
    const latest = attempts[0];

    if (job.status === "claimed" || job.status === "running") {
      if (!latest || (latest.status !== "claimed" && latest.status !== "running") || latest.leaseExpiresAt > now) {
        throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", "AI job already has an active attempt lease.");
      }
      const abandoned = await tx.update(workspaceAiJobAttempts).set({
        status: "abandoned",
        errorClass: "LEASE_EXPIRED",
        finishedAt: now,
        version: sql`${workspaceAiJobAttempts.version} + 1`,
      }).where(and(
        eq(workspaceAiJobAttempts.id, latest.id),
        eq(workspaceAiJobAttempts.version, latest.version),
        lte(workspaceAiJobAttempts.leaseExpiresAt, now)
      ));
      if (affectedRows(abandoned) !== 1) {
        throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "Expired AI attempt changed while being reclaimed.");
      }
    } else if (job.status !== "queued") {
      throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", `AI job cannot be claimed from status ${job.status}.`);
    }

    const attemptNo = (latest?.attemptNo ?? 0) + 1;
    const inserted = await tx.insert(workspaceAiJobAttempts).values({
      jobId: job.id,
      attemptNo,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      status: "claimed",
    });
    const attemptId = insertId(inserted);
    const updated = await tx.update(workspaceAiJobs).set({
      status: "claimed",
      version: sql`${workspaceAiJobs.version} + 1`,
    }).where(and(
      eq(workspaceAiJobs.id, job.id),
      eq(workspaceAiJobs.version, job.version)
    ));
    if (affectedRows(updated) !== 1) {
      throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", "AI job changed while being claimed.");
    }
    const [attempt] = await tx.select().from(workspaceAiJobAttempts).where(eq(workspaceAiJobAttempts.id, attemptId));
    return { jobId: job.id, attempt };
  });
}

export async function startAiAttempt(input: {
  workspaceId: number;
  jobId: number;
  attemptId: number;
  leaseOwner: string;
}) {
  const db = await database();
  const now = new Date();
  return db.transaction(async (tx: any) => {
    const [job] = await tx.select().from(workspaceAiJobs).where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId)
    )).limit(1).for("update");
    if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");
    const [attempt] = await tx.select().from(workspaceAiJobAttempts).where(and(
      eq(workspaceAiJobAttempts.id, input.attemptId),
      eq(workspaceAiJobAttempts.jobId, input.jobId)
    )).limit(1).for("update");
    if (!attempt) throw new WorkspaceAiQueueError("AI_ATTEMPT_NOT_FOUND", "AI attempt was not found.");
    if (job.status !== "claimed" || attempt.status !== "claimed" || attempt.leaseOwner !== input.leaseOwner || attempt.leaseExpiresAt <= now) {
      throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "AI attempt cannot start without the active lease.");
    }
    const attemptUpdate = await tx.update(workspaceAiJobAttempts).set({
      status: "running",
      startedAt: now,
      version: sql`${workspaceAiJobAttempts.version} + 1`,
    }).where(and(
      eq(workspaceAiJobAttempts.id, attempt.id),
      eq(workspaceAiJobAttempts.version, attempt.version),
      gt(workspaceAiJobAttempts.leaseExpiresAt, now)
    ));
    const jobUpdate = await tx.update(workspaceAiJobs).set({
      status: "running",
      version: sql`${workspaceAiJobs.version} + 1`,
    }).where(and(eq(workspaceAiJobs.id, job.id), eq(workspaceAiJobs.version, job.version)));
    if (affectedRows(attemptUpdate) !== 1 || affectedRows(jobUpdate) !== 1) {
      throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "AI attempt changed while starting.");
    }
    const [started] = await tx.select().from(workspaceAiJobAttempts).where(eq(workspaceAiJobAttempts.id, attempt.id));
    return started;
  });
}

export async function completeAiAttempt(input: {
  workspaceId: number;
  jobId: number;
  attemptId: number;
  leaseOwner: string;
  outcome: "succeeded" | "failed";
  providerRequestId?: string;
  errorClass?: string;
  artifacts?: Array<{
    artifactType: string;
    contentObjectKey: string;
    contentSha256: string;
    moderationStatus: "pending" | "accepted" | "rejected";
  }>;
}) {
  const db = await database();
  const now = new Date();
  return db.transaction(async (tx: any) => {
    const [job] = await tx.select().from(workspaceAiJobs).where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId)
    )).limit(1).for("update");
    if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");
    const [attempt] = await tx.select().from(workspaceAiJobAttempts).where(and(
      eq(workspaceAiJobAttempts.id, input.attemptId),
      eq(workspaceAiJobAttempts.jobId, input.jobId)
    )).limit(1).for("update");
    if (!attempt) throw new WorkspaceAiQueueError("AI_ATTEMPT_NOT_FOUND", "AI attempt was not found.");
    if (job.status !== "running" || attempt.status !== "running" || attempt.leaseOwner !== input.leaseOwner || attempt.leaseExpiresAt <= now) {
      throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "AI attempt cannot complete without the active running lease.");
    }

    for (const artifact of input.artifacts ?? []) {
      await tx.insert(workspaceAiArtifacts).values({
        attemptId: attempt.id,
        artifactType: artifact.artifactType,
        contentObjectKey: artifact.contentObjectKey,
        contentSha256: artifact.contentSha256,
        moderationStatus: artifact.moderationStatus,
      }).onDuplicateKeyUpdate({
        set: { id: sql`LAST_INSERT_ID(${workspaceAiArtifacts.id})` },
      });
    }

    const attemptUpdate = await tx.update(workspaceAiJobAttempts).set({
      status: input.outcome,
      providerRequestId: input.providerRequestId ?? attempt.providerRequestId,
      errorClass: input.outcome === "failed" ? (input.errorClass ?? "UNCLASSIFIED") : null,
      finishedAt: now,
      version: sql`${workspaceAiJobAttempts.version} + 1`,
    }).where(and(
      eq(workspaceAiJobAttempts.id, attempt.id),
      eq(workspaceAiJobAttempts.version, attempt.version),
      gt(workspaceAiJobAttempts.leaseExpiresAt, now)
    ));
    const jobUpdate = await tx.update(workspaceAiJobs).set({
      status: input.outcome,
      version: sql`${workspaceAiJobs.version} + 1`,
    }).where(and(eq(workspaceAiJobs.id, job.id), eq(workspaceAiJobs.version, job.version)));
    if (affectedRows(attemptUpdate) !== 1 || affectedRows(jobUpdate) !== 1) {
      throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "AI attempt changed while completing.");
    }
    return { jobId: job.id, attemptId: attempt.id, status: input.outcome } as const;
  });
}

export async function retryAiJob(input: {
  actorUserId: number;
  workspaceId: number;
  jobId: number;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  return db.transaction(async (tx: any) => {
    const [job] = await tx.select().from(workspaceAiJobs).where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId)
    )).limit(1).for("update");
    if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");
    if (job.status !== "failed") {
      throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", "Only a failed AI job can be retried.");
    }
    const updated = await tx.update(workspaceAiJobs).set({
      status: "queued",
      version: sql`${workspaceAiJobs.version} + 1`,
    }).where(and(eq(workspaceAiJobs.id, job.id), eq(workspaceAiJobs.version, job.version)));
    if (affectedRows(updated) !== 1) throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", "AI job changed while retrying.");
    const [queued] = await tx.select().from(workspaceAiJobs).where(eq(workspaceAiJobs.id, job.id));
    return queued;
  });
}

export async function cancelAiJob(input: {
  actorUserId: number;
  workspaceId: number;
  jobId: number;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  const now = new Date();
  return db.transaction(async (tx: any) => {
    const [job] = await tx.select().from(workspaceAiJobs).where(and(
      eq(workspaceAiJobs.id, input.jobId),
      eq(workspaceAiJobs.workspaceId, input.workspaceId)
    )).limit(1).for("update");
    if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");
    if (job.status === "succeeded" || job.status === "cancelled") {
      throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", `AI job cannot be cancelled from status ${job.status}.`);
    }
    const [latest] = await tx.select().from(workspaceAiJobAttempts)
      .where(eq(workspaceAiJobAttempts.jobId, job.id))
      .orderBy(desc(workspaceAiJobAttempts.attemptNo)).limit(1).for("update");
    if (latest && (latest.status === "claimed" || latest.status === "running")) {
      const attemptUpdate = await tx.update(workspaceAiJobAttempts).set({
        status: "abandoned",
        errorClass: "CANCELLED",
        finishedAt: now,
        version: sql`${workspaceAiJobAttempts.version} + 1`,
      }).where(and(eq(workspaceAiJobAttempts.id, latest.id), eq(workspaceAiJobAttempts.version, latest.version)));
      if (affectedRows(attemptUpdate) !== 1) throw new WorkspaceAiQueueError("AI_ATTEMPT_CONFLICT", "AI attempt changed while cancelling.");
    }
    const jobUpdate = await tx.update(workspaceAiJobs).set({
      status: "cancelled",
      version: sql`${workspaceAiJobs.version} + 1`,
    }).where(and(eq(workspaceAiJobs.id, job.id), eq(workspaceAiJobs.version, job.version)));
    if (affectedRows(jobUpdate) !== 1) throw new WorkspaceAiQueueError("AI_JOB_CONFLICT", "AI job changed while cancelling.");
    const [cancelled] = await tx.select().from(workspaceAiJobs).where(eq(workspaceAiJobs.id, job.id));
    return cancelled;
  });
}

export async function listAiJobs(input: { actorUserId: number; workspaceId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  return db.select().from(workspaceAiJobs)
    .where(eq(workspaceAiJobs.workspaceId, input.workspaceId))
    .orderBy(desc(workspaceAiJobs.priority), asc(workspaceAiJobs.createdAt), asc(workspaceAiJobs.id));
}

export async function getAiJobDetail(input: { actorUserId: number; workspaceId: number; jobId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const [job] = await db.select().from(workspaceAiJobs).where(and(
    eq(workspaceAiJobs.id, input.jobId),
    eq(workspaceAiJobs.workspaceId, input.workspaceId)
  )).limit(1);
  if (!job) throw new WorkspaceAiQueueError("AI_JOB_NOT_FOUND", "AI job was not found.");
  const attempts = await db.select().from(workspaceAiJobAttempts)
    .where(eq(workspaceAiJobAttempts.jobId, job.id))
    .orderBy(asc(workspaceAiJobAttempts.attemptNo));
  const attemptIds = attempts.map(attempt => attempt.id);
  const artifacts = attemptIds.length === 0
    ? []
    : (await Promise.all(attemptIds.map(attemptId => db.select().from(workspaceAiArtifacts)
        .where(eq(workspaceAiArtifacts.attemptId, attemptId))
        .orderBy(asc(workspaceAiArtifacts.id))))).flat();
  return { job, attempts, artifacts };
}
