import { and, asc, eq } from "drizzle-orm";
import {
  workspaceMembers,
  workspaceMigrationRegistry,
  workspacePublishOwnershipTransitions,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { getPublishCutoverReadiness, WorkspacePublishCutoverError } from "./publishCutover.service";
import { buildPublishFinalGatePackage } from "./publishFinalGate.domain";

export class WorkspacePublishFinalGateError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS"
      | "PREVIEW_GATE_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "WorkspacePublishFinalGateError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspacePublishFinalGateError("DATABASE_UNAVAILABLE", "Workspace publish final gate database is unavailable.");
  return db;
}

async function requireOperator(db: any, workspaceId: number, userId: number) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) {
    throw new WorkspacePublishFinalGateError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  }
  if (membership.role !== "owner" && membership.role !== "editor") {
    throw new WorkspacePublishFinalGateError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required for the final publish gate.");
  }
}

export async function getPublishFinalGatePackage(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  executionEnabled: boolean;
}) {
  const db = await database();
  await requireOperator(db, input.workspaceId, input.actorUserId);

  let readiness;
  try {
    readiness = await getPublishCutoverReadiness({
      actorUserId: input.actorUserId,
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
  } catch (error) {
    if (error instanceof WorkspacePublishCutoverError && error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS") {
      throw new WorkspacePublishFinalGateError("PUBLISH_OWNERSHIP_AMBIGUOUS", error.message);
    }
    throw error;
  }

  const ownershipRows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, readiness.workspaceNovel.id),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (
    ownershipRows.length !== 1 ||
    ownershipRows[0].owner !== "sheets" ||
    ownershipRows[0].cutoverEpoch !== 0
  ) {
    throw new WorkspacePublishFinalGateError(
      "PUBLISH_OWNERSHIP_AMBIGUOUS",
      "Final publish gate requires exactly one Sheets-owned publish registry row at cutover epoch 0."
    );
  }
  const ownership = ownershipRows[0];
  const transitions = await db.select({ id: workspacePublishOwnershipTransitions.id })
    .from(workspacePublishOwnershipTransitions)
    .where(eq(workspacePublishOwnershipTransitions.workspaceNovelId, readiness.workspaceNovel.id))
    .orderBy(asc(workspacePublishOwnershipTransitions.id));

  const gate = buildPublishFinalGatePackage({
    workspaceId: input.workspaceId,
    workspaceNovelId: readiness.workspaceNovel.id,
    publishRunId: readiness.run.id,
    readinessDigest: readiness.readinessDigest,
    ownership: {
      owner: "sheets",
      cutoverEpoch: 0,
      version: ownership.version,
    },
    executionEnabled: input.executionEnabled,
    transitionIds: transitions.map(row => row.id),
    inheritedBlockers: readiness.blockers,
  });

  return {
    readOnly: true as const,
    gate,
    readiness,
    transitionHistoryCount: transitions.length,
    registryMutationApplied: false as const,
    publishDeliveryApplied: false as const,
  };
}

export async function requirePublishFinalGate(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  executionEnabled: boolean;
}) {
  const result = await getPublishFinalGatePackage(input);
  if (!result.gate.previewReady || !result.gate.operatorCutoverEligible) {
    throw new WorkspacePublishFinalGateError(
      "PREVIEW_GATE_BLOCKED",
      `Publish final gate is blocked: ${result.gate.blockers.join(", ") || result.readiness.blockers.join(", ")}`
    );
  }
  return result;
}
