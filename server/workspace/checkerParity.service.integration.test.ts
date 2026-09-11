import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceCheckerRuns,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
} from "./googleDocs.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindPublicationNovel, createWorkspace } from "./service";
import {
  compareCheckerRunWithCopiedLegacy,
  executeCheckerRun,
  getCheckerRunDetail,
  listCheckerRuns,
  publishCheckerRuleSet,
  queueCheckerRun,
} from "./checkerKanban.service";
import { WORKSPACE_CHECKER_ENGINE_VERSION } from "./checkerParity.domain";

const COPIED_LEGACY_FINDINGS = [
  {
    ruleKey: "snapshot.byteLength.minimum",
    severity: "error" as const,
    locationKey: "snapshot:byteLength",
    excerptSha256: "b6d404aafed6ebef5502e17c3781ba75e06d29cfc52710f1d4884d5b6d41a3f5",
  },
] as const;

describe.sequential("workspace M03-B checker parity execution", () => {
  it("executes deterministic snapshot rules, persists/read findings, and reaches zero-variance copied-legacy parity while Sheets remains owner", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M03-B parity tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m03b-google-owner",
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
        providerFileId: "doc_m03b_parity",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M03-B fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m03b-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "m03b-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({
            providerFileId: "doc_m03b_parity",
            revision: "rev-m03b-1",
            mimeType: GOOGLE_DOC_MIME_TYPE,
            title: "M03-B fixture",
          })),
          getNormalizedText: vi.fn(async () => "fixture"),
          revoke: vi.fn(async () => undefined),
        },
      });

      const ruleSet = await publishCheckerRuleSet({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        name: "m03b-synthetic-copied-legacy",
        versionNo: 1,
        engineVersion: WORKSPACE_CHECKER_ENGINE_VERSION,
        rulesJson: JSON.stringify({
          version: 1,
          failOn: "error",
          rules: [
            {
              key: "snapshot.byteLength.minimum",
              field: "byteLength",
              operator: "gte",
              value: 100,
              severity: "error",
              locationKey: "snapshot:byteLength",
              message: "Synthetic copied input expects at least 100 bytes.",
            },
          ],
        }),
      });
      const run = await queueCheckerRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        snapshotId: observation.snapshotId,
        ruleSetId: ruleSet.ruleSet.id,
      });
      const executed = await executeCheckerRun({
        runId: run.id,
        workspaceId: workspace.workspaceId,
        leaseOwner: "m03b-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      expect(executed.status).toBe("failed");
      expect(executed.findings).toHaveLength(1);
      expect(executed.findings[0].excerptSha256).toBe(COPIED_LEGACY_FINDINGS[0].excerptSha256);

      const detail = await getCheckerRunDetail({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: run.id,
      });
      expect(detail.run.status).toBe("failed");
      expect(detail.findings).toHaveLength(1);
      expect(detail.findings[0]).toMatchObject(COPIED_LEGACY_FINDINGS[0]);

      const runs = await listCheckerRuns({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(runs.some(item => item.run.id === run.id)).toBe(true);

      const parity = await compareCheckerRunWithCopiedLegacy({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: run.id,
        legacyFindings: [...COPIED_LEGACY_FINDINGS],
      });
      expect(parity).toEqual({
        pass: true,
        missing: [],
        unexpected: [],
        severityMismatch: [],
        locationMismatch: [],
        duplicateLegacy: 0,
        duplicateWorkspace: 0,
      });

      const ownership = await db
        .select()
        .from(workspaceMigrationRegistry)
        .where(and(
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
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
