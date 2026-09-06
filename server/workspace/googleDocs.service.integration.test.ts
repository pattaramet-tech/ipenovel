import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  novels,
  users,
  workspaceGoogleConnections,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import {
  bindPublicationNovel,
  createWorkspace,
  addOrUpdateMember,
} from "./service";
import {
  bindGoogleDocument,
  observeBoundGoogleDocument,
  saveGoogleConnection,
  WorkspaceDocsServiceError,
} from "./googleDocs.service";
import { GOOGLE_DOC_MIME_TYPE } from "./googleDocs.domain";

describe.sequential("workspace M02 Docs persistence integration", () => {
  it("enforces membership/connection ownership and persists repeat observations idempotently", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    const db = getTestDb();
    const owner = await createTestUser();
    const outsider = await createTestUser();
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
        grantedScopes: "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
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
      const first = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "observe-1",
        adapter,
      });
      const second = await observeBoundGoogleDocument({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        bindingId: binding.bindingId,
        accessToken: "server-only",
        correlationId: "observe-2",
        adapter,
      });
      expect(first.created).toBe(true);
      expect(second).toEqual(
        expect.objectContaining({
          snapshotId: first.snapshotId,
          created: false,
        })
      );
      expect(JSON.stringify(second)).not.toContain("chapter body");

      await addOrUpdateMember({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        userId: outsider.id,
        role: "editor",
      });
      await expect(
        observeBoundGoogleDocument({
          actorUserId: outsider.id,
          workspaceId: workspace.workspaceId,
          bindingId: binding.bindingId,
          accessToken: "server-only",
          correlationId: "observe-outsider",
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
    }
  });
});
