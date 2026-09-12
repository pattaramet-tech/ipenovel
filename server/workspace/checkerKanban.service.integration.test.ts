import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  novels,
  users,
  workspaceCheckerFindings,
  workspaceCheckerRuns,
  workspaceKanbanBoards,
  workspaceKanbanCards,
  workspaceKanbanColumns,
  workspaceKanbanTransitions,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
  workspaceGoogleConnections,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { bindPublicationNovel, createWorkspace } from "./service";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { WORKSPACE_CHECKER_ENGINE_VERSION } from "./checkerParity.domain";
import {
  claimCheckerRun,
  completeCheckerRun,
  createKanbanBoard,
  createKanbanCardFromFingerprint,
  publishCheckerRuleSet,
  queueCheckerRun,
  transitionKanbanCard,
} from "./checkerKanban.service";

describe.sequential("workspace M03 Checker/Kanban dual-run foundation", () => {
  it("dedupes checker work, persists deterministic findings, and projects idempotent Kanban transitions while Sheets keeps ownership", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M03 dual-run tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m03-google-owner",
        credential: {
          keyVersion: 1,
          encryptedRefreshToken: "v1.redacted.ciphertext.tag",
        },
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m03_dual_run",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M03 fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m03-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m03-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m03_dual_run",
            revision: "rev-m03-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M03 fixture",
          })),
          getNormalizedText: vi.fn(async () => "deterministic checker fixture"),
          revoke: vi.fn(async () => undefined),
        },
      });

      const currentObservation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m03-observe-current",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m03_dual_run",
            revision: "rev-m03-2",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M03 fixture current",
          })),
          getNormalizedText: vi.fn(async () => "deterministic checker fixture changed"),
          revoke: vi.fn(async () => undefined),
        },
      });
      expect(currentObservation.snapshotId).not.toBe(observation.snapshotId);

      const rules = await publishCheckerRuleSet({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "dual-run-baseline",
        versionNo: 1,
        engineVersion: WORKSPACE_CHECKER_ENGINE_VERSION,
        rulesJson: JSON.stringify({
          version: 1,
          failOn: "error",
          rules: [{
            key: "snapshot.byteLength.min",
            field: "byteLength",
            operator: "gte",
            value: 1,
            severity: "error",
            locationKey: "snapshot:byteLength",
            message: "Snapshot byte length must be positive.",
          }],
        }),
      });
      const sameRules = await publishCheckerRuleSet({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "dual-run-baseline-copy",
        versionNo: 99,
        engineVersion: WORKSPACE_CHECKER_ENGINE_VERSION,
        rulesJson: JSON.stringify({
          version: 1,
          failOn: "error",
          rules: [{
            key: "snapshot.byteLength.min",
            field: "byteLength",
            operator: "gte",
            value: 1,
            severity: "error",
            locationKey: "snapshot:byteLength",
            message: "Snapshot byte length must be positive.",
          }],
        }),
      });
      expect(sameRules.ruleSet.id).toBe(rules.ruleSet.id);
      expect(sameRules.created).toBe(false);

      const [runA, runB] = await Promise.all([
        queueCheckerRun({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          snapshotId: observation.snapshotId,
          ruleSetId: rules.ruleSet.id,
        }),
        queueCheckerRun({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          snapshotId: observation.snapshotId,
          ruleSetId: rules.ruleSet.id,
        }),
      ]);
      expect(runA.id).toBe(runB.id);

      await claimCheckerRun({
        runId: runA.id,
        leaseOwner: "checker-worker-test",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const excerptSha256 = "a".repeat(64);
      await completeCheckerRun({
        runId: runA.id,
        leaseOwner: "checker-worker-test",
        status: "failed",
        findings: [
          {
            ruleKey: "synthetic.required",
            severity: "error",
            locationKey: "chapter:1",
            excerptSha256,
            message: "Synthetic deterministic finding",
          },
          {
            ruleKey: "synthetic.required",
            severity: "error",
            locationKey: "chapter:1",
            excerptSha256,
            message: "Synthetic deterministic finding",
          },
        ],
      });
      const findings = await db
        .select()
        .from(workspaceCheckerFindings)
        .where(eq(workspaceCheckerFindings.runId, runA.id));
      expect(findings).toHaveLength(1);
      const [storedRun] = await db
        .select()
        .from(workspaceCheckerRuns)
        .where(eq(workspaceCheckerRuns.id, runA.id));
      expect(storedRun.status).toBe("failed");
      expect(storedRun.leaseOwner).toBeNull();

      const expiredLeaseRun = await queueCheckerRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: currentObservation.snapshotId,
        ruleSetId: rules.ruleSet.id,
      });
      await claimCheckerRun({
        runId: expiredLeaseRun.id,
        leaseOwner: "expired-worker",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      });
      await expect(
        completeCheckerRun({
          runId: expiredLeaseRun.id,
          leaseOwner: "expired-worker",
          status: "passed",
          findings: [],
        })
      ).rejects.toMatchObject({ code: "CHECKER_RUN_CONFLICT" });

      const board = await createKanbanBoard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "Dual-run board",
        slug: "dual-run",
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
      await expect(
        createKanbanCardFromFingerprint({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          boardId: board.boardId,
          columnKey: "checked",
          bindingId: binding.bindingId,
          logicalItemKey: `binding:${binding.bindingId}`,
        })
      ).rejects.toMatchObject({ code: "KANBAN_CONFLICT" });

      const moved = await transitionKanbanCard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        cardId: card.id,
        toColumnKey: "checked",
        reason: "dual-run checker recorded",
        idempotencyKey: "m03-transition-1",
        expectedVersion: card.version,
      });
      const replay = await transitionKanbanCard({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        cardId: card.id,
        toColumnKey: "checked",
        reason: "dual-run checker recorded",
        idempotencyKey: "m03-transition-1",
        expectedVersion: card.version,
      });
      expect(moved.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      await expect(
        transitionKanbanCard({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          cardId: card.id,
          toColumnKey: "observed",
          reason: "different payload",
          idempotencyKey: "m03-transition-1",
          expectedVersion: card.version + 1,
        })
      ).rejects.toMatchObject({ code: "KANBAN_CONFLICT" });

      const transitions = await db
        .select()
        .from(workspaceKanbanTransitions)
        .where(eq(workspaceKanbanTransitions.cardId, card.id));
      expect(transitions).toHaveLength(2);
      expect(transitions.some(transition => transition.fromColumnId === null)).toBe(true);
      const [storedCard] = await db
        .select()
        .from(workspaceKanbanCards)
        .where(eq(workspaceKanbanCards.id, card.id));
      expect(storedCard.version).toBe(card.version + 1);

      const ownership = await db
        .select()
        .from(workspaceMigrationRegistry)
        .where(
          and(
            eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
            eq(workspaceMigrationRegistry.capability, "checker")
          )
        );
      expect(ownership).toHaveLength(1);
      expect(ownership[0].owner).toBe("sheets");
      expect(ownership[0].cutoverEpoch).toBe(0);
    } finally {
      await db.delete(workspaceKanbanTransitions);
      await db.delete(workspaceKanbanCards);
      await db.delete(workspaceKanbanColumns);
      await db.delete(workspaceKanbanBoards);
      await db.delete(workspaceCheckerRuns);
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db
        .delete(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
