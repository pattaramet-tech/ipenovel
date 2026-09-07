import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceCheckerFindings,
  workspaceCheckerRuns,
  workspaceGoogleConnections,
  workspaceKanbanTransitions,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { WORKSPACE_CHECKER_ENGINE_VERSION } from "./checkerParity.domain";
import {
  createKanbanBoard,
  createKanbanCardFromFingerprint,
  executeCheckerRun,
  listOperationalReconciliationState,
  publishCheckerRuleSet,
  queueCheckerRun,
  reconcileCopiedLegacyOperationalState,
  transitionKanbanCard,
} from "./checkerKanban.service";
import { bindPublicationNovel, createWorkspace } from "./service";

describe.sequential("workspace M03-C operational reconciliation", () => {
  it("builds a membership-gated operational projection and reconciles copied legacy input without side effects", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M03-C operational tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m03c-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m03c_operational",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M03-C fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m03c-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m03c-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m03c_operational",
            revision: "rev-m03c-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M03-C fixture",
          })),
          getNormalizedText: vi.fn(async () => "m03c deterministic fixture"),
          revoke: vi.fn(async () => undefined),
        },
      });
      const published = await publishCheckerRuleSet({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "m03c-operational-pass",
        versionNo: 1,
        engineVersion: WORKSPACE_CHECKER_ENGINE_VERSION,
        rulesJson: JSON.stringify({
          version: 1,
          failOn: "error",
          rules: [{
            key: "snapshot.byteLength.positive",
            field: "byteLength",
            operator: "gte",
            value: 1,
            severity: "error",
            locationKey: "snapshot:byteLength",
            message: "Snapshot must contain bytes.",
          }],
        }),
      });
      const run = await queueCheckerRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        ruleSetId: published.ruleSet.id,
      });
      await executeCheckerRun({
        runId: run.id,
        workspaceId: workspace.workspaceId,
        leaseOwner: "m03c-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });

      const board = await createKanbanBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "M03-C board",
        slug: "m03c-board",
        columns: [
          { key: "observed", name: "Observed", position: 0 },
          { key: "checked", name: "Checked", position: 1 },
        ],
      });
      const card = await createKanbanCardFromFingerprint({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        boardId: board.boardId,
        columnKey: "observed",
        bindingId: binding.bindingId,
        logicalItemKey: `binding:${binding.bindingId}`,
      });
      await transitionKanbanCard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        cardId: card.id,
        toColumnKey: "checked",
        reason: "operator acknowledged copied checker parity",
        idempotencyKey: "m03c-checked",
        expectedVersion: card.version,
      });

      await expect(listOperationalReconciliationState({
        actorUserId: outsider.id,
        workspaceId: workspace.workspaceId,
      })).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });

      const beforeCounts = {
        runs: (await db.select().from(workspaceCheckerRuns)).length,
        findings: (await db.select().from(workspaceCheckerFindings)).length,
        transitions: (await db.select().from(workspaceKanbanTransitions)).length,
      };
      const state = await listOperationalReconciliationState({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({
        bindingId: binding.bindingId,
        checkerStatus: "passed",
        parityStatus: "not_compared",
        kanbanProjectionStatus: "consistent",
      });
      expect(state[0].checker?.run.id).toBe(run.id);
      expect(state[0].checker?.findings).toEqual([]);
      expect(state[0].checker?.severityCounts).toEqual({ info: 0, warning: 0, error: 0 });
      expect(state[0].kanban).toHaveLength(1);
      expect(state[0].kanban[0].latestTransition?.idempotencyKey).toBe("m03c-checked");
      expect(state[0].ownership?.owner).toBe("sheets");

      const reconciliation = await reconcileCopiedLegacyOperationalState({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        baselines: [{
          bindingId: binding.bindingId,
          runId: run.id,
          providerRevisionId: observation.fingerprint.revision,
          normalizedSha256: observation.fingerprint.contentHash,
          ruleSetContentSha256: published.ruleSet.contentSha256,
          legacyFindings: [],
        }],
      });
      expect(reconciliation.results[0]).toMatchObject({
        runMatches: true,
        revisionMatches: true,
        hashMatches: true,
        ruleSetMatches: true,
        ownershipMatches: true,
        kanbanMatches: true,
        parity: { pass: true },
      });
      expect(reconciliation.pass).toBe(true);
      expect(reconciliation.summary).toEqual({
        total: 1,
        failed: 0,
        missingBinding: 0,
        runMismatch: 0,
        hashMismatch: 0,
        revisionMismatch: 0,
        ruleSetMismatch: 0,
        ownershipMismatch: 0,
        kanbanProjectionMismatch: 0,
        parityMismatch: 0,
      });
      expect(reconciliation.results[0]).toMatchObject({
        pass: true,
        runMatches: true,
        revisionMatches: true,
        hashMatches: true,
        ruleSetMatches: true,
        ownershipMatches: true,
        kanbanMatches: true,
      });

      const runMismatch = await reconcileCopiedLegacyOperationalState({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        baselines: [{
          bindingId: binding.bindingId,
          runId: run.id + 1,
          providerRevisionId: observation.fingerprint.revision,
          normalizedSha256: observation.fingerprint.contentHash,
          ruleSetContentSha256: published.ruleSet.contentSha256,
          legacyFindings: [],
        }],
      });
      expect(runMismatch.pass).toBe(false);
      expect(runMismatch.results[0]).toMatchObject({ pass: false, runMatches: false });
      expect(runMismatch.summary).toMatchObject({ failed: 1, runMismatch: 1 });

      await listOperationalReconciliationState({ actorUserId: owner.id, workspaceId: workspace.workspaceId });
      await reconcileCopiedLegacyOperationalState({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        baselines: [{
          bindingId: binding.bindingId,
          runId: run.id,
          providerRevisionId: observation.fingerprint.revision,
          normalizedSha256: observation.fingerprint.contentHash,
          ruleSetContentSha256: published.ruleSet.contentSha256,
          legacyFindings: [],
        }],
      });
      const afterCounts = {
        runs: (await db.select().from(workspaceCheckerRuns)).length,
        findings: (await db.select().from(workspaceCheckerFindings)).length,
        transitions: (await db.select().from(workspaceKanbanTransitions)).length,
      };
      expect(afterCounts).toEqual(beforeCounts);

      const ownership = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "checker"),
      ));
      expect(ownership).toHaveLength(1);
      expect(ownership[0].owner).toBe("sheets");
      expect(ownership[0].cutoverEpoch).toBe(0);
    } finally {
      await db.delete(workspaceCheckerRuns);
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, outsider.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
