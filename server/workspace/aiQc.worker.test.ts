import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseWorkspaceAiQcExecutionScope,
  resolveWorkspaceAiQcWorkerConfig,
  runScopedAiQcWorkerOnce,
  type WorkspaceAiQcWorkerServices,
} from "./aiQc.worker";
import type { WorkspaceAiQcProvider } from "./aiQc.service";

const requestKey = "a".repeat(64);
const scope = { workspaceId: 7, jobId: 11, snapshotId: 13, requestKey };
const docsAdapter = {
  getMetadata: vi.fn(),
  getNormalizedText: vi.fn(),
  revoke: vi.fn(),
};
const artifactStore = { putJson: vi.fn() };
const externalProvider: WorkspaceAiQcProvider = {
  mode: "external",
  execute: vi.fn(async () => ({})),
  reconcile: vi.fn(async () => null),
};

beforeEach(() => {
  vi.clearAllMocks();
});

function detail(overrides: Record<string, unknown> = {}) {
  return {
    job: {
      id: 11,
      workspaceId: 7,
      snapshotId: 13,
      operation: "novel_qc",
      promptVersion: "prompt-v1",
      modelPolicyVersion: "policy-v1",
      priority: 0,
      status: "queued",
      idempotencyKey: requestKey,
      version: 1,
      createdAt: new Date("2026-09-13T00:00:00Z"),
      ...overrides,
    },
    attempts: [],
    artifacts: [],
  } as any;
}

function services(jobDetail = detail()): WorkspaceAiQcWorkerServices {
  return {
    getJobDetail: vi.fn(async () => jobDetail) as any,
    claimJob: vi.fn(async () => ({
      jobId: 11,
      attempt: { id: 101, attemptNo: 1, leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-13T00:02:00Z"), status: "claimed" },
    })) as any,
    executeAttempt: vi.fn(async () => ({ objectKey: "workspace/ai-qc/7/jobs/11/a.json", contentSha256: "b".repeat(64), artifact: {} })) as any,
    recoverReceipt: vi.fn(async () => ({ recovered: true, providerRequestId: "receipt-1", attemptId: 102, artifact: {}, objectKey: "workspace/ai-qc/7/jobs/11/r.json", contentSha256: "c".repeat(64) })) as any,
  };
}

const baseInput = {
  actorUserId: 5,
  scope,
  leaseOwner: "worker-1",
  accessToken: "google-access-token-never-log",
  docsAdapter,
  artifactStore,
  provider: externalProvider,
  executionEnabled: true,
  leaseSeconds: 60,
  maxAttempts: 3,
  now: new Date("2026-09-13T00:01:00Z"),
};

describe("IPE-054-B scoped AI QC worker config", () => {
  it("parses only the exact four-field immutable job scope", () => {
    expect(parseWorkspaceAiQcExecutionScope(`workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`)).toEqual(scope);
    expect(() => parseWorkspaceAiQcExecutionScope(`workspaceId=7,jobId=11,snapshotId=13`)).toThrow(/exactly/);
    expect(() => parseWorkspaceAiQcExecutionScope(`workspaceId=7,jobId=11,snapshotId=13,requestKey=nope`)).toThrow(/SHA-256/);
    expect(() => parseWorkspaceAiQcExecutionScope(`workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey},extra=1`)).toThrow(/exactly/);
  });

  it("stays disabled unless exact true and bounds lease/attempt policy", () => {
    expect(resolveWorkspaceAiQcWorkerConfig({ enabled: "TRUE" })).toEqual({ enabled: false });
    const configured = resolveWorkspaceAiQcWorkerConfig({
      enabled: "true",
      scope: `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`,
      leaseSeconds: "90",
      maxAttempts: "4",
    });
    expect(configured).toEqual({ enabled: true, scope, leaseSeconds: 90, maxAttempts: 4 });
    expect(() => resolveWorkspaceAiQcWorkerConfig({ enabled: "true", scope: `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`, leaseSeconds: "301" })).toThrow(/LEASE_SECONDS/);
    expect(() => resolveWorkspaceAiQcWorkerConfig({ enabled: "true", scope: `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`, maxAttempts: "11" })).toThrow(/MAX_ATTEMPTS/);
  });
});

describe("IPE-054-B one-shot worker", () => {
  it("fails before DB/provider work when execution is disabled", async () => {
    const ops = services();
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, executionEnabled: false, services: ops }))
      .rejects.toMatchObject({ code: "EXECUTION_DISABLED" });
    expect(ops.getJobDetail).not.toHaveBeenCalled();
    expect(externalProvider.execute).not.toHaveBeenCalled();
  });

  it("requires reconciliation capability before any external provider execution", async () => {
    const ops = services();
    const provider: WorkspaceAiQcProvider = { mode: "external", execute: vi.fn() };
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, provider, services: ops }))
      .rejects.toMatchObject({ code: "PROVIDER_RECONCILIATION_REQUIRED" });
    expect(ops.getJobDetail).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("fails closed on exact-scope mismatch before claim or provider execution", async () => {
    const ops = services(detail({ snapshotId: 99 }));
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, services: ops }))
      .rejects.toMatchObject({ code: "EXECUTION_SCOPE_MISMATCH" });
    expect(ops.claimJob).not.toHaveBeenCalled();
    expect(ops.executeAttempt).not.toHaveBeenCalled();
  });

  it("claims exactly one queued job then delegates provider-neutral execution", async () => {
    const ops = services();
    const events: any[] = [];
    const result = await runScopedAiQcWorkerOnce({ ...baseInput, services: ops, observer: event => events.push(event) });
    expect(result).toMatchObject({ action: "execute", attemptId: 101 });
    expect(ops.claimJob).toHaveBeenCalledTimes(1);
    expect(ops.executeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 7,
      jobId: 11,
      attemptId: 101,
      leaseOwner: "worker-1",
      provider: externalProvider,
      allowExternalProvider: true,
    }));
    expect(ops.recoverReceipt).not.toHaveBeenCalled();
    expect(events.map(event => event.type)).toEqual(["scope_verified", "claim_acquired", "provider_execution_started", "completed"]);
    expect(JSON.stringify(events)).not.toContain(baseInput.accessToken);
  });

  it("routes receipt-backed incomplete work to reconciliation without provider execute/claim", async () => {
    const jobDetail = detail({ status: "failed" });
    jobDetail.attempts = [{
      id: 77,
      attemptNo: 1,
      status: "failed",
      leaseExpiresAt: new Date("2026-09-13T00:00:00Z"),
      providerRequestId: "receipt-1",
      errorClass: "ARTIFACT_STORE_FAILED",
    }] as any;
    const ops = services(jobDetail);
    const result = await runScopedAiQcWorkerOnce({ ...baseInput, services: ops });
    expect(result).toMatchObject({ action: "recover", recovered: true, providerRequestId: "receipt-1" });
    expect(ops.recoverReceipt).toHaveBeenCalledTimes(1);
    expect(ops.claimJob).not.toHaveBeenCalled();
    expect(ops.executeAttempt).not.toHaveBeenCalled();
  });

  it("enforces the attempt ceiling before creating another attempt", async () => {
    const jobDetail = detail();
    jobDetail.attempts = [1, 2, 3].map((attemptNo) => ({
      id: 70 + attemptNo,
      attemptNo,
      status: "failed",
      leaseExpiresAt: new Date("2026-09-13T00:00:00Z"),
      providerRequestId: null,
      errorClass: "SYNTHETIC_FAILURE",
    })) as any;
    const ops = services(jobDetail);
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, services: ops, maxAttempts: 3 }))
      .rejects.toMatchObject({ code: "ATTEMPT_LIMIT_REACHED" });
    expect(ops.claimJob).not.toHaveBeenCalled();
  });

  it("requires explicit admin retry for failed jobs with no receipt", async () => {
    const jobDetail = detail({ status: "failed" });
    jobDetail.attempts = [{
      id: 77,
      attemptNo: 1,
      status: "failed",
      leaseExpiresAt: new Date("2026-09-13T00:00:00Z"),
      providerRequestId: null,
      errorClass: "PROVIDER_REQUEST_FAILED",
    }] as any;
    const ops = services(jobDetail);
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, services: ops }))
      .rejects.toMatchObject({ code: "JOB_RETRY_REQUIRED" });
    expect(ops.claimJob).not.toHaveBeenCalled();
  });

  it("no-ops terminal success without another claim or provider call", async () => {
    const jobDetail = detail({ status: "succeeded" });
    jobDetail.attempts = [{
      id: 77,
      attemptNo: 1,
      status: "succeeded",
      leaseExpiresAt: new Date("2026-09-13T00:00:00Z"),
      providerRequestId: "receipt-1",
      errorClass: null,
    }] as any;
    jobDetail.artifacts = [{ attemptId: 77, artifactType: "qc_findings_v1", contentObjectKey: "a", contentSha256: "b".repeat(64) }] as any;
    const ops = services(jobDetail);
    await expect(runScopedAiQcWorkerOnce({ ...baseInput, services: ops })).resolves.toMatchObject({ action: "noop", state: "succeeded" });
    expect(ops.claimJob).not.toHaveBeenCalled();
    expect(ops.executeAttempt).not.toHaveBeenCalled();
  });

  it("resolves read-only Docs runtime lazily before claim and passes it only to execution", async () => {
    const ops = services();
    const resolveDocsRuntime = vi.fn(async () => ({
      accessToken: "lazy-access-token-never-log",
      docsAdapter,
    }));
    const { accessToken: _accessToken, docsAdapter: _docsAdapter, ...withoutDocs } = baseInput;
    const result = await runScopedAiQcWorkerOnce({
      ...withoutDocs,
      resolveDocsRuntime,
      services: ops,
    });
    expect(result).toMatchObject({ action: "execute", attemptId: 101 });
    expect(resolveDocsRuntime).toHaveBeenCalledTimes(1);
    expect(ops.claimJob).toHaveBeenCalledTimes(1);
    expect(ops.executeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "lazy-access-token-never-log",
      docsAdapter,
    }));
  });

  it("fails before claim when Google Docs runtime resolution fails", async () => {
    const ops = services();
    const { accessToken: _accessToken, docsAdapter: _docsAdapter, ...withoutDocs } = baseInput;
    const resolveDocsRuntime = vi.fn(async () => {
      throw Object.assign(new Error("refresh failed"), { code: "GOOGLE_TOKEN_EXCHANGE_FAILED" });
    });
    await expect(runScopedAiQcWorkerOnce({ ...withoutDocs, resolveDocsRuntime, services: ops }))
      .rejects.toMatchObject({ code: "GOOGLE_TOKEN_EXCHANGE_FAILED" });
    expect(ops.claimJob).not.toHaveBeenCalled();
    expect(ops.executeAttempt).not.toHaveBeenCalled();
  });


  it("does receipt recovery without resolving Google Docs or sending provider execute", async () => {
    const jobDetail = detail({ status: "failed" });
    jobDetail.attempts = [{ id: 77, attemptNo: 1, status: "failed", leaseExpiresAt: new Date("2026-09-13T00:00:00Z"), providerRequestId: "receipt-1", errorClass: "ARTIFACT_STORE_FAILED" }] as any;
    const ops = services(jobDetail);
    const resolveDocsRuntime = vi.fn(async () => { throw new Error("must not run"); });
    const { accessToken: _accessToken, docsAdapter: _docsAdapter, ...withoutDocs } = baseInput;
    const result = await runScopedAiQcWorkerOnce({ ...withoutDocs, resolveDocsRuntime, services: ops });
    expect(result).toMatchObject({ action: "recover", providerRequestId: "receipt-1" });
    expect(resolveDocsRuntime).not.toHaveBeenCalled();
    expect(ops.claimJob).not.toHaveBeenCalled();
    expect(ops.executeAttempt).not.toHaveBeenCalled();
    expect(externalProvider.execute).not.toHaveBeenCalled();
  });

});