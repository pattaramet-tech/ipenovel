import mysql from "mysql2/promise";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const M06_PREVIEW_BASELINE = Object.freeze({
  candidate: {
    workspaceId: 2,
    workspaceNovelId: 2,
    novelId: 4020002,
    publishRunId: 2,
    owner: "workspace",
    cutoverEpoch: 1,
    version: 2,
    syntheticReceipt: "preview-m06-positive-synthetic-receipt",
  },
  control: {
    workspaceNovelId: 1,
    novelId: 4020003,
    owner: "sheets",
    cutoverEpoch: 2,
    version: 3,
    transitionCount: 2,
  },
});

type Row = Record<string, unknown>;

export type M06BaselineRows = {
  candidateWorkspace: Row[];
  candidateOwnership: Row[];
  candidateTransitions: Row[];
  candidateRun: Row[];
  candidateItems: Row[];
  candidateRunOutbox: Row[];
  candidateAllOutbox: Row[];
  candidateFingerprint: Row[];
  controlWorkspace: Row[];
  controlOwnership: Row[];
  controlTransitions: Row[];
};

function fail(message: string): never {
  throw new Error(`M06 Preview baseline REFUSED: ${message}`);
}

function requireOne(rows: Row[], label: string): Row {
  if (rows.length !== 1) fail(`${label} expected exactly 1 row, got ${rows.length}`);
  return rows[0];
}

function requireValue(row: Row, key: string, expected: unknown, label: string) {
  if (row[key] !== expected) {
    fail(`${label}.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(row[key])}`);
  }
}

export function validateM06PreviewBaseline(rows: M06BaselineRows) {
  const expected = M06_PREVIEW_BASELINE;

  const candidateWorkspace = requireOne(rows.candidateWorkspace, "candidateWorkspace");
  requireValue(candidateWorkspace, "workspaceId", expected.candidate.workspaceId, "candidateWorkspace");
  requireValue(candidateWorkspace, "workspaceNovelId", expected.candidate.workspaceNovelId, "candidateWorkspace");
  requireValue(candidateWorkspace, "novelId", expected.candidate.novelId, "candidateWorkspace");
  requireValue(candidateWorkspace, "workspaceStatus", "active", "candidateWorkspace");
  requireValue(candidateWorkspace, "workspaceNovelStatus", "active", "candidateWorkspace");

  const candidateOwnership = requireOne(rows.candidateOwnership, "candidateOwnership");
  requireValue(candidateOwnership, "capability", "publish", "candidateOwnership");
  requireValue(candidateOwnership, "owner", expected.candidate.owner, "candidateOwnership");
  requireValue(candidateOwnership, "cutoverEpoch", expected.candidate.cutoverEpoch, "candidateOwnership");
  requireValue(candidateOwnership, "version", expected.candidate.version, "candidateOwnership");

  if (rows.candidateTransitions.length !== 1) {
    fail(`candidateTransitions expected exactly 1 row, got ${rows.candidateTransitions.length}`);
  }
  const candidateTransition = rows.candidateTransitions[0];
  requireValue(candidateTransition, "publishRunId", expected.candidate.publishRunId, "candidateTransition");
  requireValue(candidateTransition, "direction", "cutover", "candidateTransition");
  requireValue(candidateTransition, "fromOwner", "sheets", "candidateTransition");
  requireValue(candidateTransition, "toOwner", "workspace", "candidateTransition");
  requireValue(candidateTransition, "fromEpoch", 0, "candidateTransition");
  requireValue(candidateTransition, "toEpoch", 1, "candidateTransition");
  requireValue(candidateTransition, "fromVersion", 1, "candidateTransition");
  requireValue(candidateTransition, "toVersion", 2, "candidateTransition");

  const candidateRun = requireOne(rows.candidateRun, "candidateRun");
  requireValue(candidateRun, "publishRunId", expected.candidate.publishRunId, "candidateRun");
  requireValue(candidateRun, "workspaceNovelId", expected.candidate.workspaceNovelId, "candidateRun");
  requireValue(candidateRun, "targetType", "novel", "candidateRun");
  requireValue(candidateRun, "targetId", expected.candidate.novelId, "candidateRun");
  requireValue(candidateRun, "destinationStatus", "active", "candidateRun");
  requireValue(candidateRun, "runStatus", "ready", "candidateRun");

  if (rows.candidateItems.length !== 1) {
    fail(`candidateItems expected exactly 1 synthetic item, got ${rows.candidateItems.length}`);
  }
  const candidateItem = rows.candidateItems[0];
  requireValue(candidateItem, "status", "published", "candidateItem");
  requireValue(candidateItem, "providerReceipt", expected.candidate.syntheticReceipt, "candidateItem");

  if (rows.candidateRunOutbox.length !== 0) {
    fail(`candidate run 2 must have no outbox rows before operational execution; got ${rows.candidateRunOutbox.length}`);
  }
  const candidateBacklog = rows.candidateAllOutbox.filter(row => row.status !== "delivered");
  if (candidateBacklog.length !== 0) {
    fail(`candidate workspace novel has ${candidateBacklog.length} non-delivered outbox row(s)`);
  }

  const candidateFingerprint = requireOne(rows.candidateFingerprint, "candidateFingerprint");
  if (candidateFingerprint.lastPublishedSha256 !== null) {
    fail(`candidate synthetic checkpoint expects lastPublishedSha256=null, got ${JSON.stringify(candidateFingerprint.lastPublishedSha256)}`);
  }

  const controlWorkspace = requireOne(rows.controlWorkspace, "controlWorkspace");
  requireValue(controlWorkspace, "workspaceNovelId", expected.control.workspaceNovelId, "controlWorkspace");
  requireValue(controlWorkspace, "novelId", expected.control.novelId, "controlWorkspace");
  requireValue(controlWorkspace, "workspaceNovelStatus", "active", "controlWorkspace");

  const controlOwnership = requireOne(rows.controlOwnership, "controlOwnership");
  requireValue(controlOwnership, "capability", "publish", "controlOwnership");
  requireValue(controlOwnership, "owner", expected.control.owner, "controlOwnership");
  requireValue(controlOwnership, "cutoverEpoch", expected.control.cutoverEpoch, "controlOwnership");
  requireValue(controlOwnership, "version", expected.control.version, "controlOwnership");

  if (rows.controlTransitions.length !== expected.control.transitionCount) {
    fail(`controlTransitions expected ${expected.control.transitionCount} rows, got ${rows.controlTransitions.length}`);
  }
  const [controlCutover, controlRollback] = rows.controlTransitions;
  requireValue(controlCutover, "direction", "cutover", "controlTransition[0]");
  requireValue(controlCutover, "fromOwner", "sheets", "controlTransition[0]");
  requireValue(controlCutover, "toOwner", "workspace", "controlTransition[0]");
  requireValue(controlCutover, "fromEpoch", 0, "controlTransition[0]");
  requireValue(controlCutover, "toEpoch", 1, "controlTransition[0]");
  requireValue(controlCutover, "fromVersion", 1, "controlTransition[0]");
  requireValue(controlCutover, "toVersion", 2, "controlTransition[0]");
  requireValue(controlRollback, "direction", "rollback", "controlTransition[1]");
  requireValue(controlRollback, "fromOwner", "workspace", "controlTransition[1]");
  requireValue(controlRollback, "toOwner", "sheets", "controlTransition[1]");
  requireValue(controlRollback, "fromEpoch", 1, "controlTransition[1]");
  requireValue(controlRollback, "toEpoch", 2, "controlTransition[1]");
  requireValue(controlRollback, "fromVersion", 2, "controlTransition[1]");
  requireValue(controlRollback, "toVersion", 3, "controlTransition[1]");

  return {
    baselinePass: true as const,
    evidenceClass: "synthetic_checkpoint_only" as const,
    candidate: {
      workspaceId: candidateWorkspace.workspaceId,
      workspaceNovelId: candidateWorkspace.workspaceNovelId,
      novelId: candidateWorkspace.novelId,
      owner: candidateOwnership.owner,
      cutoverEpoch: candidateOwnership.cutoverEpoch,
      version: candidateOwnership.version,
      transitionCount: rows.candidateTransitions.length,
      publishRunId: candidateRun.publishRunId,
      runStatus: candidateRun.runStatus,
      itemStatus: candidateItem.status,
      providerReceipt: candidateItem.providerReceipt,
      lastPublishedSha256: candidateFingerprint.lastPublishedSha256,
      runOutboxCount: rows.candidateRunOutbox.length,
      allOutboxBacklog: candidateBacklog.length,
    },
    control: {
      workspaceNovelId: controlWorkspace.workspaceNovelId,
      novelId: controlWorkspace.novelId,
      owner: controlOwnership.owner,
      cutoverEpoch: controlOwnership.cutoverEpoch,
      version: controlOwnership.version,
      transitionCount: rows.controlTransitions.length,
      unchanged: true as const,
    },
    executionAuthorizationReady: false as const,
    executionAuthorizationBlockers: [
      "EXTERNAL_PUBLISH_PROVIDER_NOT_IMPLEMENTED",
      "RUNTIME_PUBLISH_WORKER_NOT_WIRED",
      "FRESH_PENDING_OPERATIONAL_RUN_REQUIRED",
      "LAST_PUBLISHED_HASH_SUCCESS_UPDATE_NOT_IMPLEMENTED",
      "SCOPED_EXECUTION_ALLOWLIST_NOT_IMPLEMENTED",
      "OPERATIONAL_PARITY_SLO_POLICY_NOT_APPROVED",
      "LEGACY_ACTION_FREEZE_EVIDENCE_NOT_AVAILABLE_FROM_WORKSPACE_DB",
    ],
  };
}

async function readRows(): Promise<M06BaselineRows> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is required");
  if (process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED !== "false") {
    fail(`WORKSPACE_PUBLISH_EXECUTION_ENABLED must be literal false, got ${JSON.stringify(process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED)}`);
  }

  const connection = await mysql.createConnection(databaseUrl);
  try {
    const select = async (sql: string, values: unknown[] = []) => {
      if (!/^\s*SELECT\b/i.test(sql)) fail("baseline verifier attempted a non-SELECT SQL statement");
      const [result] = await connection.query(sql, values);
      return result as Row[];
    };

    const candidateWorkspace = await select(
      `SELECT wn.id AS workspaceNovelId, wn.workspaceId, wn.novelId,
              wn.status AS workspaceNovelStatus, w.status AS workspaceStatus
         FROM workspaceNovels wn
         JOIN workspaceWorkspaces w ON w.id = wn.workspaceId
        WHERE wn.id = ? AND wn.workspaceId = ? AND wn.novelId = ?`,
      [M06_PREVIEW_BASELINE.candidate.workspaceNovelId, M06_PREVIEW_BASELINE.candidate.workspaceId, M06_PREVIEW_BASELINE.candidate.novelId]
    );

    const candidateOwnership = await select(
      `SELECT id, workspaceNovelId, capability, owner, cutoverEpoch, version, changedBy, changedAt
         FROM workspaceMigrationRegistry
        WHERE workspaceNovelId = ? AND capability = 'publish'`,
      [M06_PREVIEW_BASELINE.candidate.workspaceNovelId]
    );

    const candidateTransitions = await select(
      `SELECT id, workspaceNovelId, publishRunId, direction, fromOwner, toOwner,
              fromEpoch, toEpoch, fromVersion, toVersion, actorUserId, createdAt
         FROM workspacePublishOwnershipTransitions
        WHERE workspaceNovelId = ?
        ORDER BY id`,
      [M06_PREVIEW_BASELINE.candidate.workspaceNovelId]
    );

    const candidateRun = await select(
      `SELECT pr.id AS publishRunId, pr.status AS runStatus, pr.idempotencyKey,
              pr.expectedLastPublishedSha256, pr.version AS runVersion, pr.snapshotId,
              pd.id AS destinationId, pd.workspaceNovelId, pd.targetType, pd.targetId,
              pd.status AS destinationStatus, pd.policyVersion
         FROM workspacePublishRuns pr
         JOIN workspacePublishingDestinations pd ON pd.id = pr.destinationId
        WHERE pr.id = ? AND pd.workspaceNovelId = ?`,
      [M06_PREVIEW_BASELINE.candidate.publishRunId, M06_PREVIEW_BASELINE.candidate.workspaceNovelId]
    );

    const candidateItems = await select(
      `SELECT id, runId, itemKey, episodeId, sourceSha256, status, providerReceipt,
              errorClass, version, finishedAt, createdAt
         FROM workspacePublishItems
        WHERE runId = ?
        ORDER BY id`,
      [M06_PREVIEW_BASELINE.candidate.publishRunId]
    );

    const candidateRunOutbox = await select(
      `SELECT id, publishRunId, eventType, idempotencyKey, ownershipEpoch, status,
              attempts, leaseOwner, leaseExpiresAt, availableAt, deliveredAt
         FROM workspaceOutbox
        WHERE publishRunId = ?
        ORDER BY id`,
      [M06_PREVIEW_BASELINE.candidate.publishRunId]
    );

    const candidateAllOutbox = await select(
      `SELECT o.id, o.publishRunId, o.eventType, o.idempotencyKey, o.ownershipEpoch,
              o.status, o.attempts, o.leaseOwner, o.leaseExpiresAt, o.availableAt, o.deliveredAt
         FROM workspaceOutbox o
         JOIN workspacePublishRuns pr ON pr.id = o.publishRunId
         JOIN workspacePublishingDestinations pd ON pd.id = pr.destinationId
        WHERE pd.workspaceNovelId = ?
        ORDER BY o.id`,
      [M06_PREVIEW_BASELINE.candidate.workspaceNovelId]
    );

    const candidateFingerprint = await select(
      `SELECT f.id, f.bindingId, f.snapshotId, f.normalizedSha256,
              f.lastPublishedSha256, f.version
         FROM workspacePublishRuns pr
         JOIN workspacePublishingDestinations pd ON pd.id = pr.destinationId
         JOIN workspaceDocumentSnapshots s ON s.id = pr.snapshotId
         JOIN workspaceDocumentBindings b
           ON b.documentId = s.documentId AND b.workspaceNovelId = pd.workspaceNovelId
         JOIN workspaceDocumentFingerprints f ON f.bindingId = b.id
        WHERE pr.id = ? AND b.status = 'active'
        ORDER BY f.id`,
      [M06_PREVIEW_BASELINE.candidate.publishRunId]
    );

    const controlWorkspace = await select(
      `SELECT wn.id AS workspaceNovelId, wn.workspaceId, wn.novelId,
              wn.status AS workspaceNovelStatus, w.status AS workspaceStatus
         FROM workspaceNovels wn
         JOIN workspaceWorkspaces w ON w.id = wn.workspaceId
        WHERE wn.id = ? AND wn.novelId = ?`,
      [M06_PREVIEW_BASELINE.control.workspaceNovelId, M06_PREVIEW_BASELINE.control.novelId]
    );

    const controlOwnership = await select(
      `SELECT id, workspaceNovelId, capability, owner, cutoverEpoch, version, changedBy, changedAt
         FROM workspaceMigrationRegistry
        WHERE workspaceNovelId = ? AND capability = 'publish'`,
      [M06_PREVIEW_BASELINE.control.workspaceNovelId]
    );

    const controlTransitions = await select(
      `SELECT id, workspaceNovelId, publishRunId, direction, fromOwner, toOwner,
              fromEpoch, toEpoch, fromVersion, toVersion, actorUserId, createdAt
         FROM workspacePublishOwnershipTransitions
        WHERE workspaceNovelId = ?
        ORDER BY id`,
      [M06_PREVIEW_BASELINE.control.workspaceNovelId]
    );

    return {
      candidateWorkspace,
      candidateOwnership,
      candidateTransitions,
      candidateRun,
      candidateItems,
      candidateRunOutbox,
      candidateAllOutbox,
      candidateFingerprint,
      controlWorkspace,
      controlOwnership,
      controlTransitions,
    };
  } finally {
    await connection.end();
  }
}

function syntheticRows(): M06BaselineRows {
  return {
    candidateWorkspace: [{ workspaceId: 2, workspaceNovelId: 2, novelId: 4020002, workspaceStatus: "active", workspaceNovelStatus: "active" }],
    candidateOwnership: [{ capability: "publish", owner: "workspace", cutoverEpoch: 1, version: 2 }],
    candidateTransitions: [{ publishRunId: 2, direction: "cutover", fromOwner: "sheets", toOwner: "workspace", fromEpoch: 0, toEpoch: 1, fromVersion: 1, toVersion: 2 }],
    candidateRun: [{ publishRunId: 2, workspaceNovelId: 2, targetType: "novel", targetId: 4020002, destinationStatus: "active", runStatus: "ready" }],
    candidateItems: [{ status: "published", providerReceipt: "preview-m06-positive-synthetic-receipt" }],
    candidateRunOutbox: [],
    candidateAllOutbox: [],
    candidateFingerprint: [{ lastPublishedSha256: null }],
    controlWorkspace: [{ workspaceNovelId: 1, novelId: 4020003, workspaceNovelStatus: "active" }],
    controlOwnership: [{ capability: "publish", owner: "sheets", cutoverEpoch: 2, version: 3 }],
    controlTransitions: [
      { direction: "cutover", fromOwner: "sheets", toOwner: "workspace", fromEpoch: 0, toEpoch: 1, fromVersion: 1, toVersion: 2 },
      { direction: "rollback", fromOwner: "workspace", toOwner: "sheets", fromEpoch: 1, toEpoch: 2, fromVersion: 2, toVersion: 3 },
    ],
  };
}

export function runM06PreviewBaselineSelfTest() {
  const pass = validateM06PreviewBaseline(syntheticRows());
  const drifted = syntheticRows();
  drifted.candidateOwnership = [{ capability: "publish", owner: "sheets", cutoverEpoch: 2, version: 3 }];
  let failClosed = false;
  try {
    validateM06PreviewBaseline(drifted);
  } catch {
    failClosed = true;
  }
  if (!failClosed) throw new Error("self-test failed: ownership drift did not fail closed");
  return { selfTestPass: true as const, baselinePass: pass.baselinePass, failClosed };
}

async function main() {
  if (process.argv.includes("--self-test")) {
    console.log(JSON.stringify(runM06PreviewBaselineSelfTest(), null, 2));
    return;
  }
  const rows = await readRows();
  const result = validateM06PreviewBaseline(rows);
  console.log(JSON.stringify({
    ...result,
    executionEnabled: process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true",
  }, null, 2));
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
