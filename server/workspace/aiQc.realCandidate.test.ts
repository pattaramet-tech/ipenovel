import { describe, expect, it, vi } from "vitest";
import { prepareWorkspaceAiQcRealCandidate } from "./aiQc.realCandidate";

const REQUEST_KEY = "a".repeat(64);
const DOC_ID = "1RealGoogleDocAbCdEfGhIjKlMnOp";
const disarmedEnv = {
  WORKSPACE_AI_QC_RUNTIME_TARGET: "preview",
  WORKSPACE_AI_QC_PROVIDER_ENABLED: "false",
  WORKSPACE_AI_QC_EXECUTION_ENABLED: "false",
  WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false",
} as NodeJS.ProcessEnv;

function deps(overrides: Record<string, unknown> = {}) {
  return {
    refreshAccessToken: vi.fn(async () => "access-token"),
    fetchMetadata: vi.fn(async () => ({
      id: DOC_ID,
      name: "Real Preview Draft",
      mimeType: "application/vnd.google-apps.document",
      version: "9",
      trashed: false,
    })),
    createAdapter: vi.fn(() => ({ marker: "adapter" })),
    bindDocument: vi.fn(async () => ({
      documentId: 4,
      bindingId: 5,
      created: true,
    })),
    observeDocument: vi.fn(async () => ({
      snapshotId: 6,
      created: true,
      fingerprint: {},
    })),
    queueJob: vi.fn(async () => ({ job: { id: 7 }, created: true })),
    retryJob: vi.fn(async () => ({
      id: 7,
      status: "queued",
      idempotencyKey: REQUEST_KEY,
      operation: "semantic_qc",
    })),
    getJobDetail: vi.fn(async () => ({
      job: {
        id: 7,
        status: "queued",
        idempotencyKey: REQUEST_KEY,
        operation: "semantic_qc",
      },
      attempts: [],
    })),
    ...overrides,
  } as any;
}
describe("IPE-054-D2A real AI QC candidate preparation", () => {
  it("prepares exactly one queued zero-attempt candidate and returns exact scope", async () => {
    const mocked = deps();
    const result = await prepareWorkspaceAiQcRealCandidate(
      {
        actorUserId: 10,
        workspaceId: 2,
        workspaceNovelId: 3,
        connectionId: 8,
        providerFileId: DOC_ID,
      },
      { env: disarmedEnv, deps: mocked }
    );

    expect(result).toMatchObject({
      workspaceId: 2,
      workspaceNovelId: 3,
      connectionId: 8,
      documentId: 4,
      bindingId: 5,
      snapshotId: 6,
      jobId: 7,
      requestKey: REQUEST_KEY,
      operation: "semantic_qc",
      created: true,
      resumed: false,
      attemptCount: 0,
    });
    expect(result.scope).toBe(
      `workspaceId=2,jobId=7,snapshotId=6,requestKey=${REQUEST_KEY}`
    );
    expect(mocked.retryJob).not.toHaveBeenCalled();
    expect(mocked.queueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "semantic_qc",
        promptVersion: "workspace-ai-qc-v1",
        modelPolicyVersion: "gemini-interactions-controlled-v1",
      })
    );
  });
  it("refuses candidate preparation unless Preview and all side-effect flags are false", async () => {
    await expect(
      prepareWorkspaceAiQcRealCandidate(
        {
          actorUserId: 10,
          workspaceId: 2,
          workspaceNovelId: 3,
          connectionId: 8,
          providerFileId: DOC_ID,
        },
        {
          env: { ...disarmedEnv, WORKSPACE_AI_QC_PROVIDER_ENABLED: "true" },
          deps: deps(),
        }
      )
    ).rejects.toMatchObject({ code: "PREVIEW_DISARM_REQUIRED" });
  });

  it("rejects non-positive identifiers before any provider read", async () => {
    const mocked = deps();
    await expect(
      prepareWorkspaceAiQcRealCandidate(
        {
          actorUserId: 10,
          workspaceId: 0,
          workspaceNovelId: 3,
          connectionId: 8,
          providerFileId: DOC_ID,
        },
        { env: disarmedEnv, deps: mocked }
      )
    ).rejects.toMatchObject({
      code: "CANDIDATE_INVALID",
    });
    expect(mocked.refreshAccessToken).not.toHaveBeenCalled();
  });

  it("re-queues an existing failed idempotent job instead of rejecting reused snapshot history", async () => {
    const mocked = deps({
      queueJob: vi.fn(async () => ({ job: { id: 7 }, created: false })),
      getJobDetail: vi.fn(async () => ({
        job: {
          id: 7,
          status: "failed",
          idempotencyKey: REQUEST_KEY,
          operation: "semantic_qc",
        },
        attempts: [{ id: 99 }, { id: 100 }],
      })),
    });
    const result = await prepareWorkspaceAiQcRealCandidate(
      {
        actorUserId: 10,
        workspaceId: 2,
        workspaceNovelId: 3,
        connectionId: 8,
        providerFileId: DOC_ID,
      },
      { env: disarmedEnv, deps: mocked }
    );
    expect(mocked.retryJob).toHaveBeenCalledWith({
      actorUserId: 10,
      workspaceId: 2,
      jobId: 7,
    });
    expect(result).toMatchObject({
      jobId: 7,
      created: false,
      resumed: true,
      attemptCount: 2,
    });
  });

  it("accepts an already queued reused job with prior attempts without retrying it again", async () => {
    const mocked = deps({
      queueJob: vi.fn(async () => ({ job: { id: 7 }, created: false })),
      getJobDetail: vi.fn(async () => ({
        job: {
          id: 7,
          status: "queued",
          idempotencyKey: REQUEST_KEY,
          operation: "semantic_qc",
        },
        attempts: [{ id: 99 }],
      })),
    });
    const result = await prepareWorkspaceAiQcRealCandidate(
      {
        actorUserId: 10,
        workspaceId: 2,
        workspaceNovelId: 3,
        connectionId: 8,
        providerFileId: DOC_ID,
      },
      { env: disarmedEnv, deps: mocked }
    );
    expect(mocked.retryJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      created: false,
      resumed: false,
      attemptCount: 1,
    });
  });

  it("fails closed when an existing idempotent job is not executable", async () => {
    const mocked = deps({
      queueJob: vi.fn(async () => ({ job: { id: 7 }, created: false })),
      getJobDetail: vi.fn(async () => ({
        job: {
          id: 7,
          status: "succeeded",
          idempotencyKey: REQUEST_KEY,
          operation: "semantic_qc",
        },
        attempts: [{ id: 99 }],
      })),
    });
    await expect(
      prepareWorkspaceAiQcRealCandidate(
        {
          actorUserId: 10,
          workspaceId: 2,
          workspaceNovelId: 3,
          connectionId: 8,
          providerFileId: DOC_ID,
        },
        { env: disarmedEnv, deps: mocked }
      )
    ).rejects.toMatchObject({ code: "CANDIDATE_CONFLICT" });
    expect(mocked.retryJob).not.toHaveBeenCalled();
  });
});
