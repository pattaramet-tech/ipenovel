import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  novels,
  users,
  workspaceAiJobAttempts,
  workspaceAiJobs,
  workspaceGoogleConnections,
  workspaceMigrationRegistry,
  workspaceWorkspaces,
} from "../../drizzle/schema";
import { assertSafeTestDatabaseUrl } from "../test-helpers/testDatabaseGuard";
import { getTestDb } from "../test-helpers/testDb";
import { createTestNovel, createTestUser } from "../test-helpers/fixtures";
import { bindPublicationNovel, createWorkspace } from "./service";
import { saveGoogleConnection } from "./googleDocs.service";
import {
  createWorkspaceGoogleDocsTokenCipher,
  resolveWorkspaceGoogleDocsAiQcExecutionRuntime,
} from "./googleDocs.runtime";
import { resolveTransientAiQcContent } from "./aiQc.service";
import { runScopedAiQcWorkerOnce } from "./aiQc.worker";
import { prepareWorkspaceAiQcRealCandidate } from "./aiQc.realCandidate";

const DOC_ID = "1D2ARealGoogleDocAbCdEfGhIjKlMnOp";
const TOKEN_KEY = "21".repeat(32);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
describe.sequential("IPE-054-D2A real candidate integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refreshes read-only Google access, observes a real document, and queues zero-attempt AI QC", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    vi.stubEnv("WORKSPACE_AI_QC_RUNTIME_TARGET", "preview");
    vi.stubEnv("WORKSPACE_AI_QC_PROVIDER_ENABLED", "false");
    vi.stubEnv("WORKSPACE_AI_QC_EXECUTION_ENABLED", "false");
    vi.stubEnv("WORKSPACE_PUBLISH_EXECUTION_ENABLED", "false");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "d2a-client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "d2a-client-secret");
    vi.stubEnv(
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI",
      "https://r2-preview.ipenovel.com/api/workspace/google/callback"
    );
    vi.stubEnv("WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY", TOKEN_KEY);

    const db = getTestDb();
    const owner = await createTestUser({ role: "admin" });
    const novel = await createTestNovel();
    const workspace = await createWorkspace(owner.id, `D2A ${Date.now()}`);
    try {
      const workspaceNovel = await bindPublicationNovel({
        actorUserId: owner.id,
        workspaceId: workspace.workspaceId,
        novelId: novel.id,
      });
      const cipher = createWorkspaceGoogleDocsTokenCipher(TOKEN_KEY);
      const connection = await saveGoogleConnection({
        userId: owner.id,
        providerSubject: `d2a-owner-${owner.id}`,
        credential: cipher.encrypt("refresh-token-d2a"),
        grantedScopes:
          "https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/documents.readonly",
      });

      const fetchImpl = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const value = String(url);
          if (value === "https://oauth2.googleapis.com/token") {
            expect(init?.method).toBe("POST");
            const body = new URLSearchParams(String(init?.body));
            expect(body.get("refresh_token")).toBe("refresh-token-d2a");
            expect(body.get("grant_type")).toBe("refresh_token");
            return json({ access_token: "d2a-access-token", expires_in: 3600 });
          }
          if (value.includes("/drive/v3/files/")) {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer d2a-access-token"
            );
            return json({
              id: DOC_ID,
              name: "D2A Real Preview Draft",
              mimeType: "application/vnd.google-apps.document",
              version: "41",
              trashed: false,
            });
          }
          if (value.includes("docs.googleapis.com/v1/documents/")) {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer d2a-access-token"
            );
            return json({
              tabs: [
                {
                  documentTab: {
                    body: {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              {
                                textRun: {
                                  content: "D2A real document body\n",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            });
          }
          throw new Error(`unexpected URL: ${value}`);
        }
      ) as unknown as typeof fetch;
      const result = await prepareWorkspaceAiQcRealCandidate(
        {
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          workspaceNovelId: workspaceNovel.workspaceNovelId,
          connectionId: connection.connectionId,
          providerFileId: DOC_ID,
        },
        { fetchImpl }
      );

      expect(result).toMatchObject({
        workspaceId: workspace.workspaceId,
        workspaceNovelId: workspaceNovel.workspaceNovelId,
        connectionId: connection.connectionId,
        operation: "semantic_qc",
        created: true,
      });
      expect(result.scope).toBe(
        `workspaceId=${workspace.workspaceId},jobId=${result.jobId},snapshotId=${result.snapshotId},requestKey=${result.requestKey}`
      );
      expect(result.requestKey).toMatch(/^[a-f0-9]{64}$/);

      await db
        .update(workspaceGoogleConnections)
        .set({ status: "revoked" })
        .where(eq(workspaceGoogleConnections.id, connection.connectionId));
      await expect(
        resolveWorkspaceGoogleDocsAiQcExecutionRuntime({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          snapshotId: result.snapshotId,
          fetchImpl,
        })
      ).rejects.toMatchObject({ code: "AI_QC_SOURCE_INVALID" });
      await db
        .update(workspaceGoogleConnections)
        .set({ status: "active", revokedAt: null })
        .where(eq(workspaceGoogleConnections.id, connection.connectionId));

      const tokenFailureFetch = vi.fn(async () =>
        json({ error: "invalid_grant" }, 400)
      ) as unknown as typeof fetch;
      await expect(
        resolveWorkspaceGoogleDocsAiQcExecutionRuntime({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          snapshotId: result.snapshotId,
          fetchImpl: tokenFailureFetch,
        })
      ).rejects.toMatchObject({ code: "GOOGLE_TOKEN_EXCHANGE_FAILED" });

      const revisionOnlyFetch = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const value = String(url);
          if (value.includes("/drive/v3/files/")) {
            return json({
              id: DOC_ID,
              name: "D2A Real Preview Draft",
              mimeType: "application/vnd.google-apps.document",
              version: "42",
              trashed: false,
            });
          }
          return fetchImpl(url, init);
        }
      ) as unknown as typeof fetch;
      const revisionRuntime =
        await resolveWorkspaceGoogleDocsAiQcExecutionRuntime({
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          snapshotId: result.snapshotId,
          fetchImpl: revisionOnlyFetch,
        });
      await expect(
        resolveTransientAiQcContent({
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          accessToken: revisionRuntime.accessToken,
          docsAdapter: revisionRuntime.docsAdapter,
        })
      ).rejects.toMatchObject({ code: "AI_QC_SOURCE_INVALID" });

      const staleFetch = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const value = String(url);
          if (value.includes("docs.googleapis.com/v1/documents/")) {
            return json({
              tabs: [
                {
                  documentTab: {
                    body: {
                      content: [
                        {
                          paragraph: {
                            elements: [
                              {
                                textRun: {
                                  content: "changed after snapshot\n",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            });
          }
          return fetchImpl(url, init);
        }
      ) as unknown as typeof fetch;
      const staleRuntime = await resolveWorkspaceGoogleDocsAiQcExecutionRuntime(
        {
          actorUserId: owner.id,
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          snapshotId: result.snapshotId,
          fetchImpl: staleFetch,
        }
      );
      await expect(
        resolveTransientAiQcContent({
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          accessToken: staleRuntime.accessToken,
          docsAdapter: staleRuntime.docsAdapter,
        })
      ).rejects.toMatchObject({ code: "SOURCE_SNAPSHOT_MISMATCH" });

      const provider = {
        mode: "mock" as const,
        execute: vi.fn(async (providerInput: { content: string }) => {
          expect(providerInput.content).toBe("D2A real document body");
          return {
            providerRequestId: "d2a-mock-receipt-001",
            providerName: "mock-provider",
            model: "mock-qc-v1",
            findings: [],
          };
        }),
        reconcile: vi.fn(async () => null),
      };
      const artifactStore = { putJson: vi.fn(async () => undefined) };
      const workerResult = await runScopedAiQcWorkerOnce({
        actorUserId: owner.id,
        scope: {
          workspaceId: workspace.workspaceId,
          jobId: result.jobId,
          snapshotId: result.snapshotId,
          requestKey: result.requestKey,
        },
        leaseOwner: "ipe054d2a-worker",
        artifactStore,
        provider,
        executionEnabled: true,
        leaseSeconds: 60,
        maxAttempts: 1,
        resolveDocsRuntime: () =>
          resolveWorkspaceGoogleDocsAiQcExecutionRuntime({
            actorUserId: owner.id,
            workspaceId: workspace.workspaceId,
            jobId: result.jobId,
            snapshotId: result.snapshotId,
            fetchImpl,
          }),
      });
      expect(workerResult).toMatchObject({ action: "execute" });
      expect(provider.execute).toHaveBeenCalledTimes(1);
      expect(artifactStore.putJson).toHaveBeenCalledTimes(1);

      const [job] = await db
        .select()
        .from(workspaceAiJobs)
        .where(eq(workspaceAiJobs.id, result.jobId));
      expect(job).toMatchObject({
        status: "succeeded",
        snapshotId: result.snapshotId,
        operation: "semantic_qc",
      });
      const attempts = await db
        .select()
        .from(workspaceAiJobAttempts)
        .where(eq(workspaceAiJobAttempts.jobId, result.jobId));
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: "succeeded",
        providerRequestId: "d2a-mock-receipt-001",
      });

      const ownership = await db
        .select()
        .from(workspaceMigrationRegistry)
        .where(
          eq(
            workspaceMigrationRegistry.workspaceNovelId,
            workspaceNovel.workspaceNovelId
          )
        );
      expect(ownership.find(row => row.capability === "ai_queue")?.owner).toBe(
        "sheets"
      );
      expect(JSON.stringify(result)).not.toContain("D2A real document body");
      expect(JSON.stringify(result)).not.toContain("d2a-access-token");
      expect(JSON.stringify(result)).not.toContain("refresh-token-d2a");
    } finally {
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
