import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  novels,
  users,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspacePublishItems,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";
import { bindGoogleDocument, observeBoundGoogleDocument, saveGoogleConnection } from "./googleDocs.service";
import { getLegacyRetirementCandidatePackage, requireLegacyRetirementCandidate, WorkspaceLegacyRetirementError } from "./legacyRetirement.service";
import { cutoverPublishOwnership, rollbackPublishOwnership } from "./publishOwnershipTransition.service";
import { createPublishDestination, createPublishDryRun } from "./publishDryRun.service";
import { bindPublicationNovel, createWorkspace } from "./service";

const passingEvidence = {
  sustainedParity: { passed: true, evidenceRef: "parity-window-2026w36" },
  slo: { passed: true, evidenceRef: "workspace-publish-slo-2026w36" },
  rollbackDrill: { passed: true, evidenceRef: "preview-m05d-cutover-rollback" },
  legacyActionFreeze: { passed: true, evidenceRef: "legacy-write-freeze-audit-1" },
};

const text = "M06 retirement candidate synthetic source";

describe.sequential("workspace M06 legacy retirement candidate", () => {
  it("proves candidate readiness without retiring legacy/ZIP paths and fails closed after rollback", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "M06 retirement candidate tenant");

    try {
      const workspaceNovel = await bindPublicationNovel({ actorUserId: owner.id, workspaceId: workspace.workspaceId, novelId: novel.id });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "m06-google-owner",
        credential: { keyVersion: 1, encryptedRefreshToken: "v1.redacted.ciphertext.tag" },
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });
      const binding = await bindGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        providerFileId: "doc_m06_retirement_candidate",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "M06 fixture",
        role: "chapter",
        sequence: 1,
        correlationId: "m06-bind",
      });
      const observation = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only-observe-token",
        correlationId: "m06-observe",
        adapter: {
          getMetadata: vi.fn(async () => ({ providerFileId: "doc_m06_retirement_candidate", revision: "rev-1", mimeType: GOOGLE_DOC_MIME_TYPE, title: "M06 fixture" })),
          getNormalizedText: vi.fn(async () => text),
          revoke: vi.fn(async () => undefined),
        },
      });
      const destination = await createPublishDestination({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        targetType: "novel",
        targetId: novel.id,
        policyVersion: "publish-policy-v1",
      });
      const plan = await createPublishDryRun({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        destinationId: destination.destination.id,
        snapshotId: observation.snapshotId,
        items: [{ itemKey: "chapter-1", sourceSha256: observation.fingerprint.contentHash }],
      });
      const [item] = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.runId, plan.run.id));
      await db.update(workspacePublishItems).set({ status: "published", providerReceipt: "receipt-m06-1" }).where(eq(workspacePublishItems.id, item.id));

      const [initialOwnership] = await db.select().from(workspaceMigrationRegistry).where(and(
        eq(workspaceMigrationRegistry.workspaceNovelId, workspaceNovel.workspaceNovelId),
        eq(workspaceMigrationRegistry.capability, "publish")
      ));
      await cutoverPublishOwnership({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedOwner: "sheets",
        expectedCutoverEpoch: 0,
        expectedVersion: initialOwnership.version,
      });

      const first = await getLegacyRetirementCandidatePackage({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        evidence: passingEvidence,
      });
      const second = await requireLegacyRetirementCandidate({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        evidence: passingEvidence,
      });

      expect(first.gate.retirementCandidateReady).toBe(true);
      expect(first.gate.blockers).toEqual([]);
      expect(first.gate.packageDigest).toBe(second.gate.packageDigest);
      expect(first.gate.safety).toMatchObject({ legacyPathsRetained: true, zipFallbackRetained: true, readExportFallbackRetained: true });
      expect(first.gate.separateHumanApprovalRequired).toBe(true);
      expect(first.gate.retirementApplied).toBe(false);
      expect(first.gate.automaticRetirement).toBe(false);
      expect(first.legacyMutationApplied).toBe(false);
      expect(first.zipMutationApplied).toBe(false);
      expect(first.registryMutationApplied).toBe(false);
      expect(first.publishDeliveryApplied).toBe(false);

      const blockedEvidence = await getLegacyRetirementCandidatePackage({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        evidence: { ...passingEvidence, slo: { passed: false, evidenceRef: "slo-not-yet-sustained" } },
      });
      expect(blockedEvidence.gate.blockers).toContain("SLO_EVIDENCE_MISSING");
      await expect(requireLegacyRetirementCandidate({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        evidence: { ...passingEvidence, slo: { passed: false, evidenceRef: "slo-not-yet-sustained" } },
      })).rejects.toMatchObject({ code: "RETIREMENT_CANDIDATE_BLOCKED" } satisfies Partial<WorkspaceLegacyRetirementError>);

      await rollbackPublishOwnership({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        runId: plan.run.id,
        expectedOwner: "workspace",
        expectedCutoverEpoch: 1,
        expectedVersion: initialOwnership.version + 1,
      });
      const afterRollback = await getLegacyRetirementCandidatePackage({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        evidence: passingEvidence,
      });
      expect(afterRollback.gate.retirementCandidateReady).toBe(false);
      expect(afterRollback.gate.blockers).toContain("PUBLISH_NOT_WORKSPACE_PRIMARY");
      expect(afterRollback.gate.blockers).toContain("OWNERSHIP_HISTORY_MISMATCH");
      const [itemAfter] = await db.select().from(workspacePublishItems).where(eq(workspacePublishItems.id, item.id));
      expect(itemAfter).toMatchObject({ status: "published", providerReceipt: "receipt-m06-1" });
    } finally {
      await db.delete(workspaceWorkspaces).where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db.delete(workspaceGoogleConnections).where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
    }
  });
});
