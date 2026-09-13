import { describe, expect, it } from "vitest";
import { buildWorkspaceAiQcPreviewReadiness } from "./aiQc.previewReadiness";

const requestKey = "a".repeat(64);

function readyEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    WORKSPACE_AI_QC_RUNTIME_TARGET: "preview",
    WORKSPACE_AI_QC_PROVIDER_ENABLED: "",
    WORKSPACE_AI_QC_PROVIDER_API_URL: "https://ai.example.test/v1/chat/completions",
    WORKSPACE_AI_QC_PROVIDER_API_KEY: "synthetic-secret-never-print",
    WORKSPACE_AI_QC_PROVIDER_MODEL: "qc-model-v1",
    WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE:
      "https://ai.example.test/v1/chat/completions/{providerRequestId}",
    WORKSPACE_AI_QC_EXECUTION_ENABLED: "",
    R2_PRIVATE_ACCOUNT_ID: "test-account",
    R2_PRIVATE_ACCESS_KEY_ID: "test-access-key",
    R2_PRIVATE_SECRET_ACCESS_KEY: "synthetic-r2-secret-never-print",
    R2_PRIVATE_ENDPOINT: "https://test-account.r2.cloudflarestorage.com",
    R2_PRIVATE_BUCKET_NAME: "test-private-bucket",
    R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS: "900",
    ...overrides,
  };
}
describe("IPE-054-C Preview AI QC readiness", () => {
  it("recognizes a structurally ready but fully disarmed Preview configuration", () => {
    const report = buildWorkspaceAiQcPreviewReadiness(readyEnv());
    expect(report.runtimeTarget.ready).toBe(true);
    expect(report.provider).toMatchObject({ ready: true, enabled: false });
    expect(report.reconciliation.ready).toBe(true);
    expect(report.artifactStore.ready).toBe(true);
    expect(report.execution).toMatchObject({ ready: true, enabled: false });
    expect(report.readyForDisarmedPreview).toBe(true);
    expect(report.readyForControlledExecution).toBe(false);
    expect(JSON.stringify(report)).not.toContain("synthetic-secret-never-print");
    expect(JSON.stringify(report)).not.toContain("synthetic-r2-secret-never-print");
  });

  it("arms controlled execution only with both exact opt-ins and exact immutable scope", () => {
    const report = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_SCOPE:
        `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`,
      WORKSPACE_AI_QC_LEASE_SECONDS: "60",
      WORKSPACE_AI_QC_MAX_ATTEMPTS: "3",
    }));
    expect(report.readyForDisarmedPreview).toBe(false);
    expect(report.readyForControlledExecution).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("fails closed outside the exact Preview target even when every other control is armed", () => {
    const report = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      WORKSPACE_AI_QC_RUNTIME_TARGET: "production",
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_SCOPE:
        `workspaceId=7,jobId=11,snapshotId=13,requestKey=${requestKey}`,
    }));
    expect(report.runtimeTarget.ready).toBe(false);
    expect(report.runtimeTarget.invalid).toEqual(["WORKSPACE_AI_QC_RUNTIME_TARGET"]);
    expect(report.readyForControlledExecution).toBe(false);
  });

  it("blocks on missing reconciliation or malformed private-R2 configuration", () => {
    const missingReconcile = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE: "",
    }));
    expect(missingReconcile.reconciliation.missing).toEqual([
      "WORKSPACE_AI_QC_PROVIDER_RECONCILE_URL_TEMPLATE",
    ]);
    expect(missingReconcile.readyForDisarmedPreview).toBe(false);

    const badR2 = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      R2_PRIVATE_ENDPOINT: "http://test-account.r2.cloudflarestorage.com",
    }));
    expect(badR2.artifactStore.ready).toBe(false);
    expect(badR2.artifactStore.category).toBe("ENDPOINT_INVALID");
  });

  it("rejects malformed scope and insecure provider URLs before controlled execution", () => {
    const badScope = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      WORKSPACE_AI_QC_PROVIDER_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_ENABLED: "true",
      WORKSPACE_AI_QC_EXECUTION_SCOPE: "workspaceId=7,jobId=11,snapshotId=13,requestKey=nope",
    }));
    expect(badScope.execution.invalid).toContain("WORKSPACE_AI_QC_EXECUTION_SCOPE");
    expect(badScope.readyForControlledExecution).toBe(false);

    const insecure = buildWorkspaceAiQcPreviewReadiness(readyEnv({
      WORKSPACE_AI_QC_PROVIDER_API_URL: "http://ai.example.test/v1/chat/completions",
    }));
    expect(insecure.provider.invalid).toContain("WORKSPACE_AI_QC_PROVIDER_API_URL");
    expect(insecure.readyForDisarmedPreview).toBe(false);
  });
});
