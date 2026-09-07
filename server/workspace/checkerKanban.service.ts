import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  workspaceCheckerFindings,
  workspaceCheckerRuleSets,
  workspaceCheckerRuns,
  workspaceDocumentBindings,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceMembers,
  workspaceMigrationRegistry,
  workspaceNovels,
} from "../../drizzle/schema";
import { getDb } from "../db";
import type { WorkspaceRole } from "./domain";
import {
  CheckerRuleContractError,
  WORKSPACE_CHECKER_ENGINE_VERSION,
  compareCheckerParity,
  evaluateCheckerRuleSet,
  parseCheckerRuleSet,
  type CheckerParityFinding,
} from "./checkerParity.domain";

export class WorkspaceCheckerKanbanError extends Error {
  constructor(
    readonly code:
      | "DATABASE_UNAVAILABLE"
      | "MEMBERSHIP_REQUIRED"
      | "EDITOR_ROLE_REQUIRED"
      | "RULE_SET_NOT_FOUND"
      | "RULE_SET_INVALID"
      | "SNAPSHOT_NOT_BOUND"
      | "CHECKER_RUN_NOT_FOUND"
      | "CHECKER_RUN_CONFLICT"
      | "KANBAN_BOARD_NOT_FOUND"
      | "KANBAN_COLUMN_NOT_FOUND"
      | "KANBAN_CARD_NOT_FOUND"
      | "KANBAN_CONFLICT",
    message: string
  ) {
    super(message);
    this.name = "WorkspaceCheckerKanbanError";
  }
}

async function database() {
  const db = await getDb();
  if (!db) {
    throw new WorkspaceCheckerKanbanError(
      "DATABASE_UNAVAILABLE",
      "Workspace database is unavailable."
    );
  }
  return db;
}

async function requireMembership(db: any, workspaceId: number, userId: number) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, "active")
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new WorkspaceCheckerKanbanError(
      "MEMBERSHIP_REQUIRED",
      "Active workspace membership is required."
    );
  }
  return rows[0] as { role: WorkspaceRole };
}

function requireEditorRole(role: WorkspaceRole) {
  if (role !== "owner" && role !== "editor") {
    throw new WorkspaceCheckerKanbanError(
      "EDITOR_ROLE_REQUIRED",
      "Workspace owner or editor role is required."
    );
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function publishCheckerRuleSet(input: {
  actorUserId: number;
  workspaceId: number;
  name: string;
  versionNo: number;
  engineVersion: string;
  rulesJson: string;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  if (input.engineVersion !== WORKSPACE_CHECKER_ENGINE_VERSION) {
    throw new WorkspaceCheckerKanbanError(
      "RULE_SET_INVALID",
      `Unsupported checker engine version: ${input.engineVersion}.`
    );
  }
  try {
    parseCheckerRuleSet(input.rulesJson);
  } catch (error) {
    if (error instanceof CheckerRuleContractError) {
      throw new WorkspaceCheckerKanbanError("RULE_SET_INVALID", error.message);
    }
    throw error;
  }
  const contentSha256 = sha256(input.rulesJson);
  const existing = await db
    .select()
    .from(workspaceCheckerRuleSets)
    .where(
      and(
        eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId),
        eq(workspaceCheckerRuleSets.contentSha256, contentSha256)
      )
    )
    .limit(1);
  if (existing[0]) return { ruleSet: existing[0], created: false };

  const result = await db.insert(workspaceCheckerRuleSets).values({
    workspaceId: input.workspaceId,
    name: input.name,
    versionNo: input.versionNo,
    contentSha256,
    engineVersion: input.engineVersion,
    rulesJson: input.rulesJson,
    status: "published",
  });
  const id = Number((result as any)[0]?.insertId ?? (result as any).insertId);
  const [ruleSet] = await db
    .select()
    .from(workspaceCheckerRuleSets)
    .where(eq(workspaceCheckerRuleSets.id, id));
  return { ruleSet, created: true };
}

async function assertSnapshotInWorkspace(db: any, workspaceId: number, snapshotId: number) {
  const rows = await db
    .select({ snapshotId: workspaceDocumentSnapshots.id })
    .from(workspaceDocumentSnapshots)
    .innerJoin(
      workspaceDocumentBindings,
      eq(workspaceDocumentSnapshots.documentId, workspaceDocumentBindings.documentId)
    )
    .innerJoin(
      workspaceNovels,
      eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id)
    )
    .where(
      and(
        eq(workspaceDocumentSnapshots.id, snapshotId),
        eq(workspaceNovels.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new WorkspaceCheckerKanbanError(
      "SNAPSHOT_NOT_BOUND",
      "Snapshot is not bound to a document in this workspace."
    );
  }
}

export async function queueCheckerRun(input: {
  actorUserId: number;
  workspaceId: number;
  snapshotId: number;
  ruleSetId: number;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  await assertSnapshotInWorkspace(db, input.workspaceId, input.snapshotId);
  const [ruleSet] = await db
    .select()
    .from(workspaceCheckerRuleSets)
    .where(
      and(
        eq(workspaceCheckerRuleSets.id, input.ruleSetId),
        eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId),
        eq(workspaceCheckerRuleSets.status, "published")
      )
    )
    .limit(1);
  if (!ruleSet) {
    throw new WorkspaceCheckerKanbanError(
      "RULE_SET_NOT_FOUND",
      "Published checker rule set was not found in this workspace."
    );
  }
  const idempotencyKey = sha256(
    `workspace-checker-run:v1:${input.snapshotId}:${ruleSet.id}:${ruleSet.engineVersion}`
  );
  await db
    .insert(workspaceCheckerRuns)
    .values({
      snapshotId: input.snapshotId,
      ruleSetId: ruleSet.id,
      engineVersion: ruleSet.engineVersion,
      idempotencyKey,
      status: "queued",
    })
    .onDuplicateKeyUpdate({ set: { id: sql`LAST_INSERT_ID(${workspaceCheckerRuns.id})` } });
  const [run] = await db
    .select()
    .from(workspaceCheckerRuns)
    .where(eq(workspaceCheckerRuns.idempotencyKey, idempotencyKey));
  return run;
}

export async function claimCheckerRun(input: {
  runId: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}) {
  const db = await database();
  const now = new Date();
  const result = await db
    .update(workspaceCheckerRuns)
    .set({
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      startedAt: now,
      version: sql`${workspaceCheckerRuns.version} + 1`,
    })
    .where(
      and(
        eq(workspaceCheckerRuns.id, input.runId),
        or(
          eq(workspaceCheckerRuns.status, "queued"),
          and(
            eq(workspaceCheckerRuns.status, "running"),
            or(
              isNull(workspaceCheckerRuns.leaseExpiresAt),
              lte(workspaceCheckerRuns.leaseExpiresAt, now)
            )
          )
        )
      )
    );
  const affected = Number((result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0);
  if (affected !== 1) {
    throw new WorkspaceCheckerKanbanError(
      "CHECKER_RUN_CONFLICT",
      "Checker run could not be claimed."
    );
  }
  const [run] = await db.select().from(workspaceCheckerRuns).where(eq(workspaceCheckerRuns.id, input.runId));
  return run;
}

export async function completeCheckerRun(input: {
  runId: number;
  leaseOwner: string;
  status: "passed" | "failed";
  findings: Array<{
    ruleKey: string;
    severity: "info" | "warning" | "error";
    locationKey: string;
    excerptSha256: string;
    message: string;
  }>;
}) {
  const db = await database();
  return db.transaction(async (tx: any) => {
    const [run] = await tx.select().from(workspaceCheckerRuns).where(eq(workspaceCheckerRuns.id, input.runId)).limit(1);
    if (!run) {
      throw new WorkspaceCheckerKanbanError("CHECKER_RUN_NOT_FOUND", "Checker run was not found.");
    }
    if (
      run.status !== "running" ||
      run.leaseOwner !== input.leaseOwner ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= new Date()
    ) {
      throw new WorkspaceCheckerKanbanError(
        "CHECKER_RUN_CONFLICT",
        "Checker run lease is not active for this worker."
      );
    }
    for (const finding of input.findings) {
      await tx.insert(workspaceCheckerFindings).values({
        runId: input.runId,
        ...finding,
        disposition: "open",
      }).onDuplicateKeyUpdate({ set: { id: sql`LAST_INSERT_ID(${workspaceCheckerFindings.id})` } });
    }
    const result = await tx
      .update(workspaceCheckerRuns)
      .set({
        status: input.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        version: sql`${workspaceCheckerRuns.version} + 1`,
      })
      .where(
        and(
          eq(workspaceCheckerRuns.id, input.runId),
          eq(workspaceCheckerRuns.status, "running"),
          eq(workspaceCheckerRuns.leaseOwner, input.leaseOwner),
          gt(workspaceCheckerRuns.leaseExpiresAt, new Date())
        )
      );
    const affected = Number((result as any)[0]?.affectedRows ?? (result as any).affectedRows ?? 0);
    if (affected !== 1) {
      throw new WorkspaceCheckerKanbanError("CHECKER_RUN_CONFLICT", "Checker run changed while completing.");
    }
    return { runId: input.runId, status: input.status, findingCount: input.findings.length };
  });
}

async function loadCheckerRunContext(db: any, workspaceId: number, runId: number) {
  const [row] = await db
    .select({
      run: workspaceCheckerRuns,
      ruleSet: workspaceCheckerRuleSets,
      snapshot: workspaceDocumentSnapshots,
    })
    .from(workspaceCheckerRuns)
    .innerJoin(workspaceCheckerRuleSets, eq(workspaceCheckerRuns.ruleSetId, workspaceCheckerRuleSets.id))
    .innerJoin(workspaceDocumentSnapshots, eq(workspaceCheckerRuns.snapshotId, workspaceDocumentSnapshots.id))
    .where(
      and(
        eq(workspaceCheckerRuns.id, runId),
        eq(workspaceCheckerRuleSets.workspaceId, workspaceId)
      )
    )
    .limit(1);
  if (!row) {
    throw new WorkspaceCheckerKanbanError("CHECKER_RUN_NOT_FOUND", "Checker run was not found in this workspace.");
  }
  await assertSnapshotInWorkspace(db, workspaceId, row.snapshot.id);
  return row;
}

/** Internal worker entrypoint. It only evaluates immutable snapshot evidence and persists findings. */
export async function executeCheckerRun(input: {
  runId: number;
  workspaceId: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
}) {
  const db = await database();
  const context = await loadCheckerRunContext(db, input.workspaceId, input.runId);
  if (context.run.engineVersion !== WORKSPACE_CHECKER_ENGINE_VERSION) {
    throw new WorkspaceCheckerKanbanError("RULE_SET_INVALID", "Checker run uses an unsupported engine version.");
  }
  let rules;
  try {
    rules = parseCheckerRuleSet(context.ruleSet.rulesJson);
  } catch (error) {
    if (error instanceof CheckerRuleContractError) {
      throw new WorkspaceCheckerKanbanError("RULE_SET_INVALID", error.message);
    }
    throw error;
  }
  await claimCheckerRun({
    runId: input.runId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: input.leaseExpiresAt,
  });
  const result = evaluateCheckerRuleSet(rules, {
    id: context.snapshot.id,
    providerRevisionId: context.snapshot.providerRevisionId,
    normalizedSha256: context.snapshot.normalizedSha256,
    normalizationVersion: context.snapshot.normalizationVersion,
    byteLength: context.snapshot.byteLength,
  });
  await completeCheckerRun({
    runId: input.runId,
    leaseOwner: input.leaseOwner,
    status: result.status,
    findings: result.findings,
  });
  return { runId: input.runId, ...result };
}

export async function listCheckerRuns(input: { actorUserId: number; workspaceId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const rows = await db
    .select({ run: workspaceCheckerRuns, ruleSet: workspaceCheckerRuleSets })
    .from(workspaceCheckerRuns)
    .innerJoin(workspaceCheckerRuleSets, eq(workspaceCheckerRuns.ruleSetId, workspaceCheckerRuleSets.id))
    .where(eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId));
  const visible = [] as typeof rows;
  for (const row of rows) {
    try {
      await assertSnapshotInWorkspace(db, input.workspaceId, row.run.snapshotId);
      visible.push(row);
    } catch (error) {
      if (!(error instanceof WorkspaceCheckerKanbanError) || error.code !== "SNAPSHOT_NOT_BOUND") throw error;
    }
  }
  return visible;
}

export async function getCheckerRunDetail(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const context = await loadCheckerRunContext(db, input.workspaceId, input.runId);
  const findings = await db
    .select()
    .from(workspaceCheckerFindings)
    .where(eq(workspaceCheckerFindings.runId, input.runId));
  return { ...context, findings };
}

export async function compareCheckerRunWithCopiedLegacy(input: {
  actorUserId: number;
  workspaceId: number;
  runId: number;
  legacyFindings: CheckerParityFinding[];
}) {
  const detail = await getCheckerRunDetail({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    runId: input.runId,
  });
  const workspaceFindings: CheckerParityFinding[] = detail.findings.map((finding: typeof workspaceCheckerFindings.$inferSelect) => ({
    ruleKey: finding.ruleKey,
    severity: finding.severity,
    locationKey: finding.locationKey,
    excerptSha256: finding.excerptSha256,
  }));
  return compareCheckerParity({ legacy: input.legacyFindings, workspace: workspaceFindings });
}

export async function createKanbanBoard(input: {
  actorUserId: number;
  workspaceId: number;
  name: string;
  slug: string;
  columns: Array<{ key: string; name: string; position: number; wipLimit?: number }>;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  return db.transaction(async (tx: any) => {
    const result = await tx.insert(workspaceKanbanBoards).values({
      workspaceId: input.workspaceId,
      name: input.name,
      slug: input.slug,
      status: "active",
    });
    const boardId = Number((result as any)[0]?.insertId ?? (result as any).insertId);
    if (input.columns.length) {
      await tx.insert(workspaceKanbanColumns).values(
        input.columns.map(column => ({ boardId, ...column, status: "active" as const }))
      );
    }
    return { boardId };
  });
}

export async function createKanbanCardFromFingerprint(input: {
  actorUserId: number;
  workspaceId: number;
  boardId: number;
  columnKey: string;
  bindingId: number;
  logicalItemKey: string;
  rank?: number;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  const rows = await db
    .select({ board: workspaceKanbanBoards, column: workspaceKanbanColumns, fingerprint: workspaceDocumentFingerprints, novel: workspaceNovels })
    .from(workspaceKanbanBoards)
    .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanColumns.boardId, workspaceKanbanBoards.id))
    .innerJoin(workspaceDocumentFingerprints, eq(workspaceDocumentFingerprints.bindingId, input.bindingId))
    .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentBindings.id, workspaceDocumentFingerprints.bindingId))
    .innerJoin(workspaceNovels, eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id))
    .where(and(
      eq(workspaceKanbanBoards.id, input.boardId),
      eq(workspaceKanbanBoards.workspaceId, input.workspaceId),
      eq(workspaceKanbanColumns.key, input.columnKey),
      eq(workspaceNovels.workspaceId, input.workspaceId)
    ))
    .limit(1);
  if (!rows[0]) {
    throw new WorkspaceCheckerKanbanError("KANBAN_COLUMN_NOT_FOUND", "Board, column, or fingerprint binding was not found in this workspace.");
  }
  return db.transaction(async (tx: any) => {
    await tx.insert(workspaceKanbanCards).values({
      boardId: input.boardId,
      columnId: rows[0].column.id,
      bindingId: input.bindingId,
      logicalItemKey: input.logicalItemKey,
      rank: input.rank ?? 0,
      status: "active",
    }).onDuplicateKeyUpdate({ set: { id: sql`LAST_INSERT_ID(${workspaceKanbanCards.id})` } });
    const [card] = await tx.select().from(workspaceKanbanCards).where(and(
      eq(workspaceKanbanCards.boardId, input.boardId),
      eq(workspaceKanbanCards.logicalItemKey, input.logicalItemKey)
    ));
    if (
      !card ||
      card.bindingId !== input.bindingId ||
      card.columnId !== rows[0].column.id
    ) {
      throw new WorkspaceCheckerKanbanError(
        "KANBAN_CONFLICT",
        "Kanban logical item key was already used for a different card payload."
      );
    }
    await tx.insert(workspaceKanbanTransitions).values({
      cardId: card.id,
      fromColumnId: null,
      toColumnId: card.columnId,
      actorUserId: input.actorUserId,
      reason: "card_created_from_fingerprint",
      idempotencyKey: "initial",
    }).onDuplicateKeyUpdate({
      set: { id: sql`LAST_INSERT_ID(${workspaceKanbanTransitions.id})` },
    });
    return card;
  });
}

export async function transitionKanbanCard(input: {
  actorUserId: number;
  workspaceId: number;
  cardId: number;
  toColumnKey: string;
  reason: string;
  idempotencyKey: string;
  expectedVersion: number;
}) {
  const db = await database();
  const membership = await requireMembership(db, input.workspaceId, input.actorUserId);
  requireEditorRole(membership.role);
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select({ card: workspaceKanbanCards, board: workspaceKanbanBoards })
      .from(workspaceKanbanCards)
      .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
      .where(and(eq(workspaceKanbanCards.id, input.cardId), eq(workspaceKanbanBoards.workspaceId, input.workspaceId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new WorkspaceCheckerKanbanError("KANBAN_CARD_NOT_FOUND", "Kanban card was not found.");
    const [toColumn] = await tx.select().from(workspaceKanbanColumns).where(and(
      eq(workspaceKanbanColumns.boardId, row.board.id),
      eq(workspaceKanbanColumns.key, input.toColumnKey),
      eq(workspaceKanbanColumns.status, "active")
    )).limit(1);
    if (!toColumn) throw new WorkspaceCheckerKanbanError("KANBAN_COLUMN_NOT_FOUND", "Target Kanban column was not found.");

    const existing = await tx.select().from(workspaceKanbanTransitions).where(and(
      eq(workspaceKanbanTransitions.cardId, input.cardId),
      eq(workspaceKanbanTransitions.idempotencyKey, input.idempotencyKey)
    )).limit(1);
    if (existing[0]) {
      if (
        existing[0].toColumnId !== toColumn.id ||
        existing[0].actorUserId !== input.actorUserId ||
        existing[0].reason !== input.reason
      ) {
        throw new WorkspaceCheckerKanbanError(
          "KANBAN_CONFLICT",
          "Kanban idempotency key was already used for a different transition."
        );
      }
      return { transition: existing[0], replayed: true };
    }

    const update = await tx.update(workspaceKanbanCards).set({
      columnId: toColumn.id,
      version: sql`${workspaceKanbanCards.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(workspaceKanbanCards.id, input.cardId),
      eq(workspaceKanbanCards.version, input.expectedVersion)
    ));
    const affected = Number((update as any)[0]?.affectedRows ?? (update as any).affectedRows ?? 0);
    if (affected !== 1) throw new WorkspaceCheckerKanbanError("KANBAN_CONFLICT", "Kanban card version conflict.");

    const result = await tx.insert(workspaceKanbanTransitions).values({
      cardId: input.cardId,
      fromColumnId: row.card.columnId,
      toColumnId: toColumn.id,
      actorUserId: input.actorUserId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    const transitionId = Number((result as any)[0]?.insertId ?? (result as any).insertId);
    const [transition] = await tx.select().from(workspaceKanbanTransitions).where(eq(workspaceKanbanTransitions.id, transitionId));
    return { transition, replayed: false };
  });
}

export async function listOperationalReconciliationState(input: {
  actorUserId: number;
  workspaceId: number;
}) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);

  const [fingerprints, runs, findings, cards, transitions, ownership] = await Promise.all([
    db
      .select({
        fingerprint: workspaceDocumentFingerprints,
        binding: workspaceDocumentBindings,
        workspaceNovel: workspaceNovels,
      })
      .from(workspaceDocumentFingerprints)
      .innerJoin(workspaceDocumentBindings, eq(workspaceDocumentFingerprints.bindingId, workspaceDocumentBindings.id))
      .innerJoin(workspaceNovels, eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovels.id))
      .where(and(eq(workspaceNovels.workspaceId, input.workspaceId), eq(workspaceDocumentBindings.status, "active")))
      .orderBy(asc(workspaceDocumentBindings.id)),
    db
      .select({ run: workspaceCheckerRuns, ruleSet: workspaceCheckerRuleSets })
      .from(workspaceCheckerRuns)
      .innerJoin(workspaceCheckerRuleSets, eq(workspaceCheckerRuns.ruleSetId, workspaceCheckerRuleSets.id))
      .where(eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId))
      .orderBy(desc(workspaceCheckerRuns.createdAt), desc(workspaceCheckerRuns.id)),
    db
      .select({ finding: workspaceCheckerFindings, run: workspaceCheckerRuns, ruleSet: workspaceCheckerRuleSets })
      .from(workspaceCheckerFindings)
      .innerJoin(workspaceCheckerRuns, eq(workspaceCheckerFindings.runId, workspaceCheckerRuns.id))
      .innerJoin(workspaceCheckerRuleSets, eq(workspaceCheckerRuns.ruleSetId, workspaceCheckerRuleSets.id))
      .where(eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId))
      .orderBy(asc(workspaceCheckerFindings.ruleKey), asc(workspaceCheckerFindings.locationKey), asc(workspaceCheckerFindings.excerptSha256)),
    db
      .select({ card: workspaceKanbanCards, board: workspaceKanbanBoards, column: workspaceKanbanColumns })
      .from(workspaceKanbanCards)
      .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
      .innerJoin(workspaceKanbanColumns, eq(workspaceKanbanCards.columnId, workspaceKanbanColumns.id))
      .where(eq(workspaceKanbanBoards.workspaceId, input.workspaceId))
      .orderBy(asc(workspaceKanbanBoards.id), asc(workspaceKanbanCards.rank), asc(workspaceKanbanCards.id)),
    db
      .select({ transition: workspaceKanbanTransitions, card: workspaceKanbanCards, board: workspaceKanbanBoards })
      .from(workspaceKanbanTransitions)
      .innerJoin(workspaceKanbanCards, eq(workspaceKanbanTransitions.cardId, workspaceKanbanCards.id))
      .innerJoin(workspaceKanbanBoards, eq(workspaceKanbanCards.boardId, workspaceKanbanBoards.id))
      .where(eq(workspaceKanbanBoards.workspaceId, input.workspaceId))
      .orderBy(asc(workspaceKanbanTransitions.cardId), asc(workspaceKanbanTransitions.createdAt), asc(workspaceKanbanTransitions.id)),
    db
      .select({ entry: workspaceMigrationRegistry, workspaceNovel: workspaceNovels })
      .from(workspaceMigrationRegistry)
      .innerJoin(workspaceNovels, eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovels.id))
      .where(and(eq(workspaceNovels.workspaceId, input.workspaceId), eq(workspaceMigrationRegistry.capability, "checker"))),
  ]);

  const latestTransitionByCard = new Map<number, typeof workspaceKanbanTransitions.$inferSelect>();
  for (const row of transitions) latestTransitionByCard.set(row.transition.cardId, row.transition);

  return fingerprints.map(row => {
    const snapshotRuns = runs.filter(candidate => candidate.run.snapshotId === row.fingerprint.snapshotId);
    const latest = snapshotRuns[0];
    const latestFindings = latest
      ? findings.filter(candidate => candidate.finding.runId === latest.run.id).map(candidate => candidate.finding)
      : [];
    const bindingCards = cards.filter(candidate => candidate.card.bindingId === row.binding.id);
    const kanban = bindingCards.map(candidate => {
      const latestTransition = latestTransitionByCard.get(candidate.card.id) ?? null;
      return {
        card: candidate.card,
        board: candidate.board,
        column: candidate.column,
        latestTransition,
        projectionStatus:
          latestTransition && latestTransition.toColumnId === candidate.card.columnId
            ? "consistent" as const
            : "mismatch" as const,
      };
    });
    const owner = ownership.find(candidate => candidate.workspaceNovel.id === row.workspaceNovel.id)?.entry ?? null;
    const severityCounts = { info: 0, warning: 0, error: 0 };
    for (const finding of latestFindings) severityCounts[finding.severity] += 1;
    return {
      bindingId: row.binding.id,
      workspaceNovelId: row.workspaceNovel.id,
      fingerprint: row.fingerprint,
      checker: latest
        ? { run: latest.run, ruleSet: latest.ruleSet, findings: latestFindings, severityCounts }
        : null,
      checkerStatus: latest?.run.status ?? "not_run",
      parityStatus: "not_compared" as const,
      ownership: owner,
      kanban,
      kanbanProjectionStatus:
        kanban.length === 0
          ? "not_linked" as const
          : kanban.every(item => item.projectionStatus === "consistent")
            ? "consistent" as const
            : "mismatch" as const,
    };
  });
}

export async function reconcileCopiedLegacyOperationalState(input: {
  actorUserId: number;
  workspaceId: number;
  baselines: Array<{
    bindingId: number;
    runId: number;
    providerRevisionId: string;
    normalizedSha256: string;
    ruleSetContentSha256: string;
    legacyFindings: CheckerParityFinding[];
  }>;
}) {
  const state = await listOperationalReconciliationState({
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
  });
  const results = input.baselines.map(baseline => {
    const item = state.find(candidate => candidate.bindingId === baseline.bindingId);
    if (!item) {
      return { bindingId: baseline.bindingId, pass: false, missingBinding: true } as const;
    }
    const runMatches = item.checker?.run.id === baseline.runId;
    const revisionMatches = item.fingerprint.providerRevisionId === baseline.providerRevisionId;
    const hashMatches = item.fingerprint.normalizedSha256 === baseline.normalizedSha256;
    const ruleSetMatches = item.checker?.ruleSet.contentSha256 === baseline.ruleSetContentSha256;
    const ownershipMatches = item.ownership?.owner === "sheets";
    const parity = compareCheckerParity({
      legacy: baseline.legacyFindings,
      workspace: (item.checker?.findings ?? []).map(finding => ({
        ruleKey: finding.ruleKey,
        severity: finding.severity,
        locationKey: finding.locationKey,
        excerptSha256: finding.excerptSha256,
      })),
    });
    const kanbanMatches = item.kanbanProjectionStatus !== "mismatch";
    return {
      bindingId: baseline.bindingId,
      pass: runMatches && revisionMatches && hashMatches && ruleSetMatches && ownershipMatches && parity.pass && kanbanMatches,
      missingBinding: false,
      runMatches,
      revisionMatches,
      hashMatches,
      ruleSetMatches,
      ownershipMatches,
      kanbanMatches,
      parity,
    } as const;
  });
  return {
    pass: results.every(result => result.pass),
    results,
    summary: {
      total: results.length,
      failed: results.filter(result => !result.pass).length,
      missingBinding: results.filter(result => result.missingBinding).length,
      runMismatch: results.filter(result => !result.missingBinding && !result.runMatches).length,
      hashMismatch: results.filter(result => !result.missingBinding && !result.hashMatches).length,
      revisionMismatch: results.filter(result => !result.missingBinding && !result.revisionMatches).length,
      ruleSetMismatch: results.filter(result => !result.missingBinding && !result.ruleSetMatches).length,
      ownershipMismatch: results.filter(result => !result.missingBinding && !result.ownershipMatches).length,
      kanbanProjectionMismatch: results.filter(result => !result.missingBinding && !result.kanbanMatches).length,
      parityMismatch: results.filter(result => !result.missingBinding && !result.parity.pass).length,
    },
  };
}

export async function listDualRunState(input: { actorUserId: number; workspaceId: number }) {
  const db = await database();
  await requireMembership(db, input.workspaceId, input.actorUserId);
  const [boards, ruleSets] = await Promise.all([
    db.select().from(workspaceKanbanBoards).where(eq(workspaceKanbanBoards.workspaceId, input.workspaceId)),
    db.select().from(workspaceCheckerRuleSets).where(eq(workspaceCheckerRuleSets.workspaceId, input.workspaceId)),
  ]);
  return { boards, ruleSets };
}
