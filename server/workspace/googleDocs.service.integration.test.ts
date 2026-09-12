import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  novels,
  users,
  workspaceAuditEvents,
  workspaceDocumentFingerprints,
  workspaceDocumentSnapshots,
  workspaceGoogleConnections,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  bindPublicationNovel,
  createWorkspace,
} from "./service";
import {
  bindGoogleDocument,
  consumeGoogleConsentAttempt,
  createGoogleConsentAttempt,
  listDocumentFingerprints,
  observeBoundGoogleDocument,
  revokeGoogleConnection,
  rotateGoogleConnectionCredential,
  saveGoogleConnection,
  WorkspaceDocsServiceError,
} from "./googleDocs.service";
import {
  createAesGcmTokenCipher,
  GOOGLE_DOC_MIME_TYPE,
} from "./googleDocs.domain";

describe.sequential("workspace M02 Docs persistence integration", () => {
  it("enforces platform-admin/connection ownership and persists repeat observations idempotently", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const outsider = await createTestUser();
    const adminPeer = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, "Docs tenant");
    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: "google-sub-owner",
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
        providerFileId: "doc_immutable_1",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Draft",
        role: "chapter",
        sequence: 1,
        correlationId: "bind-1",
      });
      const adapter = {
        getMetadata: vi.fn(async () => ({
          providerFileId: "doc_immutable_1",
          revision: "rev-7",
          mimeType: GOOGLE_DOC_MIME_TYPE,
          title: "Draft",
        })),
        getNormalizedText: vi.fn(async () => "chapter body"),
        revoke: vi.fn(async () => undefined),
      };
      const [first, second] = await Promise.all([
        observeBoundGoogleDocument({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          bindingId: binding.bindingId,
          accessToken: "server-only",
          correlationId: "observe-1",
          adapter,
        }),
        observeBoundGoogleDocument({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          bindingId: binding.bindingId,
          accessToken: "server-only",
          correlationId: "observe-2",
          adapter,
        }),
      ]);
      expect(first.snapshotId).toBe(second.snapshotId);
      const snapshots = await db
        .select()
        .from(workspaceDocumentSnapshots)
        .where(eq(workspaceDocumentSnapshots.documentId, binding.documentId));
      expect(snapshots).toHaveLength(1);
      expect(JSON.stringify(second)).not.toContain("chapter body");

      let fingerprints = await db
        .select()
        .from(workspaceDocumentFingerprints)
        .where(eq(workspaceDocumentFingerprints.bindingId, binding.bindingId));
      expect(fingerprints).toHaveLength(1);
      expect(fingerprints[0]).toMatchObject({
        snapshotId: first.snapshotId,
        providerRevisionId: "rev-7",
        normalizedSha256: first.fingerprint.contentHash,
        normalizationVersion: first.fingerprint.normalizationVersion,
      });

      adapter.getMetadata.mockResolvedValueOnce({
        providerFileId: "doc_immutable_1",
        revision: "rev-8",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Draft updated",
      });
      adapter.getNormalizedText.mockResolvedValueOnce("chapter body changed");
      const changed = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "observe-3",
        adapter,
      });
      expect(changed.snapshotId).not.toBe(first.snapshotId);
      fingerprints = await db
        .select()
        .from(workspaceDocumentFingerprints)
        .where(eq(workspaceDocumentFingerprints.bindingId, binding.bindingId));
      expect(fingerprints).toHaveLength(1);
      expect(fingerprints[0]).toMatchObject({
        snapshotId: changed.snapshotId,
        providerRevisionId: "rev-8",
        normalizedSha256: changed.fingerprint.contentHash,
      });
      expect(fingerprints[0].version).toBeGreaterThan(1);

      await expect(
        listDocumentFingerprints({
          actorUserId: outsider.id,
          workspaceId: workspace.workspaceId,
        })
      ).rejects.toMatchObject<Partial<WorkspaceDocsServiceError>>({
        code: "ADMIN_REQUIRED",
      });
      const fingerprintReadModel = await listDocumentFingerprints({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
      });
      expect(fingerprintReadModel).toHaveLength(1);
      expect(fingerprintReadModel[0].fingerprint.snapshotId).toBe(changed.snapshotId);
      expect(JSON.stringify(fingerprintReadModel)).not.toContain("chapter body changed");

      const cipher = createAesGcmTokenCipher(
        new Map([[1, Buffer.alloc(32, 9)]]),
        1
      );
      const consent = await createGoogleConsentAttempt({
        userId: owner.id,
        authorizationEndpoint: "https://accounts.google.test/o/oauth2/auth",
        clientId: "workspace-client",
        fixedRedirectUri: "https://ipenovel.test/api/workspace/google/callback",
        cipher,
      });
      const state = new URL(consent.authorizationUrl).searchParams.get("state");
      expect(state).toBeTruthy();
      const consumed = await consumeGoogleConsentAttempt({
        userId: owner.id,
        state: state!,
        cipher,
      });
      expect(consumed.codeVerifier).toBeTruthy();
      await expect(
        consumeGoogleConsentAttempt({
          userId: owner.id,
          state: state!,
          cipher,
        })
      ).rejects.toMatchObject<Partial<WorkspaceDocsServiceError>>({
        code: "CONSENT_ATTEMPT_INVALID",
      });

      const [connectionBeforeRotation] = await db
        .select()
        .from(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.id, connection.connectionId));
      const rotated = await rotateGoogleConnectionCredential({
        actorUserId: owner.id,
        connectionId: connection.connectionId,
        expectedVersion: connectionBeforeRotation.version,
        returnedRefreshToken: "rotated-refresh-token",
        cipher,
      });
      expect(rotated.version).toBe(connectionBeforeRotation.version + 1);
      const revoke = vi.fn(async () => undefined);
      const revocation = await revokeGoogleConnection({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        connectionId: connection.connectionId,
        correlationId: "revoke-1",
        cipher,
        adapter: {
          getMetadata: vi.fn(),
          getNormalizedText: vi.fn(),
          revoke,
        },
      });
      expect(revocation).toEqual({
        status: "revoked",
        providerRevocationSucceeded: true,
      });
      const [storedConnection] = await db
        .select()
        .from(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.id, connection.connectionId));
      expect(storedConnection.encryptedRefreshToken).toBeNull();
      expect(storedConnection.status).toBe("revoked");
      const auditRows = await db
        .select()
        .from(workspaceAuditEvents)
        .where(eq(workspaceAuditEvents.correlationId, "revoke-1"));
      expect(auditRows).toHaveLength(1);

      await expect(
        observeBoundGoogleDocument({
          actorUserId: adminPeer.id,
          workspaceId: workspace.workspaceId,
          bindingId: binding.bindingId,
          accessToken: "server-only",
          correlationId: "observe-admin-peer",
          adapter,
        })
      ).rejects.toMatchObject<Partial<WorkspaceDocsServiceError>>({
        code: "CONNECTION_OWNERSHIP_REQUIRED",
      });
    } finally {
      await db
        .delete(workspaceWorkspaces)
        .where(eq(workspaceWorkspaces.id, workspace.workspaceId));
      await db
        .delete(workspaceGoogleConnections)
        .where(eq(workspaceGoogleConnections.userId, owner.id));
      await db.delete(novels).where(eq(novels.id, novel.id));
      await db.delete(users).where(eq(users.id, owner.id));
      await db.delete(users).where(eq(users.id, outsider.id));
      await db.delete(users).where(eq(users.id, adminPeer.id));
    }
  });
});
