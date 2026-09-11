import { and, asc, desc, eq } from "drizzle-orm";
import {
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
import {
  buildLegacyRetirementCandidatePackage,
  type LegacyRetirementEvidence,
} from "./legacyRetirement.domain";

export class WorkspaceLegacyRetirementError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "WORKSPACE_NOVEL_NOT_FOUND"
      | "PUBLISH_OWNERSHIP_AMBIGUOUS"
      | "RETIREMENT_CANDIDATE_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceLegacyRetirementError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) throw new WorkspaceLegacyRetirementError("DATABASE_UNAVAILABLE", "Workspace legacy-retirement database is unavailable.");
  return db;
}

async function requireOperator(db: any, workspaceId: number, userId: number) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId),
    eq(workspaceMembers.userId, userId),
    eq(workspaceMembers.status, "active")
  )).limit(1);
  if (!membership) throw new WorkspaceLegacyRetirementError("MEMBERSHIP_REQUIRED", "Active workspace membership is required.");
  if (membership.role !== "owner" && membership.role !== "editor") {
    throw new WorkspaceLegacyRetirementError("EDITOR_ROLE_REQUIRED", "Workspace owner or editor role is required for retirement-candidate evidence review.");
  }
  return membership as { role: WorkspaceRole };
}

export async function getLegacyRetirementCandidatePackage(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  evidence: LegacyRetirementEvidence;
}) {
  const db = await database();
  await requireOperator(db, input.workspaceId, input.actorUserId);

  const [workspaceNovel] = await db.select().from(workspaceNovels).where(and(
    eq(workspaceNovels.id, input.workspaceNovelId),
    eq(workspaceNovels.workspaceId, input.workspaceId),
    eq(workspaceNovels.status, "active")
  )).limit(1);
  if (!workspaceNovel) {
    throw new WorkspaceLegacyRetirementError("WORKSPACE_NOVEL_NOT_FOUND", "Active workspace novel was not found.");
  }

  const ownershipRows = await db.select().from(workspaceMigrationRegistry).where(and(
    eq(workspaceMigrationRegistry.workspaceNovelId, input.workspaceNovelId),
    eq(workspaceMigrationRegistry.capability, "publish")
  ));
  if (ownershipRows.length !== 1) {
    throw new WorkspaceLegacyRetirementError("PUBLISH_OWNERSHIP_AMBIGUOUS", "Retirement-candidate review requires exactly one publish ownership row.");
  }
  const ownership = ownershipRows[0];

  const transitions = await db.select().from(workspacePublishOwnershipTransitions)
    .where(eq(workspacePublishOwnershipTransitions.workspaceNovelId, input.workspaceNovelId))
    .orderBy(asc(workspacePublishOwnershipTransitions.id));
  const latestTransition = transitions[transitions.length - 1] ?? null;

  const [latestRun] = await db.select({ run: workspacePublishRuns, destination: workspacePublishingDestinations })
    .from(workspacePublishRuns)
    .innerJoin(workspacePublishingDestinations, eq(workspacePublishRuns.destinationId, workspacePublishingDestinations.id))
    .where(eq(workspacePublishingDestinations.workspaceNovelId, input.workspaceNovelId))
    .orderBy(desc(workspacePublishRuns.createdAt), desc(workspacePublishRuns.id))
    .limit(1);

  const items = latestRun
    ? await db.select().from(workspacePublishItems)
      .where(eq(workspacePublishItems.runId, latestRun.run.id))
      .orderBy(asc(workspacePublishItems.id))
    : [];
  const outbox = latestRun
    ? await db.select().from(workspaceOutbox)
      .where(eq(workspaceOutbox.publishRunId, latestRun.run.id))
      .orderBy(asc(workspaceOutbox.id))
    : [];

  const gate = buildLegacyRetirementCandidatePackage({
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    ownership: {
      owner: ownership.owner,
      cutoverEpoch: ownership.cutoverEpoch,
      version: ownership.version,
    },
    latestTransition: latestTransition
      ? {
          id: latestTransition.id,
          direction: latestTransition.direction,
          toOwner: latestTransition.toOwner,
          toEpoch: latestTransition.toEpoch,
          toVersion: latestTransition.toVersion,
        }
      : null,
    publishRunId: latestRun?.run.id ?? null,
    items: items.map(item => ({
      itemKey: item.itemKey,
      status: item.status,
      providerReceipt: item.providerReceipt,
    })),
    outbox: outbox.map(row => ({ id: row.id, status: row.status })),
    evidence: input.evidence,
  });

  return {
    readOnly: true as const,
    gate,
    workspaceNovel,
    publishOwnership: ownership,
    transitionHistoryCount: transitions.length,
    latestPublishRun: latestRun?.run ?? null,
    latestDestination: latestRun?.destination ?? null,
    legacyMutationApplied: false as const,
    zipMutationApplied: false as const,
    registryMutationApplied: false as const,
    publishDeliveryApplied: false as const,
  };
}

export async function requireLegacyRetirementCandidate(input: {
  actorUserId: number;
  workspaceId: number;
  workspaceNovelId: number;
  evidence: LegacyRetirementEvidence;
}) {
  const result = await getLegacyRetirementCandidatePackage(input);
  if (!result.gate.retirementCandidateReady) {
    throw new WorkspaceLegacyRetirementError(
      "RETIREMENT_CANDIDATE_BLOCKED",
      `Legacy retirement candidate is blocked: ${result.gate.blockers.join(", ")}`
    );
  }
  return result;
}
